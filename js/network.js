'use strict';

const NET_STATUS = {
  good:    { label: 'Good',            color: '#2f9e44' },
  single:  { label: 'Single gateway',  color: '#e8a400' },
  weak:    { label: 'Weak',            color: '#f76707' },
  silent:  { label: 'Silent',          color: '#e03131' },
  unknown: { label: 'No gateway data', color: '#868e96' },
};
const NET_LINK_COLOR = { good: '#2f9e44', ok: '#e8a400', weak: '#e03131' };
const NET_CELL_COLOR = { good: '#2f9e44', marginal: '#e8a400', hole: '#e03131', unknown: '#868e96' };
const NET_DEFAULT_TILES = {
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
};
const NET_MAX_TABLE_ROWS = 1000;
const NET_MAX_LINKS = 5000;

function netStatusBadge(status) {
  const s = NET_STATUS[status] || NET_STATUS.unknown;
  return `<span class="badge net-badge" style="--c:${s.color}">${esc(s.label)}</span>`;
}

function netGwLabel(gw) {
  return gw.name ? `${gw.name}` : gw.key;
}

class NetworkView {
  constructor(api, state, toast, detail) {
    this._api = api; this._state = state; this._toast = toast; this._detail = detail;
    this._map = null; this._layers = null; this._tileLayer = null;
    this._raw = null; this._result = null; this._grid = [];
    this._busy = false; this._cancel = false;
    this._statusFilter = new Set(Object.keys(NET_STATUS));
    this._selection = null;
    this._tab = 'devices';
    this._sort = { devices: { col: 'status', dir: 1 }, gateways: { col: 'devices', dir: -1 }, holes: { col: 'rating', dir: 1 } };
    this._filterTimer = null;
    this._bind();
    this._renderStatusFilters();
    this._renderLegend();
  }

  _bind() {
    $('#net-analyze').on('click', () => this.analyze());
    $('#net-cancel').on('click', () => { this._cancel = true; $('#net-cancel').prop('disabled', true).text('Cancelling…'); });
    $('#net-filter-q').on('input', () => { clearTimeout(this._filterTimer); this._filterTimer = setTimeout(() => this._renderAll(), 250); });
    $('#net-status-filters').on('click', '.net-chip', e => {
      const s = $(e.currentTarget).data('status');
      this._statusFilter.has(s) ? this._statusFilter.delete(s) : this._statusFilter.add(s);
      this._renderStatusFilters(); this._renderAll();
    });
    $('#net-l-gw, #net-l-dev, #net-l-links, #net-l-range').on('change', () => this._renderMap());
    $('#net-l-grid, #net-grid-size').on('change', () => { this._rebuildGrid(); this._renderMap(); this._renderTable(); });
    $('#net-fit').on('click', () => this._fit());
    $('#net-sel-clear').on('click', () => this._select(null));
    $('#net-th-apply').on('click', () => { if (this._raw) { this._recompute(); this._toast.show('Devices re-rated with new thresholds', 'info'); } });
    $('#net-tabs').on('click', 'a', e => {
      e.preventDefault();
      this._tab = $(e.currentTarget).data('ntab');
      $('#net-tabs a').removeClass('active'); $(e.currentTarget).addClass('active');
      this._renderTable();
    });
    $('#net-thead').on('click', 'th[data-col]', e => {
      const col = $(e.currentTarget).data('col'), s = this._sort[this._tab];
      if (s.col === col) s.dir = -s.dir; else { s.col = col; s.dir = 1; }
      this._renderTable();
    });
    $('#net-tbody').on('click', 'tr[data-kind]', e => {
      const tr = e.currentTarget;
      if (tr.dataset.kind === 'cell') { this._zoomCell(tr.dataset.id); return; }
      this._select({ kind: tr.dataset.kind, id: tr.dataset.id }, true);
    });
    $('#net-sel-body').on('click', '[data-select-kind]', e => {
      e.preventDefault();
      this._select({ kind: e.currentTarget.dataset.selectKind, id: e.currentTarget.dataset.selectId }, true);
    });
    $('#net-sel-body').on('click', '.net-open-device', e => { e.preventDefault(); this._openDevice(e.currentTarget.dataset.id); });
    $('#net-sel-body').on('click', '.net-zoom-sel', e => { e.preventDefault(); this._zoomSelection(); });
    $('#net-export-devices').on('click', e => { e.preventDefault(); this._exportDevices(); });
    $('#net-export-links').on('click', e => { e.preventDefault(); this._exportLinks(); });
    $('#net-export-gateways').on('click', e => { e.preventDefault(); this._exportGateways(); });
    $('#net-export-holes').on('click', e => { e.preventDefault(); this._exportCells(); });
  }

  // ---------- lifecycle ----------

  populateFolderDropdown() {
    const cur = $('#net-scope-folder').val();
    const opts = this._state.tags.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
    $('#net-scope-folder').html('<option value="">All devices</option>' + opts).val(cur || '');
  }

  onShow() {
    this._ensureMap();
    setTimeout(() => this._map && this._map.invalidateSize(), 50);
  }

  applyTileSettings() {
    if (!this._map) return;
    if (this._tileLayer) { this._map.removeLayer(this._tileLayer); this._tileLayer = null; }
    const cfg = NetworkView.tileSettings();
    if (cfg.url) this._tileLayer = L.tileLayer(cfg.url, { maxZoom: 19, attribution: cfg.attribution }).addTo(this._map);
  }

