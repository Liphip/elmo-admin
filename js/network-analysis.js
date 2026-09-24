'use strict';

// Pure analysis logic for the Network view (no DOM access).
// Element IoT attaches per-gateway reception data ("gateway stats") to packets. The exact
// JSON shape depends on the driver and changed with Element 4.4.0 (old + new structure are
// both emitted until end of 2026), so extraction is deliberately tolerant.
const NetAnalysis = (() => {
  // Demodulation SNR floor per LoRa spreading factor (dB). Link margin = SNR - floor.
  const SF_SNR_FLOOR = { 7: -7.5, 8: -10, 9: -12.5, 10: -15, 11: -17.5, 12: -20 };

  const GW_ID_KEYS  = ['gateway_id', 'gw_id', 'gateway_eui', 'gw_eui', 'gweui', 'gatewayId', 'gateway.gateway_id', 'gateway.eui', 'gateway.id', 'eui', 'mac', 'id'];
  const GW_NAME_KEYS = ['gateway_name', 'name', 'gateway.name'];
  const RSSI_KEYS   = ['rssi', 'rssic', 'rssis', 'signal_rssi', 'gw_rssi'];
  const SNR_KEYS    = ['snr', 'lsnr', 'signal_snr', 'gw_snr'];
  const LAT_KEYS    = ['latitude', 'lat', 'location.latitude', 'location.lat', 'gateway.latitude', 'gateway.lat', 'gateway.location.latitude'];
  const LNG_KEYS    = ['longitude', 'lng', 'lon', 'location.longitude', 'location.lng', 'location.lon', 'gateway.longitude', 'gateway.lng', 'gateway.location.longitude'];
  const SF_KEYS     = ['sf', 'spreading_factor', 'lora_sf', 'lora.sf', 'lora.spreading_factor', 'modulation.spreading_factor'];
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
    if (/^[0-9a-fA-F]{12,16}$/.test(compact)) return compact.toUpperCase();
    return s.toUpperCase();
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
      const id = normalizeGwId(pick(e, GW_ID_KEYS));
      if (!id) return;
      const coords = get(e, 'location.coordinates') || get(e, 'gateway.location.coordinates');
      let lat = num(pick(e, LAT_KEYS)), lng = num(pick(e, LNG_KEYS));
      if ((lat == null || lng == null) && Array.isArray(coords)) { lng = num(coords[0]); lat = num(coords[1]); }
      const entry = {
        id,
        name: pick(e, GW_NAME_KEYS) ?? null,
        rssi: num(pick(e, RSSI_KEYS)),
        snr: num(pick(e, SNR_KEYS)),
        lat: lngLatValid(lat, lng) ? lat : null,
        lng: lngLatValid(lat, lng) ? lng : null,
      };
      const prev = byId.get(id);
      if (!prev) { byId.set(id, entry); return; }
      // Same gateway reported twice (old + new structure): merge, keep the best values.
      for (const k of ['name', 'lat', 'lng']) if (prev[k] == null) prev[k] = entry[k];
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

  function extractSf(p) {
    const m = packetMeta(p);
    const sf = sfFromValue(pick(m, SF_KEYS), true) ?? sfFromValue(pick(m, DR_KEYS), false);
    if (sf != null) return sf;
    for (const g of gatewayCandidates(p)) {
      const s = sfFromValue(pick(g, SF_KEYS), true) ?? sfFromValue(pick(g, DR_KEYS), false);
      if (s != null) return s;
    }
    return null;
  }

  function linkMargin(snr, sf) {
    if (snr == null || sf == null) return null;
    const floor = SF_SNR_FLOOR[Math.round(sf)];
    return floor == null ? null : snr - floor;
  }

  // Collects every gateway identifier a gateway device can be referenced by:
  // EUI-like interface options (Element LNS / GMS interfaces) plus EUIs embedded in slug/name.
  function gatewayIdsFromDevice(device) {
    const ids = new Set();
    (device?.interfaces || []).forEach(i => {
      Object.entries(i?.opts || {}).forEach(([k, v]) => {
        if (!/eui|gateway|gw|mac/i.test(k) || typeof v !== 'string') return;
        const id = normalizeGwId(v);
        if (isEuiLike(id)) ids.add(id);
      });
    });
    [device?.slug, device?.name].forEach(s => {
      const m = String(s || '').match(/[0-9a-fA-F]{16}/);
      if (m) ids.add(m[0].toUpperCase());
    });
    return [...ids];
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
  function analyze({ devices, packetsByDevice, gatewayDevices = [], thresholds = {} }) {
    const th = { rssiWeak: -118, marginWeak: 5, snrWeak: -5, ...thresholds };
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
      const packets = packetsByDevice.get(device.id) || [];
      const st = {
        device, id: device.id, name: device.name || device.slug, latlng: deviceLatLng(device),
        packets: packets.length, withGwInfo: 0, gwPerPacket: acc(), sf: acc(),
        links: new Map(), lastSeen: null, best: null, status: 'silent',
      };
      packets.forEach(p => {
        const t = p.transceived_at || p.inserted_at || null;
        if (t && (!st.lastSeen || t > st.lastSeen)) st.lastSeen = t;
        const sf = extractSf(p);
        add(st.sf, sf);
        const gws = extractGateways(p);
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
      gw.status = gw.packets ? 'active' : (gw.inElement ? 'idle' : 'active');
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
    const noGwInfo = deviceStats.filter(s => s.packets > 0).every(s => s.withGwInfo === 0) && deviceStats.some(s => s.packets > 0);

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
        gatewaysForeign: gwList.filter(g => !g.inElement).length,
        packets: deviceStats.reduce((s, d) => s + d.packets, 0),
        counts,
        noGwInfo,
      },
    };
  }

  // Groups located devices into a square grid and rates every cell. Cells without devices are
  // not rated: absence of devices says nothing about coverage.
  function buildGrid(deviceStats, cellMeters = 500) {
    const pts = deviceStats.filter(s => s.latlng);
    if (!pts.length) return [];
    const lat0 = pts.reduce((s, p) => s + p.latlng[0], 0) / pts.length;
    const dLat = cellMeters / 111320;
    const dLng = cellMeters / (111320 * Math.max(Math.cos(lat0 * Math.PI / 180), 0.01));
    const cells = new Map();
    pts.forEach(st => {
      const i = Math.floor(st.latlng[0] / dLat), j = Math.floor(st.latlng[1] / dLng);
      const key = `${i}:${j}`;
      if (!cells.has(key)) cells.set(key, { key, bounds: [[i * dLat, j * dLng], [(i + 1) * dLat, (j + 1) * dLng]], devices: [], counts: { good: 0, single: 0, weak: 0, silent: 0, unknown: 0 } });
      const c = cells.get(key);
      c.devices.push(st);
      c.counts[st.status]++;
    });
    return [...cells.values()].map(c => {
      const bad = c.counts.silent + c.counts.weak;
      const rated = c.devices.length - c.counts.unknown;
      c.center = [(c.bounds[0][0] + c.bounds[1][0]) / 2, (c.bounds[0][1] + c.bounds[1][1]) / 2];
      c.badShare = rated ? bad / rated : 0;
      if (!rated) c.rating = 'unknown';
      else if (bad === rated) c.rating = 'hole';
      else if (bad > 0 || c.counts.single > 0) c.rating = 'marginal';
      else c.rating = 'good';
      const near = c.devices.map(d => d.nearestGwDistance).filter(v => v != null);
      c.nearestGwDistance = near.length ? Math.min(...near) : null;
      return c;
    });
  }

  return {
    SF_SNR_FLOOR, normalizeGwId, extractGateways, extractSf, linkMargin, gatewayIdsFromDevice,
    deviceLatLng, haversine, percentile, analyze, buildGrid, isEuiLike,
  };
})();

if (typeof module !== 'undefined') module.exports = NetAnalysis;
