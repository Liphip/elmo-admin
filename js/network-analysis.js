'use strict';

// Pure analysis logic for the Network view (no DOM access).
// Element IoT attaches per-gateway reception data ("gateway stats") to packets. The exact
// JSON shape depends on the driver and changed with Element 4.4.0 (old + new structure are
// both emitted until end of 2026), so extraction is deliberately tolerant.
const NetAnalysis = (() => {
  // Demodulation SNR floor per LoRa spreading factor (dB). Link margin = SNR - floor.
  const SF_SNR_FLOOR = { 7: -7.5, 8: -10, 9: -12.5, 10: -15, 11: -17.5, 12: -20 };

  const GW_ID_KEYS  = ['gateway_id', 'gw_id', 'gateway_eui', 'gw_eui', 'gweui', 'gatewayId', 'gateway.gateway_id', 'gateway.eui'];
  const GW_NAME_KEYS = ['gateway_name', 'name', 'gateway.name'];
  const RSSI_KEYS   = ['rssi', 'rssic', 'rssis', 'signal_rssi', 'gw_rssi'];
  const SNR_KEYS    = ['snr', 'lsnr', 'signal_snr', 'gw_snr'];
  const LAT_KEYS    = ['latitude', 'lat', 'location.latitude', 'location.lat', 'gateway.latitude', 'gateway.lat', 'gateway.location.latitude'];
  const LNG_KEYS    = ['longitude', 'lng', 'lon', 'location.longitude', 'location.lng', 'location.lon', 'gateway.longitude', 'gateway.lng', 'gateway.location.longitude'];
  const SF_KEYS     = ['sf', 'spreading_factor', 'lora_sf', 'region_meta.spreadingfactor', 'lora.sf', 'lora.spreading_factor', 'modulation.spreading_factor'];
  const DR_KEYS     = ['data_rate', 'datarate', 'datr', 'dr', 'lora.data_rate'];

  const num = v => {
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  function get(obj, path) {
    return path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), obj);
  }

  function pick(obj, keys) {
    for (const k of keys) {
      const v = get(obj, k);
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  }

  function parseJsonish(v) {
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch { return undefined; }
  }

  // Normalizes a gateway identifier. EUI-like values (hex with optional separators) become
  // upper-case hex without separators so "b8-27-eb-ff-fe-11-22-33" matches "B827EBFFFE112233".
  function normalizeGwId(v) {
    if (v == null || typeof v === 'object') return null;
    const s = String(v).trim();
    if (!s) return null;
    const compact = s.replace(/[\s:.-]/g, '');
    // 48-bit IDs (e.g. "7076FF05004E") are shown by ELEMENT LNS as zero-padded 64-bit EUIs.
    if (/^[0-9a-fA-F]{12}$/.test(compact)) return compact.toUpperCase().padStart(16, '0');
    if (/^[0-9a-fA-F]{13,16}$/.test(compact)) return compact.toUpperCase().padStart(16, '0');
    return s.toUpperCase();
  }

  // ELEMENT LNS meta.gateway_stats[] only carries router_id (number) and router_id_hex
  // (the EUI string, hex-encoded as ASCII: "3030…3445" -> "00007076FF05004E").
  function routerIdFromEntry(e) {
    const hex = e?.router_id_hex;
    if (typeof hex === 'string' && /^([0-9a-fA-F]{2})+$/.test(hex)) {
      let ascii = '';
      for (let k = 0; k < hex.length; k += 2) ascii += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16));
      if (/^[0-9a-fA-F]{12,16}$/.test(ascii)) return ascii;
      if (hex.length === 16) return hex;
    }
    const n = e?.router_id;
    if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0) return n.toString(16);
    if (typeof n === 'string' && /^\d+$/.test(n)) { try { return BigInt(n).toString(16); } catch { /* ignore */ } }
    return null;
  }

  const isEuiLike = id => /^[0-9A-F]{16}$/.test(id || '');

  function lngLatValid(lat, lng) {
    return lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
  }

  function deviceLatLng(device) {
    const c = device?.location?.coordinates;
    if (!Array.isArray(c) || c.length < 2) return null;
    const lng = num(c[0]), lat = num(c[1]);
    return lngLatValid(lat, lng) ? [lat, lng] : null;
  }

  function packetMeta(p) {
    const m = parseJsonish(p?.meta);
    return m && typeof m === 'object' ? m : {};
  }

  function gatewayCandidates(p) {
    const m = packetMeta(p);
    const lists = [p?.gateway_stats, p?.gateways, m.gateway_stats, m.gateways, m.gws, m.gateway ? [m.gateway] : null];
    const out = [];
    lists.forEach(l => {
      const v = parseJsonish(l);
      if (Array.isArray(v)) out.push(...v);
      else if (v && typeof v === 'object') out.push(...Object.entries(v).map(([k, e]) => (e && typeof e === 'object' ? { gateway_id: k, ...e } : null)));
    });
    return out.filter(e => e && typeof e === 'object');
  }

  // Returns [{ id, name, rssi, snr, lat, lng }] – one entry per distinct gateway.
  function extractGateways(p) {
    const byId = new Map();
    gatewayCandidates(p).forEach(e => {
      const id = normalizeGwId(pick(e, GW_ID_KEYS) ?? routerIdFromEntry(e));
      if (!id) return;
      const gd = e.gateway_device && typeof e.gateway_device === 'object' ? e.gateway_device : null;
      const coords = get(e, 'location.coordinates') || get(e, 'gateway.location.coordinates') || gd?.location?.coordinates;
      let lat = num(pick(e, LAT_KEYS)), lng = num(pick(e, LNG_KEYS));
      if ((lat == null || lng == null) && Array.isArray(coords)) { lng = num(coords[0]); lat = num(coords[1]); }
      const entry = {
        id,
        name: pick(e, GW_NAME_KEYS) ?? gd?.name ?? null,
        deviceId: gd?.id ?? (typeof e.device_id === 'string' ? e.device_id : null),
        rssi: num(pick(e, RSSI_KEYS)),
        snr: num(pick(e, SNR_KEYS)),
        lat: lngLatValid(lat, lng) ? lat : null,
        lng: lngLatValid(lat, lng) ? lng : null,
      };
      const prev = byId.get(id);
      if (!prev) { byId.set(id, entry); return; }
      // Same gateway reported twice (old + new structure): merge, keep the best values.
      for (const k of ['name', 'lat', 'lng', 'deviceId']) if (prev[k] == null) prev[k] = entry[k];
      if (entry.rssi != null && (prev.rssi == null || entry.rssi > prev.rssi)) prev.rssi = entry.rssi;
      if (entry.snr != null && (prev.snr == null || entry.snr > prev.snr)) prev.snr = entry.snr;
    });
    return [...byId.values()];
  }

  function sfFromValue(v, allowNumber) {
    if (typeof v === 'number') return allowNumber && v >= 6 && v <= 12 ? v : null;
    if (typeof v === 'string') {
      const m = v.match(/SF\s*(\d{1,2})/i);
      if (m) return num(m[1]);
      if (allowNumber && /^\d{1,2}$/.test(v.trim())) { const n = Number(v); return n >= 6 && n <= 12 ? n : null; }
    }
    return null;
  }

  // Tries every key (a DR index in "data_rate" must not hide "datr": "SF7BW125").
  function sfFrom(obj) {
    for (const k of SF_KEYS) { const v = sfFromValue(get(obj, k), true); if (v != null) return v; }
    for (const k of DR_KEYS) { const v = sfFromValue(get(obj, k), false); if (v != null) return v; }
    return null;
  }

  function extractSf(p) {
    const sf = sfFrom(packetMeta(p));
    if (sf != null) return sf;
    for (const g of gatewayCandidates(p)) {
      const v = sfFrom(g);
      if (v != null) return v;
    }
    return null;
  }

  // Reduces a packet to what the analysis needs (keeps memory low for tens of thousands of
  // packets and avoids re-parsing when devices are re-rated).
  function compactPacket(p) {
    return { transceived_at: p.transceived_at || p.inserted_at || null, _gws: extractGateways(p), _sf: extractSf(p) };
  }

  // ELEMENT device stats: packet_interval = { months, days, secs, microsecs } -> seconds
  function packetIntervalSecs(device) {
    const iv = device?.stats?.packet_interval;
    if (!iv || typeof iv !== 'object') return null;
    const secs = (num(iv.months) || 0) * 30 * 86400 + (num(iv.days) || 0) * 86400 + (num(iv.secs) || 0) + (num(iv.microsecs) || 0) / 1e6;
    return secs > 0 ? secs : null;
  }

  function linkMargin(snr, sf) {
    if (snr == null || sf == null) return null;
    const floor = SF_SNR_FLOOR[Math.round(sf)];
    return floor == null ? null : snr - floor;
  }

  // Collects every gateway identifier a gateway device can be referenced by:
  // EUI-like interface options (Element LNS / GMS interfaces) plus EUIs embedded in slug/name.
  // Gateways in ELEMENT are devices with a gateway-management (GMS) interface whose opts carry
  // "gateway_id" (plus secret/use_probe). ELEMENT does not return a device "type" on every
  // instance, so this interface is the reliable marker.
  const GW_OPT_KEYS = ['gateway_id', 'gateway_eui', 'gw_eui'];

  function gatewayIdsFromDevice(device) {
    const ids = new Set();
    (device?.interfaces || []).forEach(i => {
      GW_OPT_KEYS.forEach(k => {
        const v = i?.opts?.[k];
        if (typeof v !== 'string') return;
        const id = normalizeGwId(v);
        if (isEuiLike(id)) ids.add(id);
      });
    });
    // Fallback for devices typed "gateway" without such an interface: an EUI in slug or name.
    // Never used when the interface provides the ID – slugs are often copied and wrong.
    if (!ids.size && device?.type === 'gateway') {
      [device?.name, device?.slug].forEach(s => {
        const m = String(s || '').match(/[0-9a-fA-F]{16}/);
        if (m && !ids.size) ids.add(m[0].toUpperCase());
      });
    }
    return [...ids];
  }

  // ELEMENT LNS interfaces: LoRaWAN device EUI plus LNS-specific options (seen on real instances:
  // check_fcnt, class_c, rx2_dr, rx_delay, gw_whitelist, lns_session_context, net_id).
  const LNS_OPT_KEYS = ['check_fcnt', 'class_c', 'rx2_dr', 'rx_delay', 'gw_whitelist', 'lns_session_context', 'net_id'];
  function isLnsInterface(i) {
    const o = i?.opts || {};
    return typeof o.device_eui === 'string' && LNS_OPT_KEYS.some(k => k in o);
  }

  function isGatewayDevice(device) {
    if (device?.type === 'gateway') return true;
    return (device?.interfaces || []).some(i => GW_OPT_KEYS.some(k => typeof i?.opts?.[k] === 'string' && i.opts[k]));
  }

  // Last packet-forwarder / probe ping of a gateway device (GMS statistics).
  function gatewayLastPing(device) {
    const s = device?.stats || {};
    return s.last_packet_forwarder_ping || s.last_probe_ping || null;
  }

  function haversine(a, b) {
    const R = 6371000, rad = x => x * Math.PI / 180;
    const dLat = rad(b[0] - a[0]), dLng = rad(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function percentile(values, p) {
    if (!values.length) return null;
    const s = [...values].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
  }

  const acc = () => ({ sum: 0, n: 0, max: null, min: null });
  function add(a, v) {
    if (v == null) return;
    a.sum += v; a.n++;
    a.max = a.max == null ? v : Math.max(a.max, v);
    a.min = a.min == null ? v : Math.min(a.min, v);
  }
  const avg = a => (a.n ? a.sum / a.n : null);

  function isWeak(link, th) {
    if (!link) return false;
    if (link.rssiAvg != null && link.rssiAvg < th.rssiWeak) return true;
    if (link.margin != null) return link.margin < th.marginWeak;
    return link.snrAvg != null && link.snrAvg < th.snrWeak;
  }

  function linkScore(link) {
    if (link.margin != null) return link.margin;
    if (link.snrAvg != null) return link.snrAvg;
    return link.rssiAvg != null ? (link.rssiAvg + 120) / 2 : -Infinity;
  }

  // Link quality class used for colouring links on the map.
  function linkQuality(link, th) {
    if (isWeak(link, th)) return 'weak';
    const m = link.margin != null ? link.margin : link.snrAvg;
    if (m != null && m < th.marginWeak + 5) return 'ok';
    if (m == null && link.rssiAvg != null && link.rssiAvg < th.rssiWeak + 10) return 'ok';
    return 'good';
  }

  /**
   * @param {object} input
   * @param {object[]} input.devices          sensor/generic devices to analyse
   * @param {Map<string,object[]>} input.packetsByDevice  device id -> packets in window
   * @param {object[]} input.gatewayDevices   devices of type "gateway"
   * @param {object} [input.thresholds]
   */
  const tsMs = v => {
    if (!v) return null;
    const str = String(v);
    const t = Date.parse(/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(str) ? `${str}Z` : str);
    return Number.isFinite(t) ? t : null;
  };

  // ELEMENT keeps rolling statistics per device (device.stats): last uplink, averages of RSSI,
  // SNR, SF and receiving gateways. Used for devices whose packets were not loaded.
  function statsSummary(device) {
    const s = device?.stats;
    if (!s) return null;
    const out = {
      lastSeen: s.transceived_at || null,
      rssiAvg: num(s.avg_rssi), snrAvg: num(s.avg_snr), sfAvg: num(s.avg_sf), gwAvg: num(s.avg_gw_count),
      missed: num(s.missed_up_frames), nominal: typeof s.nominally_sending === 'boolean' ? s.nominally_sending : null,
    };
    out.margin = linkMargin(out.snrAvg, out.sfAvg);
    return out;
  }

  /**
   * @param {object} input
   * @param {object[]} input.devices           devices to analyse
   * @param {Map<string,object[]>} input.packetsByDevice  device id -> packets; devices without an
   *        entry are rated from ELEMENT's device statistics instead (no gateway links then)
   * @param {object[]} input.gatewayDevices    gateway devices (GMS interface with gateway_id)
   * @param {string} [input.windowStart]       ISO start of the analysed time window
   * @param {number} [input.onlineWindowMs]    max age of the last packet-forwarder ping for "online"
   */
  function analyze({ devices, packetsByDevice, gatewayDevices = [], thresholds = {}, windowStart = null, onlineWindowMs = 3600e3, now = Date.now() }) {
    const th = { rssiWeak: -118, marginWeak: 5, snrWeak: -5, ...thresholds };
    const windowMs = tsMs(windowStart);
    const gwIndex = new Map();
    gatewayDevices.forEach(d => gatewayIdsFromDevice(d).forEach(id => { if (!gwIndex.has(id)) gwIndex.set(id, d); }));

    const gateways = new Map();
    const newGw = (key, device, ids) => ({
      key, ids, device: device || null,
      name: device ? (device.name || device.slug) : null,
      latlng: device ? deviceLatLng(device) : null,
      packets: 0, devices: new Map(), rssi: acc(), snr: acc(),
      lastSeen: null, soleFor: 0, range: null, inElement: !!device,
    });
    const gwByDeviceId = new Map();
    gatewayDevices.forEach(d => {
      const ids = gatewayIdsFromDevice(d);
      const key = ids[0] || `dev:${d.id}`;
      if (gateways.has(key)) return;
      const gw = newGw(key, d, ids);
      gateways.set(key, gw);
      gwByDeviceId.set(d.id, gw);
    });
    const ensureGw = (id, seen) => {
      const dev = gwIndex.get(id);
      let gw = (dev && gwByDeviceId.get(dev.id)) || gateways.get(id);
      if (!gw) { gw = newGw(id, null, [id]); gateways.set(id, gw); }
      if (!gw.name && seen.name) gw.name = String(seen.name);
      if (!gw.latlng && seen.lat != null) gw.latlng = [seen.lat, seen.lng];
      return gw;
    };

    const deviceStats = devices.map(device => {
      const fromPackets = packetsByDevice.has(device.id);
      const packets = packetsByDevice.get(device.id) || [];
      const st = {
        device, id: device.id, name: device.name || device.slug, latlng: deviceLatLng(device),
        packets: packets.length, withGwInfo: 0, gwPerPacket: acc(), sf: acc(),
        links: new Map(), lastSeen: null, best: null, status: 'silent',
        source: fromPackets ? 'packets' : 'stats', elementStats: statsSummary(device),
      };
      packets.forEach(p => {
        const t = p.transceived_at || p.inserted_at || null;
        if (t && (!st.lastSeen || t > st.lastSeen)) st.lastSeen = t;
        const sf = p._sf !== undefined ? p._sf : extractSf(p);
        add(st.sf, sf);
        const gws = p._gws || extractGateways(p);
        if (!gws.length) return;
        st.withGwInfo++;
        add(st.gwPerPacket, gws.length);
        gws.forEach(g => {
          const gw = ensureGw(g.id, g);
          let link = st.links.get(gw.key);
          if (!link) { link = { gw, count: 0, rssi: acc(), snr: acc(), sf: acc(), lastSeen: null }; st.links.set(gw.key, link); }
          link.count++;
          add(link.rssi, g.rssi); add(link.snr, g.snr); add(link.sf, sf);
          if (t && (!link.lastSeen || t > link.lastSeen)) link.lastSeen = t;
          gw.packets++;
          gw.devices.set(device.id, (gw.devices.get(device.id) || 0) + 1);
          add(gw.rssi, g.rssi); add(gw.snr, g.snr);
          if (t && (!gw.lastSeen || t > gw.lastSeen)) gw.lastSeen = t;
        });
      });
      st.links.forEach(link => {
        link.rssiAvg = avg(link.rssi); link.snrAvg = avg(link.snr);
        link.rssiBest = link.rssi.max; link.snrBest = link.snr.max;
        link.sfAvg = avg(link.sf);
        link.margin = linkMargin(link.snrAvg, link.sfAvg);
        link.distance = st.latlng && link.gw.latlng ? haversine(st.latlng, link.gw.latlng) : null;
        link.quality = linkQuality(link, th);
        if (!st.best || linkScore(link) > linkScore(st.best)) st.best = link;
      });
      st.sfAvg = avg(st.sf);
      st.gwAvg = avg(st.gwPerPacket);
      st.gwCount = st.links.size;
      const es = st.elementStats;
      if (st.source === 'stats') {
        // Rated from ELEMENT statistics: averages over all receptions, no per-gateway detail.
        st.lastSeen = es?.lastSeen || null;
        st.sfAvg = es?.sfAvg ?? null; st.gwAvg = es?.gwAvg ?? null;
        const recent = st.lastSeen && (windowMs == null || tsMs(st.lastSeen) >= windowMs);
        st.summary = es && es.rssiAvg != null ? { rssiAvg: es.rssiAvg, snrAvg: es.snrAvg, margin: es.margin } : null;
        if (!recent) st.status = 'silent';
        else if (!st.summary) st.status = 'unknown';
        else if (isWeak(st.summary, th)) st.status = 'weak';
        else if (st.gwAvg != null && st.gwAvg < 1.5) st.status = 'single';
        else st.status = 'good';
        return st;
      }
      st.summary = st.best ? { rssiAvg: st.best.rssiAvg, snrAvg: st.best.snrAvg, margin: st.best.margin } : null;
      if (!st.packets) st.status = 'silent';
      else if (!st.gwCount) st.status = 'unknown';
      else if (isWeak(st.best, th)) st.status = 'weak';
      else if (st.gwCount === 1) st.status = 'single';
      else st.status = 'good';
      return st;
    });

    // Gateway aggregates: sole-gateway dependencies and observed range.
    const distancesByGw = new Map();
    deviceStats.forEach(st => {
      if (st.gwCount === 1) st.links.values().next().value.gw.soleFor++;
      st.links.forEach(link => {
        if (link.distance == null) return;
        if (!distancesByGw.has(link.gw.key)) distancesByGw.set(link.gw.key, []);
        distancesByGw.get(link.gw.key).push(link.distance);
      });
    });
    gateways.forEach(gw => {
      gw.deviceCount = gw.devices.size;
      gw.rssiAvg = avg(gw.rssi); gw.snrAvg = avg(gw.snr);
      const d = distancesByGw.get(gw.key) || [];
      gw.range = d.length >= 3 ? percentile(d, 0.9) : (d.length ? Math.max(...d) : null);
      gw.maxDistance = d.length ? Math.max(...d) : null;
      gw.lastPing = gw.device ? gatewayLastPing(gw.device) : null;
      const pingMs = tsMs(gw.lastPing);
      gw.online = pingMs == null ? null : now - pingMs <= onlineWindowMs;
      if (!gw.inElement) gw.status = 'external';
      else if (gw.online === false) gw.status = 'offline';
      else if (gw.packets) gw.status = 'receiving';
      else gw.status = 'idle';
    });

    const gwList = [...gateways.values()];
    const located = gwList.filter(g => g.latlng);
    deviceStats.forEach(st => {
      st.nearestGw = null; st.nearestGwDistance = null;
      if (!st.latlng) return;
      located.forEach(g => {
        const dist = haversine(st.latlng, g.latlng);
        if (st.nearestGwDistance == null || dist < st.nearestGwDistance) { st.nearestGwDistance = dist; st.nearestGw = g; }
      });
    });

    const counts = { good: 0, single: 0, weak: 0, silent: 0, unknown: 0 };
    deviceStats.forEach(st => { counts[st.status]++; });
    const withPk = deviceStats.filter(s => s.source === 'packets' && s.packets > 0);
    const noGwInfo = withPk.length > 0 && withPk.every(s => s.withGwInfo === 0);

    return {
      thresholds: th,
      devices: deviceStats,
      gateways: gwList,
      summary: {
        devices: deviceStats.length,
        located: deviceStats.filter(s => s.latlng).length,
        gateways: gwList.length,
        gatewaysActive: gwList.filter(g => g.packets > 0).length,
        gatewaysIdle: gwList.filter(g => g.status === 'idle').length,
        gatewaysOffline: gwList.filter(g => g.status === 'offline').length,
        fromStats: deviceStats.filter(d => d.source === 'stats').length,
        gatewaysForeign: gwList.filter(g => !g.inElement).length,
        packets: deviceStats.reduce((s, d) => s + d.packets, 0),
        counts,
        noGwInfo,
      },
    };
  }

  // ---------- Reception estimate ----------
  // Log-distance path-loss model RSSI(d) = r1k - 10·n·log10(d / 1 km), fitted to the links that were
  // actually measured. A global exponent n is fitted over all links; each gateway gets its own
  // intercept (antenna height/placement) when it has enough samples, and its own exponent when its
  // samples span a wide enough distance range.
  const DEFAULT_MODEL = { r1k: -105, n: 3 };
  const N_MIN = 2, N_MAX = 5, MIN_DIST = 50;

  function regress(points) {
    const k = points.length;
    if (k < 2) return null;
    const mx = points.reduce((a, p) => a + p[0], 0) / k, my = points.reduce((a, p) => a + p[1], 0) / k;
    let sxx = 0, sxy = 0;
    points.forEach(([x, y]) => { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); });
    return { mx, my, sxx, slope: sxx > 0 ? sxy / sxx : null };
  }

  function fitModel(points, fallback) {
    const r = regress(points);
    if (!r) return points.length === 1 ? { r1k: points[0][1] + 10 * fallback.n * points[0][0], n: fallback.n, samples: 1, fitted: 'intercept' } : { ...fallback, samples: 0, fitted: 'default' };
    let n = fallback.n, fitted = 'intercept';
    // A slope is only trustworthy when the samples span at least half a decade of distance.
    const spread = Math.sqrt(r.sxx / points.length);
    if (r.slope != null && points.length >= 6 && spread >= 0.15) { n = Math.min(N_MAX, Math.max(N_MIN, -r.slope / 10)); fitted = 'full'; }
    return { r1k: r.my + 10 * n * r.mx, n, samples: points.length, fitted };
  }

  function fitPathLoss(result) {
    const all = [], byGw = new Map();
    result.devices.forEach(st => st.links.forEach(l => {
      if (l.distance == null || l.rssiAvg == null) return;
      const pt = [Math.log10(Math.max(l.distance, MIN_DIST) / 1000), l.rssiAvg];
      all.push(pt);
      if (!byGw.has(l.gw.key)) byGw.set(l.gw.key, []);
      byGw.get(l.gw.key).push(pt);
    }));
    // Global exponent from within-gateway variation only (fixed effects), so gateways with
    // different antenna heights do not distort the distance dependency.
    const centered = [];
    byGw.forEach(pts => {
      if (pts.length < 2) return;
      const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length, my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
      pts.forEach(([x, y]) => centered.push([x - mx, y - my]));
    });
    let global = { ...DEFAULT_MODEL, samples: all.length, fitted: 'default' };
    const fe = regress(centered);
    if (fe && fe.slope != null && centered.length >= 6 && Math.sqrt(fe.sxx / centered.length) >= 0.1) {
      const nG = Math.min(N_MAX, Math.max(N_MIN, -fe.slope / 10));
      const r1k = all.reduce((a, [x, y]) => a + y + 10 * nG * x, 0) / all.length;
      global = { r1k, n: nG, samples: all.length, fitted: 'full' };
    } else if (all.length) {
      global = { r1k: all.reduce((a, [x, y]) => a + y + 10 * DEFAULT_MODEL.n * x, 0) / all.length, n: DEFAULT_MODEL.n, samples: all.length, fitted: 'intercept' };
    }
    const perGw = new Map();
    byGw.forEach((pts, key) => perGw.set(key, fitModel(pts, global)));
    // Residual spread = how far real links scatter around the model (shadowing by buildings/terrain).
    let ss = 0, k = 0;
    byGw.forEach((pts, key) => { const m = perGw.get(key); pts.forEach(([x, y]) => { ss += (y - (m.r1k - 10 * m.n * x)) ** 2; k++; }); });
    global.residual = k > 2 ? Math.sqrt(ss / (k - 2)) : null;
    return { global, perGw };
  }

  const predictRssi = (m, d) => m.r1k - 10 * m.n * Math.log10(Math.max(d, MIN_DIST) / 1000);

  /**
   * Rates a regular grid over the analysed area. Measured device evidence overrides the model:
   * a cell with located devices is rated from those devices; all other cells from the prediction.
   * Classes: covered (≥2 gateways), single (1 gateway), marginal (best link within the fade
   * margin of the weak threshold), none (no reception expected / observed).
   */
  // Distance from the nearest gateway to a lat/lng rectangle (0 when inside).
  function rectDistance([[s, w], [n, e]], gws) {
    let mn = Infinity;
    gws.forEach(g => {
      const p = [Math.min(Math.max(g.latlng[0], s), n), Math.min(Math.max(g.latlng[1], w), e)];
      mn = Math.min(mn, haversine(p, g.latlng));
    });
    return mn;
  }

  function estimateCoverage(result, opts = {}) {
    const th = result.thresholds;
    const fade = opts.fadeMargin ?? 8;
    const maxCells = opts.maxCells ?? 60000;
    let cellMeters = opts.cellMeters ?? 250;
    const covered = th.rssiWeak + fade;
    // Receiving gateways only; gateways that are offline right now are left out so outages show up.
    const gws = result.gateways.filter(g => g.latlng && g.packets > 0 && g.status !== 'offline');
    const offlineExcluded = result.gateways.filter(g => g.latlng && g.packets > 0 && g.status === 'offline');
    const devs = result.devices.filter(d => d.latlng);
    const model = fitPathLoss(result);
    const base = { cellMeters, cells: [], regions: [], model, gateways: gws.length, offlineExcluded, thresholdCovered: covered, thresholdNone: th.rssiWeak };
    const anchor = devs.length ? devs.map(d => d.latlng) : gws.map(g => g.latlng);
    if (!gws.length || (!anchor.length && !opts.bounds)) return base;

    // Area = explicit bounds [[s, w], [n, e]] or the bounding box of located devices (or gateways) plus padding.
    let s, n, w, e;
    if (opts.bounds) [[s, w], [n, e]] = opts.bounds;
    else {
      s = Math.min(...anchor.map(p => p[0])); n = Math.max(...anchor.map(p => p[0]));
      w = Math.min(...anchor.map(p => p[1])); e = Math.max(...anchor.map(p => p[1]));
    }
    const lat0 = (s + n) / 2, cos0 = Math.max(Math.cos(lat0 * Math.PI / 180), 0.01);
    const padM = opts.bounds ? 0 : (opts.padMeters ?? 1000);
    s -= padM / 111320; n += padM / 111320; w -= padM / (111320 * cos0); e += padM / (111320 * cos0);
    const hM = (n - s) * 111320, wM = (e - w) * 111320 * cos0;
    if ((hM / cellMeters) * (wM / cellMeters) > maxCells) {
      const nice = [100, 250, 500, 1000, 2000, 5000, 10000];
      const need = Math.sqrt(hM * wM / maxCells);
      cellMeters = nice.find(v => v >= need) || Math.ceil(need / 1000) * 1000;
    }
    const dLat = cellMeters / 111320, dLng = cellMeters / (111320 * cos0);
    const i0 = Math.floor(s / dLat), i1 = Math.floor(n / dLat), j0 = Math.floor(w / dLng), j1 = Math.floor(e / dLng);
    const rows = i1 - i0 + 1, cols = j1 - j0 + 1;

    // Measured evidence per cell
    const measured = new Map();
    devs.forEach(st => {
      const key = (Math.floor(st.latlng[0] / dLat) - i0) * cols + (Math.floor(st.latlng[1] / dLng) - j0);
      if (!measured.has(key)) measured.set(key, { devices: [], counts: { good: 0, single: 0, weak: 0, silent: 0, unknown: 0 } });
      const m = measured.get(key);
      m.devices.push(st); m.counts[st.status]++;
    });

    // Best / second-best predicted RSSI per cell. Each gateway only visits the cells within the
    // distance at which its prediction falls 15 dB below the weak threshold – beyond that it can
    // neither provide reception nor change a cell's class. Keeps large areas with hundreds of
    // gateways fast (cells × gateways would be tens of millions of evaluations).
    const nCells = rows * cols;
    const best = new Float64Array(nCells).fill(-Infinity), second = new Float64Array(nCells).fill(-Infinity);
    const bestIdx = new Int32Array(nCells).fill(-1);
    const floorDb = th.rssiWeak - 15;
    gws.forEach((g, gi) => {
      const m = model.perGw.get(g.key) || model.global;
      const R = Math.min(100000, 1000 * 10 ** ((m.r1k - floorDb) / (10 * m.n)));
      const [glat, glng] = g.latlng;
      const rA = Math.max(0, Math.floor((glat - R / 111320) / dLat) - i0), rB = Math.min(rows - 1, Math.floor((glat + R / 111320) / dLat) - i0);
      for (let r = rA; r <= rB; r++) {
        const la = (i0 + r + 0.5) * dLat;
        const kx = 111320 * Math.cos(la * Math.PI / 180);
        const dy = (la - glat) * 111320;
        if (Math.abs(dy) > R) continue;
        const half = Math.sqrt(R * R - dy * dy) / kx;
        const cA = Math.max(0, Math.floor((glng - half) / dLng) - j0), cB = Math.min(cols - 1, Math.floor((glng + half) / dLng) - j0);
        for (let c = cA; c <= cB; c++) {
          const dx = ((j0 + c + 0.5) * dLng - glng) * kx;
          const v = predictRssi(m, Math.sqrt(dx * dx + dy * dy));
          const k = r * cols + c;
          if (v > best[k]) { second[k] = best[k]; best[k] = v; bestIdx[k] = gi; } else if (v > second[k]) second[k] = v;
        }
      }
    });
    const cells = new Array(nCells);
    for (let r = 0; r < rows; r++) {
      const la = (i0 + r + 0.5) * dLat;
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        const b = best[idx], sc = second[idx];
        let cls;
        if (b < th.rssiWeak) cls = 'none';
        else if (b < covered) cls = 'marginal';
        else if (sc >= covered) cls = 'covered';
        else cls = 'single';
        const cell = { idx, r, c, center: [la, (j0 + c + 0.5) * dLng], predicted: cls, cls, best: b, second: sc, bestGw: bestIdx[idx] >= 0 ? gws[bestIdx[idx]] : null, measured: null };
        const m = measured.get(idx);
        if (m) {
          const k = m.counts, rated = m.devices.length - k.unknown, bad = k.silent + k.weak;
          cell.measured = m;
          if (rated) {
            if (bad === rated) cell.cls = 'none';
            else if (k.good) cell.cls = 'covered';
            else if (k.single) cell.cls = 'single';
            else cell.cls = 'marginal';
          }
        }
        cells[idx] = cell;
      }
    }
    const nearestDistance = ll => gws.reduce((mn, g) => Math.min(mn, haversine(ll, g.latlng)), Infinity);
    cells.forEach(cl => {
      const la = (i0 + cl.r) * dLat, lo = (j0 + cl.c) * dLng;
      cl.bounds = [[la, lo], [la + dLat, lo + dLng]];
    });

    // Contiguous no-reception areas (4-neighbourhood flood fill)
    const seen = new Uint8Array(cells.length);
    const regions = [];
    cells.forEach(start => {
      if (start.cls !== 'none' || seen[start.idx]) return;
      const stack = [start], members = [];
      seen[start.idx] = 1;
      while (stack.length) {
        const cl = stack.pop();
        members.push(cl);
        [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dr, dc]) => {
          const r = cl.r + dr, c = cl.c + dc;
          if (r < 0 || c < 0 || r >= rows || c >= cols) return;
          const nb = cells[r * cols + c];
          if (nb.cls === 'none' && !seen[nb.idx]) { seen[nb.idx] = 1; stack.push(nb); }
        });
      }
      const edge = members.some(cl => cl.r === 0 || cl.c === 0 || cl.r === rows - 1 || cl.c === cols - 1);
      const affected = members.flatMap(cl => (cl.measured ? cl.measured.devices.filter(d => d.status === 'silent' || d.status === 'weak') : []));
      const center = [members.reduce((a, cl) => a + cl.center[0], 0) / members.length, members.reduce((a, cl) => a + cl.center[1], 0) / members.length];
      const bounds = [[Math.min(...members.map(cl => cl.bounds[0][0])), Math.min(...members.map(cl => cl.bounds[0][1]))],
                      [Math.max(...members.map(cl => cl.bounds[1][0])), Math.max(...members.map(cl => cl.bounds[1][1]))]];
      regions.push({
        id: `R${regions.length + 1}`, cells: members, size: members.length,
        areaKm2: members.length * cellMeters * cellMeters / 1e6,
        edge, center, bounds,
        affected,
        measuredCells: members.filter(cl => cl.measured).length,
        bestPredicted: Math.max(...members.map(cl => cl.best)),
        nearestGw: rectDistance(bounds, gws),
      });
    });
    regions.forEach(rg => {
      // Representative point: the member cell closest to the centroid (a ring-shaped area's
      // centroid can lie outside the area).
      rg.point = rg.cells.reduce((b, cl) => ((cl.center[0] - rg.center[0]) ** 2 + (cl.center[1] - rg.center[1]) ** 2 <
        (b.center[0] - rg.center[0]) ** 2 + (b.center[1] - rg.center[1]) ** 2 ? cl : b)).center;
      rg.measuredOnly = rg.cells.every(cl => cl.predicted !== 'none');
      rg.devicesInside = rg.cells.reduce((a, cl) => a + (cl.measured ? cl.measured.devices.length : 0), 0);
    });
    regions.sort((a, b) => (b.areaKm2 - a.areaKm2) || (b.affected.length - a.affected.length));
    regions.forEach((rg, k) => { rg.id = `A${k + 1}`; rg.cells.forEach(cl => { cl.region = rg.id; }); });

    const counts = { covered: 0, single: 0, marginal: 0, none: 0 };
    cells.forEach(cl => counts[cl.cls]++);
    return { ...base, cellMeters, cells, regions, rows, cols, counts, bounds: [[s, w], [n, e]], requestedCellMeters: opts.cellMeters ?? 250, nearestDistance };
  }

  return {
    SF_SNR_FLOOR, normalizeGwId, extractGateways, extractSf, linkMargin, gatewayIdsFromDevice,
    deviceLatLng, haversine, percentile, analyze, fitPathLoss, estimateCoverage, isEuiLike,
    isGatewayDevice, isLnsInterface, gatewayLastPing, statsSummary, routerIdFromEntry, compactPacket, packetIntervalSecs, tsMs,
  };
})();

if (typeof module !== 'undefined') module.exports = NetAnalysis;