  static tileSettings() {
    try {
      const s = JSON.parse(localStorage.getItem('deviceAdminSettings') || '{}');
      if (s.tileUrl === '') return { url: '', attribution: '' };
      return { url: s.tileUrl || NET_DEFAULT_TILES.url, attribution: s.tileAttribution ?? NET_DEFAULT_TILES.attribution };
    } catch { return { ...NET_DEFAULT_TILES }; }
  }

  _ensureMap() {
    if (this._map || typeof L === 'undefined') return;
    this._map = L.map('net-map', { preferCanvas: true, zoomControl: true }).setView([51.1657, 10.4515], 6);
    this.applyTileSettings();
    this._renderer = L.canvas({ padding: 0.3 });
    this._layers = {
      grid: L.layerGroup().addTo(this._map),
      range: L.layerGroup().addTo(this._map),
      links: L.layerGroup().addTo(this._map),
      dev: L.layerGroup().addTo(this._map),
      gw: L.layerGroup().addTo(this._map),
      hl: L.layerGroup().addTo(this._map),
    };
    L.control.scale({ imperial: false }).addTo(this._map);
  }

  // ---------- loading ----------

  _progress(html) { $('#net-progress').html(html); }

  _setBusy(busy) {
    this._busy = busy;
    $('#net-analyze').prop('disabled', busy);
    $('#net-cancel').toggleClass('d-none', !busy).prop('disabled', false).text('Cancel');
  }

