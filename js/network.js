'use strict';

const NET_STATUS = {
  good:    { label: 'Good',            color: '#2f9e44' },
  single:  { label: 'Single gateway',  color: '#e8a400' },
  weak:    { label: 'Weak',            color: '#f76707' },
  silent:  { label: 'Silent',          color: '#e03131' },
  unknown: { label: 'No gateway data', color: '#868e96' },
};
const NET_LINK_COLOR = { good: '#2f9e44', ok: '#e8a400', weak: '#e03131' };
const NET_CELL = {
  none:     { label: 'No reception', color: '#e03131', rgba: [224, 49, 49, 115] },
  marginal: { label: 'Marginal',     color: '#f76707', rgba: [247, 103, 7, 90] },
  single:   { label: 'Single gateway', color: '#e8a400', rgba: [232, 164, 0, 55] },
  covered:  { label: 'Covered',      color: '#2f9e44', rgba: [47, 158, 68, 45] },
};
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
    this._raw = null; this._result = null; this._cov = null; this._viewBounds = null;
    this._sessionTiles = false;
    this._busy = false; this._cancel = false;
    this._statusFilter = new Set(Object.keys(NET_STATUS));
    this._selection = null;
    this._tab = 'devices';
    this._sort = { devices: { col: 'status', dir: 1 }, gateways: { col: 'devices', dir: -1 }, holes: { col: 'area', dir: -1 } };
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
    $('#net-l-grid, #net-l-covered').on('change', () => this._renderMap());
    $('#net-grid-size').on('change', () => this._updateCoverage());
    $('#net-area').on('change', () => {
      const view = $('#net-area').val() === 'view';
      $('#net-area-refresh').toggleClass('d-none', !view);
      if (view) this._viewBounds = this._currentViewBounds();
      this._updateCoverage();
    });
    $('#net-area-refresh').on('click', () => { this._viewBounds = this._currentViewBounds(); this._updateCoverage(); });
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
    $('#net-export-holes').on('click', e => { e.preventDefault(); this._exportAreas(); });
    $('#net-export-cells').on('click', e => { e.preventDefault(); this._exportCells(); });
    $('#net-sel-body').on('click', '.net-zoom-area', e => { e.preventDefault(); this._zoomArea(e.currentTarget.dataset.id); });
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

  // External map tiles are opt-in: nothing is requested from a tile server unless the user
  // enabled it in Configuration or clicked "Load base map" for this session.
  applyTileSettings() {
    if (!this._map) return;
    if (this._tileLayer) { this._map.removeLayer(this._tileLayer); this._tileLayer = null; }
    const cfg = NetworkView.tileSettings();
    const on = !!cfg.url && (cfg.enabled || this._sessionTiles);
    if (on) this._tileLayer = L.tileLayer(cfg.url, { maxZoom: 19, attribution: cfg.attribution }).addTo(this._map);
    $('#net-map').toggleClass('net-no-tiles', !on);
    this._renderTileControl(on, cfg);
  }

  _renderTileControl(on, cfg) {
    if (!this._tileCtl) {
      const Ctl = L.Control.extend({ onAdd: () => { const d = L.DomUtil.create('div', 'net-tile-ctl leaflet-bar'); L.DomEvent.disableClickPropagation(d); return d; } });
      this._tileCtl = new Ctl({ position: 'topright' }).addTo(this._map);
      $(this._tileCtl.getContainer()).on('click', 'button', e => {
        this._sessionTiles = e.currentTarget.dataset.act === 'on';
        if (!this._sessionTiles && NetworkView.tileSettings().enabled) this._toast.show('External map tiles are enabled permanently in Configuration', 'info');
        this.applyTileSettings();
      });
    }
    let host = '';
    try { host = new URL(cfg.url.replace(/\{[a-z]\}/g, 'a')).host; } catch {}
    const el = this._tileCtl.getContainer();
    if (!cfg.url) el.innerHTML = '<div class="p-2 small text-muted">No tile server configured</div>';
    else if (on) el.innerHTML = `<button type="button" class="btn btn-sm btn-light" data-act="off" title="Stop loading map tiles"><i class="bi bi-map me-1"></i>Hide base map</button>`;
    else el.innerHTML = `<div class="p-2 small"><div class="mb-1 text-muted">Base map off – no external requests.</div>
      <button type="button" class="btn btn-sm btn-primary" data-act="on"><i class="bi bi-map me-1"></i>Load base map</button>
      <div class="text-muted mt-1" style="max-width:220px">Loads tiles from <code>${esc(host)}</code> for this session; your IP address is sent to that server.</div></div>`;
  }

  static tileSettings() {
    try {
      const s = JSON.parse(localStorage.getItem('deviceAdminSettings') || '{}');
      return { url: s.tileUrl ?? NET_DEFAULT_TILES.url, attribution: s.tileAttribution ?? NET_DEFAULT_TILES.attribution, enabled: s.externalTiles === true };
    } catch { return { ...NET_DEFAULT_TILES, enabled: false }; }
  }

  _ensureMap() {
    if (this._map || typeof L === 'undefined') return;
    this._map = L.map('net-map', { preferCanvas: true, zoomControl: true }).setView([51.1657, 10.4515], 6);
    this.applyTileSettings();
    this._renderer = L.canvas({ padding: 0.3 });
    this._layers = {
      grid: L.layerGroup().addTo(this._map),
      area: L.layerGroup().addTo(this._map),
      range: L.layerGroup().addTo(this._map),
      links: L.layerGroup().addTo(this._map),
      dev: L.layerGroup().addTo(this._map),
      gw: L.layerGroup().addTo(this._map),
      hl: L.layerGroup().addTo(this._map),
    };
    L.control.scale({ imperial: false }).addTo(this._map);
    const Info = L.Control.extend({ onAdd: () => L.DomUtil.create('div', 'net-cell-info d-none') });
    this._infoCtl = new Info({ position: 'bottomleft' }).addTo(this._map);
    this._map.on('mousemove', e => this._showCellInfo(e.latlng));
    this._map.on('mouseout', () => $(this._infoCtl.getContainer()).addClass('d-none'));
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
    const lnsOnly = $('#net-scope-lns').prop('checked');
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

      // Element LNS driver instances (used to skip devices that are not LoRaWAN via ELEMENT LNS)
      let lnsIds = null;
      if (lnsOnly) {
        try {
          const inst = await this._api.fetchAllPages('/drivers/instances', { limit: 100 }, null, { shouldStop });
          const ids = inst.filter(i => NetworkView.isElementLns(i.driver)).map(i => i.id);
          if (ids.length) lnsIds = new Set(ids);
          else warnings.push('No ELEMENT LNS driver instance is visible to this API key – all devices were analysed.');
        } catch (e) {
          warnings.push(`Driver instances could not be loaded (${esc(e.message)}) – all devices were analysed, not only ELEMENT LNS devices.`);
        }
      }

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
      let sensors = devices.filter(d => d.type !== 'gateway');
      if (lnsIds) {
        const before = sensors.length;
        sensors = sensors.filter(d => !Array.isArray(d.interfaces) || d.interfaces.some(i => lnsIds.has(i.driver_instance_id)));
        if (before !== sensors.length) this._skipped = before - sensors.length;
        else this._skipped = 0;
      } else this._skipped = 0;
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
      if (this._skipped) warnings.push(`${this._skipped} device(s) without an ELEMENT LNS interface were skipped.`);
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

  static isElementLns(driver) {
    const d = String(driver || '');
    return /lns/i.test(d) && !/chirpstack|actility|thingpark|loriot|tracknet|ttn|thethings|kerlink|everynet/i.test(d);
  }

  _thresholds() {
    const n = (id, d) => { const v = parseFloat($(id).val()); return Number.isFinite(v) ? v : d; };
    return { rssiWeak: n('#net-th-rssi', -118), marginWeak: n('#net-th-margin', 5), snrWeak: n('#net-th-snr', -5) };
  }

  _recompute(fit = false) {
    this._result = NetAnalysis.analyze({ ...this._raw, thresholds: this._thresholds() });
    this._devById = new Map(this._result.devices.map(d => [d.id, d]));
    this._gwByKey = new Map(this._result.gateways.map(g => [g.key, g]));
    this._computeCoverage();
    if (this._selection && !this._resolveSelection()) this._selection = null;
    $('#net-empty').addClass('d-none'); $('#net-content').removeClass('d-none');
    $('#net-export-btn').prop('disabled', false);
    this._ensureMap();
    this._map.invalidateSize();
    this._renderAll();
    if (fit) this._fit();
  }

  _currentViewBounds() {
    if (!this._map) return null;
    const b = this._map.getBounds();
    return [[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]];
  }

  _computeCoverage() {
    if (!this._result) return;
    const area = $('#net-area').val();
    const fade = parseFloat($('#net-th-fade').val());
    this._cov = NetAnalysis.estimateCoverage(this._result, {
      cellMeters: parseInt($('#net-grid-size').val(), 10) || 250,
      padMeters: area === 'view' ? 0 : parseInt(area, 10) || 1000,
      bounds: area === 'view' ? this._viewBounds : null,
      fadeMargin: Number.isFinite(fade) ? fade : 8,
    });
    this._covImage = null;
    this._areaById = new Map(this._cov.regions.map(r => [r.id, r]));
  }

  _updateCoverage() {
    if (!this._result) return;
    this._computeCoverage();
    if (this._selection?.kind === 'area' && !this._resolveSelection()) this._selection = null;
    this._renderTiles(); this._renderMap(); this._renderSelection(); this._renderTable();
  }

  // Renders the reception grid into one image (one pixel per cell) – far cheaper than thousands of
  // vector rectangles. The grid is regular in lat/lng; at city scale the Mercator distortion within
  // the image is negligible.
  _coverageImage(showCovered) {
    const cov = this._cov;
    const key = `${showCovered}`;
    if (this._covImage?.key === key) return this._covImage;
    const cv = document.createElement('canvas');
    cv.width = cov.cols; cv.height = cov.rows;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(cov.cols, cov.rows);
    cov.cells.forEach(cl => {
      if (cl.cls === 'covered' && !showCovered) return;
      const [r, g, b, a] = NET_CELL[cl.cls].rgba;
      const o = ((cov.rows - 1 - cl.r) * cov.cols + cl.c) * 4;
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = cl.measured && cl.cls !== cl.predicted ? Math.min(255, a + 60) : a;
    });
    ctx.putImageData(img, 0, 0);
    this._covImage = { key, url: cv.toDataURL() };
    return this._covImage;
  }

  _cellAt(latlng) {
    const cov = this._cov;
    if (!cov?.cells.length) return null;
    const [[s, w], [n, e]] = [cov.cells[0].bounds[0], cov.cells[cov.cells.length - 1].bounds[1]];
    if (latlng.lat < s || latlng.lat >= n || latlng.lng < w || latlng.lng >= e) return null;
    const r = Math.floor((latlng.lat - s) / (n - s) * cov.rows), c = Math.floor((latlng.lng - w) / (e - w) * cov.cols);
    return cov.cells[r * cov.cols + c] || null;
  }

  _showCellInfo(latlng) {
    const el = $(this._infoCtl.getContainer());
    const cl = $('#net-l-grid').prop('checked') ? this._cellAt(latlng) : null;
    if (!cl) { el.addClass('d-none'); return; }
    const m = cl.measured;
    const measured = m ? `<div>Measured: ${m.devices.length} device(s) – ${['good', 'single', 'weak', 'silent'].filter(k => m.counts[k]).map(k => `${m.counts[k]} ${NET_STATUS[k].label.toLowerCase()}`).join(', ') || 'no gateway data'}</div>` : '<div class="text-muted">No devices in this cell – estimate only</div>';
    el.removeClass('d-none').html(`<strong style="color:${NET_CELL[cl.cls].color}">${esc(NET_CELL[cl.cls].label)}</strong>${cl.region ? ` · area ${esc(cl.region)}` : ''}
      <div>Predicted best: ${fmtNum(cl.best, 0)} dBm${cl.bestGw ? ` (${esc(netGwLabel(cl.bestGw))})` : ''}${Number.isFinite(cl.second) ? ` · 2nd ${fmtNum(cl.second, 0)} dBm` : ''}</div>
      <div>Nearest gateway: ${fmtDistance(cl.nearestGw)}</div>${measured}`);
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
      <span class="ms-2">Links: <span class="net-line" style="--c:${NET_LINK_COLOR.good}"></span>good <span class="net-line" style="--c:${NET_LINK_COLOR.ok}"></span>fair <span class="net-line" style="--c:${NET_LINK_COLOR.weak}"></span>weak</span>
      <span class="ms-2">Reception: ${Object.values(NET_CELL).map(c => `<span class="net-sq" style="--c:${c.color}"></span>${esc(c.label)}`).join(' ')}</span>`);
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
      this._cov?.cells.length ? tile('No reception (est.)', `${fmtNum(this._cov.counts.none * this._cov.cellMeters ** 2 / 1e6, 1)} km²<small class="text-muted fs-6 fw-normal"> · ${Math.round(this._cov.counts.none / this._cov.cells.length * 100)}%</small>`, NET_CELL.none.color, 'Share of the analysed area where no reception is expected or observed') : '',
    ].join(''));
    $('#net-summary-badge').text(`${s.devices} devices · ${s.gateways} gateways`);
    const warns = [...(this._warnings || [])];
    if (s.noGwInfo) warns.push('None of the loaded packets contained gateway statistics. ELEMENT LNS attaches them to LoRaWAN uplinks – if you see this for LNS devices, please report it (the packet format may have changed).');
    const noLoc = s.devices - s.located;
    if (noLoc) warns.push(`${noLoc} device(s) have no location and are not shown on the map.`);
    const gwNoLoc = this._result.gateways.filter(g => !g.latlng && g.packets).length;
    if (gwNoLoc) warns.push(`${gwNoLoc} active gateway(s) have no known location – links to them cannot be drawn.`);
    $('#net-warning').toggleClass('d-none', !warns.length).html(warns.map(w => `<div><i class="bi bi-exclamation-triangle me-1"></i>${w}</div>`).join(''));
    $('#net-tab-dev-count').text(this._vis.devices.length);
    $('#net-tab-gw-count').text(this._vis.gateways.length);
    $('#net-tab-hole-count').text(this._cov ? this._cov.regions.length : 0);
    if (this._cov?.cellMeters && this._cov.cellMeters !== this._cov.requestedCellMeters) {
      $('#net-warning').removeClass('d-none').append(`<div><i class="bi bi-info-circle me-1"></i>Reception map uses ${fmtDistance(this._cov.cellMeters)} cells (area too large for ${fmtDistance(this._cov.requestedCellMeters)}).</div>`);
    }
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

    if ($('#net-l-grid').prop('checked') && this._cov?.cells.length) {
      const im = this._coverageImage($('#net-l-covered').prop('checked'));
      const b = [this._cov.cells[0].bounds[0], this._cov.cells[this._cov.cells.length - 1].bounds[1]];
      L.imageOverlay(im.url, b, { className: 'net-cov-img', interactive: false, opacity: 1 }).addTo(L_.grid);
      L.rectangle(b, { renderer: this._renderer, color: '#495057', weight: 1, dashArray: '6 4', fill: false, interactive: false }).addTo(L_.grid);
    }
    if (sel?.kind === 'area') {
      const rg = this._areaById.get(sel.id);
      if (rg) rg.cells.forEach(cl => L.rectangle(cl.bounds, { renderer: this._renderer, color: '#c92a2a', weight: 0, fillColor: '#c92a2a', fillOpacity: 0.35, interactive: false }).addTo(L_.area));
      if (rg) L.rectangle(rg.bounds, { renderer: this._renderer, color: '#c92a2a', weight: 2, fill: false, dashArray: '4 3', interactive: false }).addTo(L_.area);
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
    if (sel.kind === 'area') return this._areaById?.get(sel.id) || null;
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
    if (this._selection.kind === 'area') { this._map.fitBounds(r.bounds, { padding: [60, 60], maxZoom: 17 }); return; }
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
    else if (this._selection.kind === 'area') this._renderAreaSelection(r);
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

  _renderAreaSelection(rg) {
    $('#net-sel-title').html(`<i class="bi bi-slash-circle me-1"></i>No-reception area ${esc(rg.id)}`);
    const affected = rg.affected.slice(0, 200).map(st => `<tr><td><a href="#" data-select-kind="device" data-select-id="${esc(st.id)}">${esc(st.name)}</a></td><td>${netStatusBadge(st.status)}</td><td class="text-end">${fmtNum(st.best?.rssiAvg, 0)}</td></tr>`).join('');
    const basis = rg.measuredOnly ? 'measured only (model predicts reception)' : (rg.devicesInside ? 'model + device evidence' : 'model estimate (no devices here)');
    $('#net-sel-body').html(`
      <dl class="row mb-2 net-dl">
        <dt class="col-6">Size</dt><dd class="col-6">${fmtNum(rg.areaKm2, 2)} km² <small class="text-muted">(${rg.size} cells)</small></dd>
        <dt class="col-6">Basis</dt><dd class="col-6">${esc(basis)}</dd>
        <dt class="col-6">Devices inside</dt><dd class="col-6">${rg.devicesInside}${rg.affected.length ? ` <small class="text-danger">(${rg.affected.length} silent/weak)</small>` : ''}</dd>
        <dt class="col-6">Best predicted RSSI</dt><dd class="col-6">${fmtNum(rg.bestPredicted, 0)} dBm</dd>
        <dt class="col-6">Nearest active gateway</dt><dd class="col-6">${fmtDistance(rg.nearestGw)}</dd>
        <dt class="col-6">Location</dt><dd class="col-6"><code class="small">${rg.point[0].toFixed(5)}, ${rg.point[1].toFixed(5)}</code></dd>
        ${rg.edge ? '<dt class="col-12 fw-normal text-muted">Extends to the border of the analysed area – enlarge the area to see its full extent.</dt>' : ''}
      </dl>
      <button type="button" class="btn btn-sm btn-outline-secondary mb-2 net-zoom-area" data-id="${esc(rg.id)}"><i class="bi bi-zoom-in me-1"></i>Zoom</button>
      ${rg.measuredOnly ? '<p class="text-muted">Only device evidence marks this area: devices here are silent or weak although the model expects reception. Check the devices (battery, installation depth, antenna) before planning a gateway.</p>' : ''}
      ${affected ? `<div class="table-responsive"><table class="table table-sm mb-0"><thead><tr><th>Affected device</th><th>Status</th><th class="text-end">RSSI</th></tr></thead><tbody>${affected}</tbody></table></div>` : ''}`);
  }

  _zoomArea(id) {
    const rg = this._areaById?.get(id);
    if (rg && this._map) this._map.fitBounds(rg.bounds, { padding: [60, 60], maxZoom: 17 });
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
      { key: 'id', label: 'Area', val: r => parseInt(r.id.slice(1), 10), html: r => `<strong>${esc(r.id)}</strong>` },
      { key: 'area', label: 'Size (km²)', num: true, val: r => r.areaKm2, html: r => fmtNum(r.areaKm2, 2) },
      { key: 'basis', label: 'Basis', val: r => (r.measuredOnly ? 2 : r.devicesInside ? 1 : 0), html: r => (r.measuredOnly ? '<span class="badge text-bg-warning" title="Devices are silent/weak although the model predicts reception">measured</span>' : r.devicesInside ? '<span class="badge text-bg-danger">model + devices</span>' : '<span class="badge text-bg-secondary">estimate</span>') },
      { key: 'devices', label: 'Devices inside', num: true, val: r => r.devicesInside, html: r => r.devicesInside },
      { key: 'affected', label: 'Silent/weak', num: true, val: r => r.affected.length, html: r => (r.affected.length ? `<strong class="text-danger">${r.affected.length}</strong>` : 0) },
      { key: 'best', label: 'Best pred. RSSI', num: true, val: r => r.bestPredicted, html: r => fmtNum(r.bestPredicted, 0) },
      { key: 'near', label: 'Nearest GW', num: true, val: r => r.nearestGw, html: r => fmtDistance(r.nearestGw) },
      { key: 'where', label: 'Location', val: r => r.point[0], html: r => `<code class="small">${r.point[0].toFixed(5)}, ${r.point[1].toFixed(5)}</code>${r.edge ? ' <i class="bi bi-box-arrow-up-right text-muted" title="Extends to the border of the analysed area"></i>' : ''}` },
    ];
  }

  _rowsForTab() {
    if (this._tab === 'devices') return this._vis.devices;
    if (this._tab === 'gateways') return this._vis.gateways;
    return this._cov ? this._cov.regions : [];
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
    const kind = { devices: 'device', gateways: 'gw', holes: 'area' }[this._tab];
    const idOf = r => (kind === 'gw' ? r.key : r.id);
    const selId = this._selection?.id;
    $('#net-tbody').html(rows.slice(0, NET_MAX_TABLE_ROWS).map(r =>
      `<tr data-kind="${kind}" data-id="${esc(idOf(r))}" class="${idOf(r) === selId ? 'table-active' : ''}">${cols.map(c => `<td class="${c.num ? 'text-end' : ''}">${c.html(r)}</td>`).join('')}</tr>`).join('') ||
      `<tr><td colspan="${cols.length}" class="text-center text-muted py-3">${this._tab === 'holes' ? (this._cov?.gateways ? 'No area without reception found in the analysed area.' : 'Needs at least one located, receiving gateway.') : 'Nothing matches the current filters.'}</td></tr>`);
    let foot;
    if (this._tab === 'holes' && this._cov) {
      const g = this._cov.model.global;
      const fit = g.fitted === 'full' ? `fitted from ${g.samples} links` : (g.fitted === 'intercept' ? `level fitted from ${g.samples} links, exponent assumed` : 'default model – too few located links');
      foot = `Contiguous cells without reception (${fmtDistance(this._cov.cellMeters)} grid). Path-loss model: RSSI@1 km ${fmtNum(g.r1k, 0)} dBm, n = ${fmtNum(g.n)} (${fit}${g.residual != null ? `, scatter ±${fmtNum(g.residual)} dB` : ''}). Click a row to show the area.`;
    } else foot = rows.length > NET_MAX_TABLE_ROWS ? `Showing ${NET_MAX_TABLE_ROWS} of ${rows.length} rows – use the filters or export CSV.` : `${rows.length} row(s)`;
    $('#net-table-foot').html(foot);
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

  _exportAreas() {
    if (!this._cov) return;
    const rows = [['area', 'size_km2', 'cells', 'basis', 'devices_inside', 'silent_or_weak', 'best_predicted_rssi', 'nearest_gateway_m', 'lat', 'lng', 'south', 'west', 'north', 'east', 'extends_to_border', 'affected_devices']];
    this._cov.regions.forEach(r => rows.push([r.id, r.areaKm2.toFixed(3), r.size, r.measuredOnly ? 'measured' : (r.devicesInside ? 'model+devices' : 'estimate'), r.devicesInside, r.affected.length,
      r.bestPredicted.toFixed(1), r.nearestGw.toFixed(0), r.point[0].toFixed(6), r.point[1].toFixed(6), r.bounds[0][0].toFixed(6), r.bounds[0][1].toFixed(6), r.bounds[1][0].toFixed(6), r.bounds[1][1].toFixed(6), r.edge, r.affected.map(d => d.name).join('; ')]));
    downloadFile(`elmo-no-reception-areas-${this._fileStamp()}.csv`, toCsv(rows), 'text/csv');
  }

  _exportCells() {
    if (!this._cov) return;
    const rows = [['lat', 'lng', 'class', 'predicted_class', 'best_predicted_rssi', 'second_predicted_rssi', 'best_gateway', 'nearest_gateway_m', 'devices', 'area']];
    this._cov.cells.forEach(c => rows.push([c.center[0].toFixed(6), c.center[1].toFixed(6), c.cls, c.predicted, c.best.toFixed(1), Number.isFinite(c.second) ? c.second.toFixed(1) : '',
      c.bestGw ? netGwLabel(c.bestGw) : '', c.nearestGw.toFixed(0), c.measured ? c.measured.devices.length : 0, c.region || '']));
    downloadFile(`elmo-reception-grid-${this._fileStamp()}.csv`, toCsv(rows), 'text/csv');
  }
}