  async analyze() {
    if (this._busy) return;
    if (!this._api.apiKey) { this._toast.show('Configure API credentials first', 'warning'); return; }
    const folderId = $('#net-scope-folder').val();
    const hours = parseInt($('#net-scope-window').val(), 10) || 168;
    const perDevice = Math.max(1, Math.min(100, parseInt($('#net-scope-packets').val(), 10) || 20));
    const maxDev = Math.max(10, parseInt($('#net-scope-maxdev').val(), 10) || 2000);
    const uplinks = $('#net-scope-uplinks').prop('checked');
    const after = new Date(Date.now() - hours * 3600e3).toISOString();
    const shouldStop = () => this._cancel;
    this._cancel = false;
    this._setBusy(true);
    const warnings = [];
    try {
      // 1. Devices in scope
      const devPath = folderId ? `/tags/${encodeURIComponent(folderId)}/devices` : '/devices';
      const devices = await this._api.fetchAllPages(devPath, { limit: 100 },
        n => this._progress(`<span class="spinner-border spinner-border-sm me-1"></span>Loading devices… ${n}`),
        { maxItems: maxDev, shouldStop });
      if (this._cancel) throw new Error('cancelled');
      if (devices.length >= maxDev) warnings.push(`Device limit reached: only the first ${maxDev} devices were analysed. Narrow the scope with a folder or raise "Max devices".`);

      // 2. Gateways (always the full gateway list visible to the key, not just the folder)
      let gatewayDevices = devices.filter(d => d.type === 'gateway');
      if (folderId || devices.length >= maxDev) {
        try {
          // Simple filter type_is=gateway; results are re-checked client-side.
          const gws = await this._api.fetchAllPages('/devices', { limit: 100, type_is: 'gateway' },
            n => this._progress(`<span class="spinner-border spinner-border-sm me-1"></span>Loading gateways… ${n}`),
            { maxItems: 5000, shouldStop });
          const seen = new Set(gatewayDevices.map(g => g.id));
          gws.filter(g => g.type === 'gateway' && !seen.has(g.id)).forEach(g => gatewayDevices.push(g));
        } catch (e) {
          warnings.push(`Gateway devices could not be loaded (${esc(e.message)}). Gateways are identified from packet metadata only.`);
        }
      }
      if (this._cancel) throw new Error('cancelled');
      // Interface opts carry the gateway EUI – load them if the listing did not include interfaces.
      const needIfaces = gatewayDevices.filter(g => !Array.isArray(g.interfaces));
      if (needIfaces.length) {
        this._progress(`<span class="spinner-border spinner-border-sm me-1"></span>Loading gateway interfaces… (${needIfaces.length})`);
        await runConcurrent(needIfaces, async g => {
          if (this._cancel) return;
          const r = await this._api.get(`/devices/${g.id}/interfaces`, { limit: 100 });
          g.interfaces = Array.isArray(r.body) ? r.body : [];
        }, 3);
      }

      // 3. Recent uplinks per sensor
      const sensors = devices.filter(d => d.type !== 'gateway');
      const packetsByDevice = new Map();
      let done = 0;
      const started = Date.now();
      const res = await runConcurrent(sensors, async d => {
        if (this._cancel) throw new Error('cancelled');
        const params = { limit: perDevice, after, sort_direction: 'descending' };
        if (uplinks) params.packet_type = 'up';
        const r = await this._api.get(`/devices/${d.id}/packets`, params);
        packetsByDevice.set(d.id, Array.isArray(r.body) ? r.body : []);
        done++;
        if (done % 5 === 0 || done === sensors.length) {
          const eta = done ? Math.round((Date.now() - started) / done * (sensors.length - done) / 1000) : 0;
          this._progress(`<span class="spinner-border spinner-border-sm me-1"></span>Loading packets… ${done} / ${sensors.length} devices${eta > 5 ? ` · ~${eta}s left` : ''}`);
        }
      }, 4);
      if (this._cancel) warnings.push(`Analysis was cancelled after ${done} of ${sensors.length} devices – the remaining devices are shown as silent.`);
      const failed = res.failed.filter(f => f.error !== 'cancelled');
      if (failed.length) warnings.push(`Packets could not be loaded for ${failed.length} device(s) (e.g. ${esc(failed[0].item.name || failed[0].item.id)}: ${esc(failed[0].error)}). They are shown as silent.`);

      this._raw = { devices: sensors, gatewayDevices, packetsByDevice, params: { folderId, hours, perDevice, uplinks } };
      this._warnings = warnings;
      this._selection = null;
      this._recompute(true);
      const s = this._result.summary;
      this._progress(`${this._cancel ? '<span class="text-warning">Partial result.</span> ' : ''}Analysed <strong>${s.packets}</strong> packets from <strong>${s.devices}</strong> devices and <strong>${s.gateways}</strong> gateways in the last ${hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`}.`);
    } catch (e) {
      if (e.message === 'cancelled') this._progress('Analysis cancelled.');
      else { this._progress(`<span class="text-danger">Failed: ${esc(e.message)}</span>`); this._toast.show(`Network analysis: ${e.message}`, 'danger'); }
    } finally {
      this._setBusy(false);
    }
  }

  _thresholds() {
    const n = (id, d) => { const v = parseFloat($(id).val()); return Number.isFinite(v) ? v : d; };
    return { rssiWeak: n('#net-th-rssi', -118), marginWeak: n('#net-th-margin', 5), snrWeak: n('#net-th-snr', -5) };
  }

  _recompute(fit = false) {
    this._result = NetAnalysis.analyze({ ...this._raw, thresholds: this._thresholds() });
    this._devById = new Map(this._result.devices.map(d => [d.id, d]));
    this._gwByKey = new Map(this._result.gateways.map(g => [g.key, g]));
    this._rebuildGrid();
    if (this._selection && !this._resolveSelection()) this._selection = null;
    $('#net-empty').addClass('d-none'); $('#net-content').removeClass('d-none');
    $('#net-export-btn').prop('disabled', false);
    this._ensureMap();
    this._map.invalidateSize();
    this._renderAll();
    if (fit) this._fit();
  }

  _rebuildGrid() {
    if (!this._result) return;
    this._grid = NetAnalysis.buildGrid(this._result.devices, parseInt($('#net-grid-size').val(), 10) || 500);
  }

  // ---------- filtering ----------

  _matcher() {
    const q = ($('#net-filter-q').val() || '').trim().toLowerCase();
    if (!q) return null;
    const qHex = q.replace(/[\s:.-]/g, '');
    return values => values.some(v => {
      const s = String(v || '').toLowerCase();
      return s.includes(q) || (qHex.length >= 4 && s.replace(/[\s:.-]/g, '').includes(qHex));
    });
  }

  _deviceSearchValues(st) {
    const vals = [st.name, st.device.slug, st.id];
    (st.device.interfaces || []).forEach(i => Object.values(i?.opts || {}).forEach(v => { if (typeof v === 'string' && v.length <= 64) vals.push(v); }));
    return vals;
  }

  _visible() {
    const m = this._matcher();
    const gwMatch = m ? new Set(this._result.gateways.filter(g => m([g.key, g.name, ...(g.ids || [])])).map(g => g.key)) : null;
    const devices = this._result.devices.filter(st => {
      if (!this._statusFilter.has(st.status)) return false;
      if (!m) return true;
      if (m(this._deviceSearchValues(st))) return true;
      return gwMatch.size > 0 && [...st.links.keys()].some(k => gwMatch.has(k));
    });
    let gateways = this._result.gateways;
    if (m) {
      const linked = new Set();
      devices.forEach(st => st.links.forEach((_, k) => linked.add(k)));
      gateways = gateways.filter(g => gwMatch.has(g.key) || (!gwMatch.size && linked.has(g.key)));
    }
    return { devices, gateways };
  }

  // ---------- rendering ----------

  _renderAll() {
    if (!this._result) return;
    this._vis = this._visible();
    this._renderTiles();
    this._renderMap();
    this._renderSelection();
    this._renderTable();
  }

  _renderStatusFilters() {
    $('#net-status-filters').html(Object.entries(NET_STATUS).map(([k, s]) =>
      `<button type="button" class="btn btn-sm net-chip ${this._statusFilter.has(k) ? 'active' : ''}" data-status="${k}" style="--c:${s.color}" title="Toggle ${esc(s.label)}"><span class="net-dot"></span>${esc(s.label)}</button>`).join(''));
  }

  _renderLegend() {
    const dev = Object.values(NET_STATUS).map(s => `<span><span class="net-dot" style="--c:${s.color}"></span>${esc(s.label)}</span>`).join('');
    $('#net-legend').html(`${dev}<span class="ms-2"><span class="net-gw-legend"><i class="bi bi-broadcast-pin"></i></span>Gateway</span>
      <span class="ms-2">Links: <span class="net-line" style="--c:${NET_LINK_COLOR.good}"></span>good <span class="net-line" style="--c:${NET_LINK_COLOR.ok}"></span>fair <span class="net-line" style="--c:${NET_LINK_COLOR.weak}"></span>weak</span>`);
  }

  _renderTiles() {
    const s = this._result.summary, c = s.counts;
    const pct = n => s.devices ? ` <small class="text-muted">${Math.round(n / s.devices * 100)}%</small>` : '';
    const tile = (label, value, color, title = '') =>
      `<div class="col-6 col-md-4 col-xl"><div class="card net-tile h-100" style="--c:${color || '#adb5bd'}" title="${esc(title)}"><div class="card-body py-2">
        <div class="small text-muted">${esc(label)}</div><div class="fs-5 fw-semibold">${value}</div></div></div></div>`;
    $('#net-tiles').html([
      tile('Devices', `${s.devices}<small class="text-muted fs-6 fw-normal"> · ${s.located} on map</small>`, null, 'Devices without location are only listed in the table'),
      tile('Gateways', `${s.gatewaysActive}<small class="text-muted"> / ${s.gateways} active</small>`, '#1c7ed6', `${s.gatewaysIdle} Element gateway(s) received nothing; ${s.gatewaysForeign} gateway(s) are not Element devices of this key`),
      tile('Good', `${c.good}${pct(c.good)}`, NET_STATUS.good.color),
      tile('Single gateway', `${c.single}${pct(c.single)}`, NET_STATUS.single.color, 'No redundancy – a single gateway outage makes these devices silent'),
      tile('Weak', `${c.weak}${pct(c.weak)}`, NET_STATUS.weak.color),
      tile('Silent', `${c.silent}${pct(c.silent)}`, NET_STATUS.silent.color, 'No uplink in the time window'),
      c.unknown ? tile('No gateway data', `${c.unknown}${pct(c.unknown)}`, NET_STATUS.unknown.color) : '',
    ].join(''));
    $('#net-summary-badge').text(`${s.devices} devices · ${s.gateways} gateways`);
    const warns = [...(this._warnings || [])];
    if (s.noGwInfo) warns.push('None of the loaded packets contained gateway statistics. This depends on the driver: Element LNS, Actility and proxy drivers attach them to LoRaWAN uplinks; other drivers (e.g. wM-Bus, NB-IoT) do not.');
    const noLoc = s.devices - s.located;
    if (noLoc) warns.push(`${noLoc} device(s) have no location and are not shown on the map.`);
    const gwNoLoc = this._result.gateways.filter(g => !g.latlng && g.packets).length;
    if (gwNoLoc) warns.push(`${gwNoLoc} active gateway(s) have no known location – links to them cannot be drawn.`);
    $('#net-warning').toggleClass('d-none', !warns.length).html(warns.map(w => `<div><i class="bi bi-exclamation-triangle me-1"></i>${w}</div>`).join(''));
    $('#net-tab-dev-count').text(this._vis.devices.length);
    $('#net-tab-gw-count').text(this._vis.gateways.length);
    $('#net-tab-hole-count').text(this._grid.filter(c => c.rating === 'hole').length);
  }

  _gwIcon(gw, selected) {
    const cls = !gw.packets ? 'idle' : (gw.inElement ? 'active' : 'foreign');
    return L.divIcon({
      className: '',
      html: `<div class="net-gw-icon ${cls}${selected ? ' selected' : ''}"><i class="bi bi-broadcast-pin"></i></div>`,
      iconSize: [26, 26], iconAnchor: [13, 13],
    });
  }

  _renderMap() {
    if (!this._map || !this._result) return;
    const L_ = this._layers;
    Object.values(L_).forEach(l => l.clearLayers());
    const { devices, gateways } = this._vis;
    const sel = this._selection;

    if ($('#net-l-grid').prop('checked')) {
      this._grid.forEach(c => {
        L.rectangle(c.bounds, { renderer: this._renderer, color: NET_CELL_COLOR[c.rating], weight: 1, fillOpacity: c.rating === 'good' ? 0.15 : 0.35 })
          .bindTooltip(`<strong>${esc(c.rating)}</strong><br>${c.devices.length} device(s): ${c.counts.good} good, ${c.counts.single} single, ${c.counts.weak} weak, ${c.counts.silent} silent<br>Nearest gateway: ${fmtDistance(c.nearestGwDistance)}`)
          .addTo(L_.grid);
      });
    }

    if ($('#net-l-range').prop('checked')) {
      gateways.filter(g => g.latlng && g.range).forEach(g => {
        L.circle(g.latlng, { renderer: this._renderer, radius: g.range, color: '#1c7ed6', weight: 1, dashArray: '4 4', fillOpacity: 0.04, interactive: false }).addTo(L_.range);
      });
    }

    // Links
    const mode = $('#net-l-links').val();
    const drawLink = (devLatLng, link) => {
      if (!devLatLng || !link.gw.latlng) return;
      L.polyline([devLatLng, link.gw.latlng], {
        renderer: this._renderer, color: NET_LINK_COLOR[link.quality], weight: Math.min(1.5 + Math.log2(link.count + 1), 5), opacity: 0.75,
      }).bindTooltip(`${esc(netGwLabel(link.gw))}<br>RSSI ${fmtNum(link.rssiAvg)} dBm · SNR ${fmtNum(link.snrAvg)} dB${link.margin != null ? ` · margin ${fmtNum(link.margin)} dB` : ''}<br>${link.count} packet(s) · ${fmtDistance(link.distance)}`, { sticky: true })
        .addTo(L_.links);
    };
    if (mode === 'all') {
      let n = 0;
      for (const st of devices) {
        for (const link of st.links.values()) { if (n++ >= NET_MAX_LINKS) break; drawLink(st.latlng, link); }
        if (n >= NET_MAX_LINKS) break;
      }
    } else if (mode === 'selected' && sel) {
      const r = this._resolveSelection();
      if (sel.kind === 'device' && r) r.links.forEach(link => drawLink(r.latlng, link));
      if (sel.kind === 'gw' && r) {
        r.devices.forEach((_, devId) => {
          const st = this._devById.get(devId);
          const link = st?.links.get(r.key);
          if (link) drawLink(st.latlng, link);
        });
      }
    }

    if ($('#net-l-dev').prop('checked')) {
      devices.filter(st => st.latlng).forEach(st => {
        L.circleMarker(st.latlng, {
          renderer: this._renderer, radius: 6, color: '#fff', weight: 1.5, fillColor: NET_STATUS[st.status].color, fillOpacity: 0.95,
        }).bindTooltip(`<strong>${esc(st.name)}</strong><br>${esc(NET_STATUS[st.status].label)} · ${st.gwCount} gateway(s) · ${st.packets} pkt`)
          .on('click', () => this._select({ kind: 'device', id: st.id }))
          .addTo(L_.dev);
      });
    }

    if ($('#net-l-gw').prop('checked')) {
      gateways.filter(g => g.latlng).forEach(g => {
        const selected = sel?.kind === 'gw' && sel.id === g.key;
        L.marker(g.latlng, { icon: this._gwIcon(g, selected), zIndexOffset: selected ? 2000 : 1000, keyboard: false })
          .bindTooltip(`<strong>${esc(netGwLabel(g))}</strong><br>${g.deviceCount} device(s) · ${g.packets} pkt${g.soleFor ? `<br>Only gateway for ${g.soleFor} device(s)` : ''}`)
          .on('click', () => this._select({ kind: 'gw', id: g.key }))
          .addTo(L_.gw);
      });
    }

    // Highlight ring for the selected device
    if (sel?.kind === 'device') {
      const st = this._devById.get(sel.id);
      if (st?.latlng) L.circleMarker(st.latlng, { radius: 11, color: '#1971c2', weight: 3, fill: false, interactive: false }).addTo(L_.hl);
    }
  }

  _fit() {
    if (!this._map || !this._vis) return;
    const pts = [...this._vis.devices.filter(d => d.latlng).map(d => d.latlng), ...this._vis.gateways.filter(g => g.latlng).map(g => g.latlng)];
    if (pts.length) this._map.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 16 });
  }

  // ---------- selection ----------

  _resolveSelection() {
    const sel = this._selection;
    if (!sel || !this._result) return null;
    return sel.kind === 'device' ? this._devById.get(sel.id) : this._gwByKey.get(sel.id);
  }

  _select(sel, zoom = false) {
    this._selection = sel;
    if (sel && $('#net-l-links').val() === 'none') $('#net-l-links').val('selected');
    this._renderMap();
    this._renderSelection();
    this._renderTable();
    if (zoom) this._zoomSelection();
  }

  _zoomSelection() {
    const r = this._resolveSelection();
    if (!r || !this._map) return;
    const pts = [];
    if (this._selection.kind === 'device') {
      if (r.latlng) pts.push(r.latlng);
      r.links.forEach(l => l.gw.latlng && pts.push(l.gw.latlng));
    } else {
      if (r.latlng) pts.push(r.latlng);
      r.devices.forEach((_, id) => { const st = this._devById.get(id); if (st?.latlng) pts.push(st.latlng); });
    }
    if (pts.length === 1) this._map.setView(pts[0], Math.max(this._map.getZoom(), 14));
    else if (pts.length) this._map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 16 });
  }

  _renderSelection() {
    const r = this._resolveSelection();
    $('#net-sel-clear').toggleClass('d-none', !r);
    if (!r) {
      $('#net-sel-title').text('Selection');
      $('#net-sel-body').html('<p class="text-muted mb-0">Click a gateway or device on the map (or in the tables below) to see which gateways receive which devices.</p>');
      return;
    }
    if (this._selection.kind === 'device') this._renderDeviceSelection(r);
    else this._renderGatewaySelection(r);
  }

  _renderDeviceSelection(st) {
    $('#net-sel-title').html(`<i class="bi bi-cpu me-1"></i>${esc(st.name)}`);
    const links = [...st.links.values()].sort((a, b) => (b.margin ?? b.snrAvg ?? -99) - (a.margin ?? a.snrAvg ?? -99));
    const rows = links.map(l => `<tr>
        <td><a href="#" data-select-kind="gw" data-select-id="${esc(l.gw.key)}">${esc(netGwLabel(l.gw))}</a>${l.gw.inElement ? '' : ' <span class="badge text-bg-light border" title="Gateway is not a device visible to this API key">ext</span>'}</td>
        <td class="text-end">${l.count}</td>
        <td class="text-end"><span class="net-q" style="--c:${NET_LINK_COLOR[l.quality]}"></span>${fmtNum(l.rssiAvg, 0)}</td>
        <td class="text-end">${fmtNum(l.snrAvg)}</td>
        <td class="text-end">${fmtNum(l.margin)}</td>
        <td class="text-end">${fmtDistance(l.distance)}</td></tr>`).join('');
    $('#net-sel-body').html(`
      <div class="mb-2">${netStatusBadge(st.status)} ${typeBadge(st.device.type)}</div>
      <dl class="row mb-2 net-dl">
        <dt class="col-6">Packets in window</dt><dd class="col-6">${st.packets}${st.packets && st.withGwInfo < st.packets ? ` <small class="text-muted">(${st.withGwInfo} with gw data)</small>` : ''}</dd>
        <dt class="col-6">Last uplink</dt><dd class="col-6">${st.lastSeen ? `<span title="${esc(fmtDate(st.lastSeen))}">${fmtAgo(st.lastSeen)}</span>` : '—'}</dd>
        <dt class="col-6">Gateways / packet</dt><dd class="col-6">${fmtNum(st.gwAvg)}</dd>
        <dt class="col-6">Avg. spreading factor</dt><dd class="col-6">${st.sfAvg != null ? `SF${fmtNum(st.sfAvg)}` : '—'}</dd>
        <dt class="col-6">Nearest gateway</dt><dd class="col-6">${st.nearestGw ? `${fmtDistance(st.nearestGwDistance)} <small class="text-muted">(${esc(netGwLabel(st.nearestGw))})</small>` : '—'}</dd>
        ${st.latlng ? '' : '<dt class="col-12 text-warning fw-normal">Device has no location.</dt>'}
      </dl>
      <div class="d-flex gap-2 mb-2">
        <button type="button" class="btn btn-sm btn-outline-primary net-open-device" data-id="${esc(st.id)}"><i class="bi bi-box-arrow-up-right me-1"></i>Device details</button>
        <button type="button" class="btn btn-sm btn-outline-secondary net-zoom-sel"><i class="bi bi-zoom-in me-1"></i>Zoom</button>
      </div>
      ${links.length ? `<div class="table-responsive"><table class="table table-sm mb-0"><thead><tr><th>Received by</th><th class="text-end">Pkt</th><th class="text-end">RSSI</th><th class="text-end">SNR</th><th class="text-end">Margin</th><th class="text-end">Dist.</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : `<p class="text-muted mb-0">${st.packets ? 'Packets carry no gateway statistics.' : 'No uplinks in the selected time window.'}</p>`}`);
  }

  _renderGatewaySelection(gw) {
    $('#net-sel-title').html(`<i class="bi bi-broadcast-pin me-1"></i>${esc(netGwLabel(gw))}`);
    const rows = [...gw.devices.entries()].map(([id, count]) => {
      const st = this._devById.get(id), link = st?.links.get(gw.key);
      return { st, link, count };
    }).filter(x => x.st && x.link).sort((a, b) => (a.link?.rssiAvg ?? -999) - (b.link?.rssiAvg ?? -999));
    const body = rows.slice(0, 300).map(({ st, link, count }) => `<tr>
        <td><a href="#" data-select-kind="device" data-select-id="${esc(st.id)}">${esc(st.name)}</a>${st.gwCount === 1 ? ' <span class="badge text-bg-warning" title="This gateway is the only one receiving the device">only</span>' : ''}</td>
        <td class="text-end">${count}</td>
        <td class="text-end"><span class="net-q" style="--c:${NET_LINK_COLOR[link.quality]}"></span>${fmtNum(link.rssiAvg, 0)}</td>
        <td class="text-end">${fmtNum(link.snrAvg)}</td>
        <td class="text-end">${fmtDistance(link.distance)}</td></tr>`).join('');
    $('#net-sel-body').html(`
      <div class="mb-2">
        ${gw.packets ? '<span class="badge text-bg-success">receiving</span>' : '<span class="badge text-bg-secondary" title="No packet in the window was received by this gateway">idle</span>'}
        ${gw.inElement ? '<span class="badge text-bg-primary">Element device</span>' : '<span class="badge text-bg-light border" title="Seen in packet metadata only – not a gateway device visible to this API key">external</span>'}
      </div>
      <dl class="row mb-2 net-dl">
        <dt class="col-5">EUI</dt><dd class="col-7 font-monospace small">${(gw.ids || [gw.key]).map(esc).join('<br>') || '—'}</dd>
        <dt class="col-5">Devices heard</dt><dd class="col-7">${gw.deviceCount}</dd>
        <dt class="col-5">Only gateway for</dt><dd class="col-7">${gw.soleFor ? `<strong class="text-warning">${gw.soleFor} device(s)</strong>` : '0'}</dd>
        <dt class="col-5">Packets</dt><dd class="col-7">${gw.packets}</dd>
        <dt class="col-5">Avg. RSSI / SNR</dt><dd class="col-7">${fmtNum(gw.rssiAvg, 0)} dBm / ${fmtNum(gw.snrAvg)} dB</dd>
        <dt class="col-5" title="90th percentile distance of located devices received">Observed range</dt><dd class="col-7">${fmtDistance(gw.range)} <small class="text-muted">(max ${fmtDistance(gw.maxDistance)})</small></dd>
        <dt class="col-5">Last packet</dt><dd class="col-7">${gw.lastSeen ? `<span title="${esc(fmtDate(gw.lastSeen))}">${fmtAgo(gw.lastSeen)}</span>` : '—'}</dd>
        ${gw.latlng ? '' : '<dt class="col-12 text-warning fw-normal">Gateway location unknown.</dt>'}
      </dl>
      <div class="d-flex gap-2 mb-2">
        ${gw.device ? `<button type="button" class="btn btn-sm btn-outline-primary net-open-device" data-id="${esc(gw.device.id)}"><i class="bi bi-box-arrow-up-right me-1"></i>Gateway details</button>` : ''}
        <button type="button" class="btn btn-sm btn-outline-secondary net-zoom-sel"><i class="bi bi-zoom-in me-1"></i>Zoom</button>
      </div>
      ${rows.length ? `<div class="table-responsive"><table class="table table-sm mb-0"><thead><tr><th>Device</th><th class="text-end">Pkt</th><th class="text-end">RSSI</th><th class="text-end">SNR</th><th class="text-end">Dist.</th></tr></thead><tbody>${body}</tbody></table></div>${rows.length > 300 ? `<div class="text-muted mt-1">Showing weakest 300 of ${rows.length}.</div>` : ''}`
        : '<p class="text-muted mb-0">No devices in scope were received by this gateway.</p>'}`);
  }

  _openDevice(id) {
    const st = this._devById.get(id);
    const dev = st?.device || this._raw?.gatewayDevices.find(g => g.id === id);
    if (dev) this._detail.open(dev);
  }

  // ---------- tables ----------

  _columns() {
    const statusOrder = { silent: 0, weak: 1, single: 2, unknown: 3, good: 4 };
    const ratingOrder = { hole: 0, marginal: 1, unknown: 2, good: 3 };
    if (this._tab === 'devices') return [
      { key: 'name', label: 'Device', val: s => (s.name || '').toLowerCase(), html: s => esc(s.name) + (s.latlng ? '' : ' <i class="bi bi-geo-alt text-muted opacity-50" title="No location"></i>') },
      { key: 'status', label: 'Status', val: s => statusOrder[s.status], html: s => netStatusBadge(s.status) },
      { key: 'packets', label: 'Pkt', num: true, val: s => s.packets, html: s => s.packets },
      { key: 'gws', label: 'Gateways', num: true, val: s => s.gwCount, html: s => s.gwCount },
      { key: 'best', label: 'Best gateway', val: s => (s.best ? netGwLabel(s.best.gw) : '').toLowerCase(), html: s => (s.best ? esc(netGwLabel(s.best.gw)) : '—') },
      { key: 'rssi', label: 'RSSI', num: true, val: s => s.best?.rssiAvg ?? -999, html: s => fmtNum(s.best?.rssiAvg, 0) },
      { key: 'snr', label: 'SNR', num: true, val: s => s.best?.snrAvg ?? -999, html: s => fmtNum(s.best?.snrAvg) },
      { key: 'margin', label: 'Margin', num: true, val: s => s.best?.margin ?? -999, html: s => fmtNum(s.best?.margin) },
      { key: 'sf', label: 'SF', num: true, val: s => s.sfAvg ?? 99, html: s => (s.sfAvg != null ? fmtNum(s.sfAvg) : '—') },
      { key: 'near', label: 'Nearest GW', num: true, val: s => s.nearestGwDistance ?? 1e12, html: s => fmtDistance(s.nearestGwDistance) },
      { key: 'last', label: 'Last uplink', val: s => s.lastSeen || '', html: s => (s.lastSeen ? `<span title="${esc(fmtDate(s.lastSeen))}">${fmtAgo(s.lastSeen)}</span>` : '—') },
    ];
    if (this._tab === 'gateways') return [
      { key: 'name', label: 'Gateway', val: g => netGwLabel(g).toLowerCase(), html: g => esc(netGwLabel(g)) + (g.latlng ? '' : ' <i class="bi bi-geo-alt text-muted opacity-50" title="No location"></i>') },
      { key: 'eui', label: 'EUI', val: g => g.key, html: g => `<code class="small">${esc(g.key.startsWith('dev:') ? '—' : g.key)}</code>` },
      { key: 'state', label: 'State', val: g => (g.packets ? 0 : 1), html: g => (g.packets ? '<span class="badge text-bg-success">receiving</span>' : '<span class="badge text-bg-secondary">idle</span>') + (g.inElement ? '' : ' <span class="badge text-bg-light border">external</span>') },
      { key: 'devices', label: 'Devices', num: true, val: g => g.deviceCount, html: g => g.deviceCount },
      { key: 'sole', label: 'Only GW for', num: true, val: g => g.soleFor, html: g => (g.soleFor ? `<strong class="text-warning">${g.soleFor}</strong>` : 0) },
      { key: 'packets', label: 'Pkt', num: true, val: g => g.packets, html: g => g.packets },
      { key: 'rssi', label: 'Avg RSSI', num: true, val: g => g.rssiAvg ?? -999, html: g => fmtNum(g.rssiAvg, 0) },
      { key: 'snr', label: 'Avg SNR', num: true, val: g => g.snrAvg ?? -999, html: g => fmtNum(g.snrAvg) },
      { key: 'range', label: 'Range (p90)', num: true, val: g => g.range ?? -1, html: g => fmtDistance(g.range) },
      { key: 'last', label: 'Last packet', val: g => g.lastSeen || '', html: g => (g.lastSeen ? fmtAgo(g.lastSeen) : '—') },
    ];
    return [
      { key: 'rating', label: 'Rating', val: c => ratingOrder[c.rating] * 10 - c.badShare, html: c => `<span class="badge net-badge" style="--c:${NET_CELL_COLOR[c.rating]}">${esc(c.rating)}</span>` },
      { key: 'devices', label: 'Devices', num: true, val: c => c.devices.length, html: c => c.devices.length },
      { key: 'silent', label: 'Silent', num: true, val: c => c.counts.silent, html: c => c.counts.silent },
      { key: 'weak', label: 'Weak', num: true, val: c => c.counts.weak, html: c => c.counts.weak },
      { key: 'single', label: 'Single GW', num: true, val: c => c.counts.single, html: c => c.counts.single },
      { key: 'good', label: 'Good', num: true, val: c => c.counts.good, html: c => c.counts.good },
      { key: 'near', label: 'Nearest GW', num: true, val: c => c.nearestGwDistance ?? 1e12, html: c => fmtDistance(c.nearestGwDistance) },
      { key: 'where', label: 'Location', val: c => c.center[0], html: c => `<code class="small">${c.center[0].toFixed(5)}, ${c.center[1].toFixed(5)}</code>` },
      { key: 'sample', label: 'Devices', val: () => 0, html: c => esc(c.devices.slice(0, 3).map(d => d.name).join(', ') + (c.devices.length > 3 ? ` +${c.devices.length - 3}` : '')) },
    ];
  }

  _rowsForTab() {
    if (this._tab === 'devices') return this._vis.devices;
    if (this._tab === 'gateways') return this._vis.gateways;
    return this._grid.filter(c => c.rating !== 'good');
  }

  _renderTable() {
    if (!this._result || !this._vis) return;
    const cols = this._columns(), s = this._sort[this._tab];
    const col = cols.find(c => c.key === s.col) || cols[0];
    const rows = [...this._rowsForTab()].sort((a, b) => {
      const va = col.val(a), vb = col.val(b);
      return (va < vb ? -1 : va > vb ? 1 : 0) * s.dir;
    });
    $('#net-thead').html(`<tr>${cols.map(c => `<th data-col="${c.key}" class="sortable${c.num ? ' text-end' : ''}">${esc(c.label)}${c.key === col.key ? ` <i class="bi bi-arrow-${s.dir > 0 ? 'up' : 'down'} small text-primary"></i>` : ''}</th>`).join('')}</tr>`);
    const kind = { devices: 'device', gateways: 'gw', holes: 'cell' }[this._tab];
    const idOf = r => (kind === 'device' ? r.id : r.key);
    const selId = this._selection?.id;
    $('#net-tbody').html(rows.slice(0, NET_MAX_TABLE_ROWS).map(r =>
      `<tr data-kind="${kind}" data-id="${esc(idOf(r))}" class="${idOf(r) === selId ? 'table-active' : ''}">${cols.map(c => `<td class="${c.num ? 'text-end' : ''}">${c.html(r)}</td>`).join('')}</tr>`).join('') ||
      `<tr><td colspan="${cols.length}" class="text-center text-muted py-3">${this._tab === 'holes' ? 'No coverage problems found among located devices.' : 'Nothing matches the current filters.'}</td></tr>`);
    const foot = this._tab === 'holes'
      ? `Cells of ${$('#net-grid-size option:selected').text()} containing silent, weak or single-gateway devices. <strong>hole</strong> = every rated device in the cell is silent or weak. Cells without devices are not rated.`
      : (rows.length > NET_MAX_TABLE_ROWS ? `Showing ${NET_MAX_TABLE_ROWS} of ${rows.length} rows – use the filters or export CSV.` : `${rows.length} row(s)`);
    $('#net-table-foot').html(foot);
  }

  _zoomCell(key) {
    const c = this._grid.find(x => x.key === key);
    if (!c || !this._map) return;
    if (!$('#net-l-grid').prop('checked')) { $('#net-l-grid').prop('checked', true); this._renderMap(); }
    this._map.fitBounds(c.bounds, { padding: [60, 60], maxZoom: 17 });
  }

  // ---------- export ----------

  _fileStamp() { return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-'); }

  _exportDevices() {
    if (!this._result) return;
    const rows = [['device_id', 'name', 'slug', 'status', 'latitude', 'longitude', 'packets', 'packets_with_gateway_data', 'gateways', 'gateways_per_packet', 'best_gateway', 'best_rssi_avg', 'best_snr_avg', 'best_margin', 'sf_avg', 'nearest_gateway', 'nearest_gateway_m', 'last_uplink']];
    this._vis.devices.forEach(s => rows.push([s.id, s.name, s.device.slug, s.status, s.latlng?.[0], s.latlng?.[1], s.packets, s.withGwInfo, s.gwCount, s.gwAvg?.toFixed(2),
      s.best ? netGwLabel(s.best.gw) : '', s.best?.rssiAvg?.toFixed(1), s.best?.snrAvg?.toFixed(1), s.best?.margin?.toFixed(1), s.sfAvg?.toFixed(1),
      s.nearestGw ? netGwLabel(s.nearestGw) : '', s.nearestGwDistance?.toFixed(0), s.lastSeen]));
    downloadFile(`elmo-network-devices-${this._fileStamp()}.csv`, toCsv(rows), 'text/csv');
  }

  _exportLinks() {
    if (!this._result) return;
    const rows = [['device_id', 'device_name', 'gateway_eui', 'gateway_name', 'packets', 'rssi_avg', 'rssi_best', 'snr_avg', 'snr_best', 'sf_avg', 'margin', 'quality', 'distance_m', 'last_seen']];
    this._vis.devices.forEach(s => s.links.forEach(l => rows.push([s.id, s.name, l.gw.key, l.gw.name, l.count, l.rssiAvg?.toFixed(1), l.rssiBest, l.snrAvg?.toFixed(1), l.snrBest, l.sfAvg?.toFixed(1), l.margin?.toFixed(1), l.quality, l.distance?.toFixed(0), l.lastSeen])));
    downloadFile(`elmo-network-links-${this._fileStamp()}.csv`, toCsv(rows), 'text/csv');
  }

  _exportGateways() {
    if (!this._result) return;
    const rows = [['gateway_eui', 'name', 'element_device_id', 'latitude', 'longitude', 'packets', 'devices', 'only_gateway_for', 'rssi_avg', 'snr_avg', 'range_p90_m', 'max_distance_m', 'last_packet']];
    this._vis.gateways.forEach(g => rows.push([g.key, g.name, g.device?.id, g.latlng?.[0], g.latlng?.[1], g.packets, g.deviceCount, g.soleFor, g.rssiAvg?.toFixed(1), g.snrAvg?.toFixed(1), g.range?.toFixed(0), g.maxDistance?.toFixed(0), g.lastSeen]));
    downloadFile(`elmo-network-gateways-${this._fileStamp()}.csv`, toCsv(rows), 'text/csv');
  }

  _exportCells() {
    if (!this._result) return;
    const rows = [['rating', 'center_lat', 'center_lng', 'devices', 'good', 'single', 'weak', 'silent', 'no_gateway_data', 'nearest_gateway_m', 'device_names']];
    this._grid.forEach(c => rows.push([c.rating, c.center[0].toFixed(6), c.center[1].toFixed(6), c.devices.length, c.counts.good, c.counts.single, c.counts.weak, c.counts.silent, c.counts.unknown, c.nearestGwDistance?.toFixed(0), c.devices.map(d => d.name).join('; ')]));
    downloadFile(`elmo-network-coverage-${this._fileStamp()}.csv`, toCsv(rows), 'text/csv');
  }
}
