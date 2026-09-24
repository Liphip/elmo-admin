'use strict';

class ConfigView {
  constructor(api, toast) {
    this._api = api; this._toast = toast;
    this._loadStorage();
    this._bind();
  }
  _loadStorage() {
    try {
      const cfg = JSON.parse(localStorage.getItem('deviceAdminConfig') || 'null');
      if (cfg?.elementDomain) { $('#cfg-domain').val(cfg.elementDomain); this._api.domain = cfg.elementDomain.replace(/\/$/, ''); }
      if (cfg?.apiKey)        { $('#cfg-apikey').val(cfg.apiKey);        this._api.apiKey = cfg.apiKey; }
      if (cfg) $('#cfg-remember').prop('checked', true);
    } catch {}
    try {
      const settings = JSON.parse(localStorage.getItem('deviceAdminSettings') || 'null');
      if (settings?.maxLogEntries) $('#cfg-max-log-entries').val(settings.maxLogEntries);
      if (settings?.maxDevices) $('#cfg-max-devices').val(settings.maxDevices);
      if (settings?.tileUrl !== undefined) $('#cfg-tile-url').val(settings.tileUrl);
      else $('#cfg-tile-url').val(NET_DEFAULT_TILES.url);
      $('#cfg-tile-attr').val(settings?.tileAttribution ?? NET_DEFAULT_TILES.attribution);
      $('#cfg-tiles-enabled').prop('checked', settings?.externalTiles === true);
    } catch {}
  }
  _bind() {
    $('#cfg-save').on('click', () => this._save());
    $('#cfg-test').on('click', () => this._test());
    $('#cfg-clear').on('click', () => this._clear());
    $('#cfg-toggle-key').on('click', () => {
      const inp = document.getElementById('cfg-apikey');
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      $('#cfg-toggle-key i').toggleClass('bi-eye', !show).toggleClass('bi-eye-slash', show);
    });
  }
  _save() {
    const domain = $('#cfg-domain').val().trim(), key = $('#cfg-apikey').val().trim();
    if (!domain || !key) { this._toast.show('Fill in domain and API key', 'warning'); return; }
    if (!/^https?:\/\//.test(domain)) { this._toast.show('Domain must start with http:// or https://', 'warning'); return; }
    this._api.domain = domain.replace(/\/$/, ''); this._api.apiKey = key;
    if ($('#cfg-remember').prop('checked')) {
      localStorage.setItem('deviceAdminConfig', JSON.stringify({ elementDomain: domain, apiKey: key }));
    } else {
      localStorage.removeItem('deviceAdminConfig');
    }
    const maxEntries = parseInt($('#cfg-max-log-entries').val()) || 500;
    const maxDevices = parseInt($('#cfg-max-devices').val()) || 500;
    const tileUrl = $('#cfg-tile-url').val().trim();
    if (tileUrl && !/^https:\/\/.+\{z\}.*\{x\}.*\{y\}/.test(tileUrl)) { this._toast.show('Tile URL must use https:// and contain {z}, {x} and {y}', 'warning'); return; }
    window._app._apiLogger.setMaxEntries(maxEntries);
    window._app._devV.setMaxDevices(maxDevices);
    localStorage.setItem('deviceAdminSettings', JSON.stringify({ maxLogEntries: maxEntries, maxDevices: maxDevices, tileUrl, tileAttribution: $('#cfg-tile-attr').val().trim(), externalTiles: $('#cfg-tiles-enabled').prop('checked') }));
    window._app._netV.applyTileSettings();
    this._toast.show('Configuration and settings saved', 'success');
    window._app._init();
  }
  _clear() {
    localStorage.removeItem('deviceAdminConfig');
    $('#cfg-domain, #cfg-apikey').val('');
    this._api.domain = ''; this._api.apiKey = '';
    this._setStatus(null); this._setDot(false, 'Not connected');
    this._toast.show('Configuration cleared', 'info');
  }
  async _test() {
    const domain = $('#cfg-domain').val().trim(), key = $('#cfg-apikey').val().trim();
    if (!domain || !key) { this._toast.show('Fill in domain and API key first', 'warning'); return; }
    this._api.domain = domain.replace(/\/$/, ''); this._api.apiKey = key;
    const btn = document.getElementById('cfg-test');
    btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Testing…';
    try {
      const r = await this._api.testConnection();
      this._setStatus(true, `Connected — ${r}`); this._setDot(true, r);
      window._app._init();
    } catch(e) {
      this._setStatus(false, e.message);
      this._setDot(false);
      if (e.message.includes('CORS')) $('#cors-hint').removeClass('d-none');
    }
    btn.disabled = false; btn.innerHTML = '<i class="bi bi-plug me-1"></i>Test Connection';
  }
  _setStatus(ok, msg) {
    const el = document.getElementById('cfg-status');
    if (ok === null) { el.style.display = 'none'; return; }
    el.style.display = 'block'; el.className = `alert alert-${ok ? 'success' : 'danger'} py-2`;
    el.textContent = msg;
  }
  _setDot(ok, label) {
    const dot = document.getElementById('conn-dot'), lbl = document.getElementById('conn-label');
    dot.className = ok ? 'ok' : 'err';
    lbl.textContent = label || (ok ? 'Connected' : 'Error');
  }
  setConnected(lbl) { this._setDot(true, lbl); }
  setDisconnected()  { this._setDot(false, 'Not connected'); }
  setStatus(ok, msg) { this._setStatus(ok, msg); }
}

class DeviceView {
  constructor(api, state, toast, lb, detail, bulkModal) {
    this._api = api; this._state = state; this._toast = toast;
    this._lb = lb; this._detail = detail; this._bm = bulkModal;
    this._filtered = []; this._selected = new Set();
    this._sortCol = 'name'; this._sortDir = 'asc';
    this._filterTimer = null; this._regexSearch = false;
    this._page = 1;
    this._pageSize = 50;
    this._cursor = null;
    this._hasMore = false;
    this._loading = false;
    this._maxDevices = 500;
    this._bulkProfileModal = bootstrap.Modal.getOrCreateInstance(document.getElementById('bulk-profile-modal'));
    this._folderMs = new MultiSelect('#dev-filter-folder', { placeholder: 'All folders' });
    this._mandateMs = new MultiSelect('#dev-filter-mandate', { placeholder: 'All mandates' });
    this._folderMs.onChange(() => this._filter());
    this._mandateMs.onChange(() => this._filter());
    this._loadMaxDevices();
    this._bind();
  }
  _loadMaxDevices() {
    try {
      const settings = JSON.parse(localStorage.getItem('deviceAdminSettings') || '{}');
      if (settings.maxDevices) this._maxDevices = settings.maxDevices;
    } catch {}
  }
  setMaxDevices(n) {
    this._maxDevices = Math.max(100, Math.min(20000, parseInt(n) || 500));
  }
  _bind() {
    $('#dev-load-all').on('click', () => this.loadAll());
    $('#dev-refresh').on('click', () => this.loadAll());
    $('#dev-export').on('click', () => this._exportCsv());
    $('#dev-stats').on('click', () => this.showStats());
    $('#dev-sel-all').on('change', e => this._selectAll(e.target.checked));
    $('#dev-filter-name').on('input', () => { clearTimeout(this._filterTimer); this._filterTimer = setTimeout(() => this._filter(), 300); });
    $('#dev-filter-type, #dev-filter-location, #dev-filter-activity').on('change', () => this._filter());
    $('#dev-filter-apply').on('click', () => this._filter());
    $('#dev-filter-regex').on('click', () => {
      this._regexSearch = !this._regexSearch;
      $('#dev-filter-regex').toggleClass('active', this._regexSearch);
      this._filter();
    });
    $('#dev-filter-reset').on('click', () => {
      $('#dev-filter-name').val('');
      $('#dev-filter-type, #dev-filter-location, #dev-filter-activity').val('');
      this._folderMs.values = []; this._mandateMs.values = [];
      this._regexSearch = false;
      $('#dev-filter-regex').removeClass('active');
      this._filter();
    });
    $('#dev-page-size').on('change', () => {
      this._pageSize = parseInt($('#dev-page-size').val()) || 50;
      this._page = 1;
      this._renderTable();
    });
    $('#dev-page-prev').on('click', () => { if (this._page > 1) { this._page--; this._renderTable(); } });
    $('#dev-page-next').on('click', () => { if (this._page < this._pageCount()) { this._page++; this._renderTable(); } });
    $('#dev-load-more').on('click', () => this._loadMore());
    $('#dev-clear').on('click', () => this._clearDevices());
    $('#bulk-add-folder').on('click', () => this._bulkAddFolder());
    $('#bulk-rem-folder').on('click', () => this._bulkRemFolder());
    $('#bulk-send-action').on('click', () => this._openBulkActionModal());
    $('#bulk-edit-profile').on('click', () => this._openBulkProfileModal());
    $('#bulk-delete').on('click', () => this._bulkDelete());
    $('#bulk-clear').on('click', () => this._clearSel());
    $('#bpe-profile-sel').on('change', () => this._renderBulkProfileFields());
    $('input[name="bpe-mode"]').on('change', () => this._renderBulkProfileFields());
    $('#bpe-apply').on('click', () => this._applyBulkProfileEdit());
    $('#devices-tbody').on('change', '.dev-cb', e => {
      const id = $(e.currentTarget).data('id');
      e.target.checked ? this._selected.add(id) : this._selected.delete(id);
      this._updateBar();
    });
    $('#devices-tbody').on('click', '.dev-open', e => { e.preventDefault(); this._detail.open($(e.currentTarget).data('id')); });
    $('th.sortable').on('click', e => {
      const col = $(e.currentTarget).data('col');
      if (this._sortCol === col) this._sortDir = this._sortDir === 'asc' ? 'desc' : 'asc';
      else { this._sortCol = col; this._sortDir = 'asc'; }
      this._filter();
    });
  }

  populateFolderDropdowns() {
    const opts = this._state.tags.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
    this._folderMs.setOptions(this._state.tags.map(t => ({ value: t.id, label: t.name })));
    $('#bulk-add-folder-sel, #bulk-rem-folder-sel').html('<option value="">Select folder…</option>' + opts);
  }

  populateMandateDropdown() {
    const ids = this._state.mandates.length ? this._state.mandates.map(m => m.id) : [...new Set(this._state.tags.map(t => t.mandate_id).filter(Boolean))];
    this._mandateMs.setOptions(ids.map(id => ({ value: id, label: this._state.mandateMap[id]?.name || `Mandate ${shortId(id)}` })));
    $('#dev-filter-mandate-wrap').toggleClass('d-none', ids.length <= 1);
  }

  populateProfileDropdown() {
    const opts = this._state.profiles.map(p => `<option value="${p.id}">${esc(p.name || p.slug || shortId(p.id))}</option>`).join('');
    $('#bpe-profile-sel').html('<option value="">Select profile…</option>' + opts);
  }

  // Loads devices page by page (100 per request) up to the configured in-memory limit.
  async loadAll() {
    if (!this._api.apiKey) { this._toast.show('Configure API credentials first', 'warning'); return; }
    if (this._loading) return;
    this._cursor = null;
    this._hasMore = false;
    $('#dev-not-loaded').addClass('d-none');
    const devices = await this._fetchChunk(this._maxDevices, []);
    if (devices) this._toast.show(`Loaded ${devices.length} device${devices.length === 1 ? '' : 's'}`, 'success');
    else if (!this._state.isLoaded.devices) $('#dev-not-loaded').removeClass('d-none');
  }

  async _loadMore() {
    if (!this._cursor || this._loading) return;
    await this._fetchChunk(this._maxDevices, this._state.devices);
  }

  async _fetchChunk(max, existing) {
    this._loading = true;
    this._lb.start();
    $('#dev-load-all, #dev-refresh, #dev-load-more').prop('disabled', true);
    try {
      const all = [...existing];
      let cursor = this._cursor;
      let loaded = 0;
      do {
        // Profile data is loaded on demand (detail panel, bulk profile edit) – keeps the list light.
        const params = { limit: 100, sort: 'inserted_at', sort_direction: 'ascending' };
        if (cursor) params.retrieve_after = cursor;
        const data = await this._api.get('/devices', params);
        const body = Array.isArray(data.body) ? data.body : [];
        all.push(...body); loaded += body.length;
        cursor = body.length >= 100 ? (data.retrieve_after_id || null) : null;
        this._lb.setProgress(Math.min(95, loaded / max * 100), `Loading devices… ${all.length}`);
      } while (cursor && loaded < max);
      this._cursor = cursor;
      this._hasMore = !!cursor;
      this._state.setDevices(all);
      this._state.devicesLoadedAt = Date.now();
      window._app?._tagV.render();
      window._app?._manV.render();
      $('#device-count').text(all.length + (this._hasMore ? '+' : ''));
      window._app?._actV._renderDeviceChooser();
      $('#dev-table-wrap').removeClass('d-none');
      $('#dev-not-loaded').addClass('d-none');
      $('#dev-clear').removeClass('d-none');
      this._page = 1;
      this._filter();
      return all;
    } catch (e) {
      this._toast.show(`Failed to load devices: ${e.message}`, 'danger');
      return null;
    } finally {
      this._loading = false;
      this._lb.finish();
      $('#dev-load-all, #dev-refresh, #dev-load-more').prop('disabled', false);
    }
  }

  _pageCount() { return Math.max(1, Math.ceil(this._filtered.length / this._pageSize)); }

  _updatePagination() {
    const total = this._filtered.length, pages = this._pageCount();
    if (this._page > pages) this._page = pages;
    const from = total ? (this._page - 1) * this._pageSize + 1 : 0, to = Math.min(this._page * this._pageSize, total);
    let info = `${from}–${to} of ${total}${total !== this._state.devices.length ? ` (filtered from ${this._state.devices.length})` : ''} · page ${this._page}/${pages}`;
    if (this._hasMore) info += ` · limit of ${this._maxDevices} reached`;
    $('#dev-page-info').text(info);
    $('#dev-page-prev').prop('disabled', this._page <= 1);
    $('#dev-page-next').prop('disabled', this._page >= pages);
    $('#dev-load-more').toggleClass('d-none', !this._hasMore).text(`Load ${this._maxDevices} more`);
  }

  _clearDevices() {
    this._state.setDevices([]);
    this._filtered = [];
    this._selected.clear();
    this._cursor = null;
    this._hasMore = false;
    this._page = 1;
    this._state.isLoaded.devices = false;
    this._updateBar();
    $('#device-count').text('0');
    $('#dev-table-wrap').addClass('d-none');
    $('#dev-not-loaded').removeClass('d-none');
    $('#dev-clear').addClass('d-none');
    $('#dev-page-info').text('');
    this._toast.show('Device list cleared from memory', 'info');
  }

  _exportCsv() {
    const list = this._filtered.length ? this._filtered : this._state.devices;
    if (!list.length) { this._toast.show('Load devices first', 'warning'); return; }
    const rows = [['id', 'name', 'slug', 'kind', 'mandate', 'folders', 'latitude', 'longitude', 'eui', 'last_uplink', 'avg_rssi', 'avg_snr', 'avg_gateways', 'created', 'updated']];
    list.forEach(d => {
      const ll = NetAnalysis.deviceLatLng(d);
      const euis = (d.interfaces || []).flatMap(i => Object.entries(i.opts || {}).filter(([k, v]) => /eui/i.test(k) && v).map(([, v]) => v));
      const gw = NetAnalysis.isGatewayDevice(d);
      rows.push([d.id, d.name, d.slug, gw ? 'gateway' : (d.type || 'device'), this._state.mandateMap[d.mandate_id]?.name || d.mandate_id, (d.tags || []).map(t => t.name).join('; '),
        ll?.[0], ll?.[1], [...new Set(euis)].join('; '), gw ? NetAnalysis.gatewayLastPing(d) : d.stats?.transceived_at, d.stats?.avg_rssi, d.stats?.avg_snr, d.stats?.avg_gw_count, d.inserted_at, d.updated_at]);
    });
    downloadFile(`elmo-devices-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows), 'text/csv');
  }

  _filter() {
    const q = $('#dev-filter-name').val() || '';
    const type = $('#dev-filter-type').val(), fids = this._folderMs.values, mandateIds = this._mandateMs.values;
    const loc = $('#dev-filter-location').val();
    const matcher = buildSearchMatcher(q, this._regexSearch);
    let list = this._state.devices;
    if (q)    list = list.filter(d => matcher(d.name) || matcher(d.slug) || matcher(d.id) ||
      (d.interfaces || []).some(i => Object.entries(i.opts || {}).some(([k, v]) => /eui|address/i.test(k) && typeof v === 'string' && v && matcher(v))));
    if (loc)  list = list.filter(d => !!NetAnalysis.deviceLatLng(d) === (loc === 'with'));
    const act = $('#dev-filter-activity').val();
    if (act) {
      const now = Date.now(), H = 3600e3;
      const ageOk = { '24h': a => a != null && a < 24 * H, '7d': a => a != null && a < 168 * H, silent1: a => a == null || a >= 24 * H, silent7: a => a == null || a >= 168 * H, never: a => a == null }[act];
      list = list.filter(d => {
        if (NetAnalysis.isGatewayDevice(d)) return false;
        const t = NetAnalysis.tsMs(d.stats?.transceived_at);
        return ageOk(t == null ? null : now - t);
      });
    }
    if (type) list = list.filter(d => NetAnalysis.isGatewayDevice(d) === (type === 'gateway'));
    if (fids.length) list = list.filter(d => Array.isArray(d.tags) && d.tags.some(t => fids.includes(t.id)));
    if (mandateIds.length) list = list.filter(d => mandateIds.includes(d.mandate_id));
    const dir = this._sortDir === 'asc' ? 1 : -1;
    const col = this._sortCol;
    const key = col === 'last_uplink' ? d => String(NetAnalysis.isGatewayDevice(d) ? (NetAnalysis.gatewayLastPing(d) || '') : (d.stats?.transceived_at || ''))
      : d => String(d[col] || '').toLowerCase();
    list = [...list].sort((a,b) => (key(a) < key(b) ? -dir : key(a) > key(b) ? dir : 0));
    this._filtered = list;
    this._page = 1;
    $('#dev-filter-count').text(list.length !== this._state.devices.length ? `${list.length} of ${this._state.devices.length} shown` : '');
    this._renderTable();
  }

  _renderTable() {
    this._updatePagination();
    const start = (this._page - 1) * this._pageSize;
    const rows = this._filtered.slice(start, start + this._pageSize).map(d => {
      const tags = (d.tags||[]).slice(0,3).map(t => {
        const c = this._state.tagMap[t.id]?.color_hue != null ? hueToHex(this._state.tagMap[t.id].color_hue) : '#6c757d';
        return `<span class="badge tag-badge-item me-1" style="background:${c};color:#fff">${esc(t.name)}</span>`;
      }).join('') + ((d.tags||[]).length > 3 ? `<small class="text-muted">+${d.tags.length-3}</small>` : '');
      const sel = this._selected.has(d.id) ? 'checked' : '';
      const loc = NetAnalysis.deviceLatLng(d) ? '' : ' <i class="bi bi-geo-alt text-muted opacity-50" title="No location"></i>';
      return `<tr>
        <td><input type="checkbox" class="form-check-input dev-cb" data-id="${d.id}" ${sel}></td>
        <td><a href="#" class="dev-open text-decoration-none" data-id="${d.id}">${esc(d.name||d.slug)}</a>${loc}</td>
        <td class="text-muted small d-none d-md-table-cell">${esc(d.slug)}</td>
        <td>${typeBadge(NetAnalysis.isGatewayDevice(d) ? 'gateway' : (d.type || 'device'))}</td>
        <td>${tags}</td>
        <td class="small d-none d-lg-table-cell">${this._lastUplinkCell(d)}</td>
        <td class="text-muted small d-none d-xl-table-cell">${fmtDate(d.inserted_at)}</td>
        <td>${getMandateLabel(this._state, d.mandate_id)}</td>
        <td><button class="btn btn-sm btn-outline-secondary py-0 dev-open" data-id="${d.id}" title="Details"><i class="bi bi-box-arrow-up-right"></i></button></td>
      </tr>`;
    }).join('');
    document.getElementById('devices-tbody').innerHTML = rows ||
      (this._state.isLoaded.devices ? '<tr><td colspan="9" class="text-center text-muted py-3">No devices match filters.</td></tr>' : '');
    $('th.sortable').each((_, th) => {
      const icon = $(th).find('i');
      if ($(th).data('col') === this._sortCol)
        icon.attr('class', `bi bi-arrow-${this._sortDir === 'asc' ? 'up' : 'down'} small text-primary`);
      else icon.attr('class', 'bi bi-arrow-down-up text-muted small');
    });
  }

  // Last uplink (sensors) or last packet-forwarder ping (gateways) from ELEMENT statistics.
  _lastUplinkCell(d) {
    const gw = NetAnalysis.isGatewayDevice(d);
    const t = gw ? NetAnalysis.gatewayLastPing(d) : d.stats?.transceived_at;
    if (!t) return '<span class="text-muted">—</span>';
    const age = Date.now() - (NetAnalysis.tsMs(t) ?? 0);
    const cls = age > (gw ? 3600e3 : 7 * 86400e3) ? 'text-danger' : age > (gw ? 600e3 : 86400e3) ? 'text-warning-emphasis' : 'text-success';
    const warn = !gw && d.stats?.nominally_sending === false ? ' <i class="bi bi-exclamation-triangle text-warning" title="ELEMENT: not sending nominally"></i>' : '';
    return `<span class="${cls}" title="${esc(fmtDate(t))}${gw ? ' (packet-forwarder ping)' : ''}">${fmtAgo(t)}</span>${warn}`;
  }

  _selectAll(checked) {
    if (checked) this._filtered.forEach(d => this._selected.add(d.id));
    else this._filtered.forEach(d => this._selected.delete(d.id));
    this._renderTable(); this._updateBar();
  }
  _clearSel() { this._selected.clear(); $('#dev-sel-all').prop('checked', false); this._renderTable(); this._updateBar(); }
  _updateBar() {
    const n = this._selected.size;
    n > 0 ? ($('#bulk-action-bar').removeClass('d-none'), $('#bulk-selected-count').text(`${n} selected`)) : $('#bulk-action-bar').addClass('d-none');
  }
  showStats() {
    const devices = this._state.devices;
    if (!devices.length) {
      $('#stats-modal-title').text('Device Statistics');
      $('#stats-modal-body').html('<div class="text-center py-5 text-muted"><i class="bi bi-bar-chart fs-1 d-block mb-3 opacity-25"></i><p>Load data first to see statistics.</p></div>');
      bootstrap.Modal.getOrCreateInstance(document.getElementById('stats-modal')).show();
      return;
    }
    const byType = {};
    const byFolder = {};
    const byMandate = {};
    devices.forEach(d => {
      byType[d.type] = (byType[d.type] || 0) + 1;
      if (d.mandate_id) byMandate[d.mandate_id] = (byMandate[d.mandate_id] || 0) + 1;
      (d.tags || []).forEach(t => { byFolder[t.id] = (byFolder[t.id] || 0) + 1; });
    });
    const typeRows = Object.entries(byType).map(([type, count]) => `<tr><td>${esc(type)}</td><td>${count}</td></tr>`).join('');
    const mandateRows = Object.entries(byMandate).map(([id, count]) => {
      const m = this._state.mandateMap[id];
      return `<tr><td>${esc(m?.name || shortId(id))}</td><td>${count}</td></tr>`;
    }).join('');
    const folderRows = Object.entries(byFolder).map(([id, count]) => {
      const t = this._state.tagMap[id];
      return `<tr><td>${esc(t?.name || shortId(id))}</td><td>${count}</td></tr>`;
    }).join('');
    $('#stats-modal-title').text('Device Statistics');
    $('#stats-modal-body').html(`
      <div class="row g-3">
        <div class="col-md-4">
          <div class="card h-100">
            <div class="card-header">Total Devices</div>
            <div class="card-body text-center">
              <h2 class="mb-0">${devices.length}</h2>
              <small class="text-muted">loaded</small>
            </div>
          </div>
        </div>
        <div class="col-md-8">
          <div class="card h-100">
            <div class="card-header">By Type</div>
            <div class="card-body p-0">
              <table class="table table-sm mb-0"><tbody>${typeRows || '<tr><td class="text-muted">No data</td></tr>'}</tbody></table>
            </div>
          </div>
        </div>
        <div class="col-md-6">
          <div class="card">
            <div class="card-header">By Mandate</div>
            <div class="card-body p-0" style="max-height: 200px; overflow-y: auto;">
              <table class="table table-sm mb-0"><tbody>${mandateRows || '<tr><td class="text-muted">No data</td></tr>'}</tbody></table>
            </div>
          </div>
        </div>
        <div class="col-md-6">
          <div class="card">
            <div class="card-header">By Folder</div>
            <div class="card-body p-0" style="max-height: 200px; overflow-y: auto;">
              <table class="table table-sm mb-0"><tbody>${folderRows || '<tr><td class="text-muted">No data</td></tr>'}</tbody></table>
            </div>
          </div>
        </div>
      </div>
    `);
    bootstrap.Modal.getOrCreateInstance(document.getElementById('stats-modal')).show();
  }
  _getSelDevices() { return [...this._selected].map(id => this._state.deviceMap[id]).filter(Boolean); }

  async _openBulkProfileModal() {
    if (!this._selected.size) return;
    $('#bpe-load-note').addClass('d-none');
    $('#bpe-apply').prop('disabled', false);
    if (!$('#bpe-profile-sel').val() && this._state.profiles[0]) $('#bpe-profile-sel').val(this._state.profiles[0].id);
    $('input[name="bpe-mode"][value="set"]').prop('checked', true);
    // The device list is loaded without profile data; fetch it for the first selected device
    // so its current values can prefill the form.
    this._bpeSample = null;
    document.getElementById('bpe-fields').innerHTML = '<div class="text-muted small"><span class="spinner-border spinner-border-sm me-1"></span>Loading profile data…</div>';
    this._bulkProfileModal.show();
    const first = this._getSelDevices()[0];
    try { this._bpeSample = (await this._api.get(`/devices/${first.id}`, { with_profile: 1 })).body; } catch { /* prefill is optional */ }
    this._renderBulkProfileFields();
  }

  _renderBulkProfileFields() {
    const profile = this._state.profileMap[$('#bpe-profile-sel').val()];
    const mode = $('input[name="bpe-mode"]:checked').val();
    const host = document.getElementById('bpe-fields');
    if (!profile) {
      host.innerHTML = '<div class="text-muted small">Select a profile to edit its fields.</div>';
      return;
    }
    if (mode === 'remove') {
      host.innerHTML = '<div class="text-muted small">This operation removes the selected profile from each chosen device.</div>';
      return;
    }
    const sampleDevice = this._bpeSample || this._getSelDevices()[0];
    const existing = (sampleDevice?.profile_data || []).find(entry => entry.profile_id === profile.id)?.data || {};
    host.innerHTML = renderProfileFieldEditor(profile, existing);
  }

  async _applyBulkProfileEdit() {
    const profileId = $('#bpe-profile-sel').val();
    const profile = this._state.profileMap[profileId];
    const mode = $('input[name="bpe-mode"]:checked').val();
    if (!profile) { this._toast.show('Select a profile first', 'warning'); return; }
    const devices = this._getSelDevices();
    if (!devices.length) { this._toast.show('Select at least one device', 'warning'); return; }
    const data = mode === 'set' ? collectProfileFieldValues(document.getElementById('bpe-fields')) : null;
    this._bulkProfileModal.hide();
    await this._runBulk('Profile edit', devices, async dev => {
      const fresh = (await this._api.get(`/devices/${dev.id}`, { with_profile: 1 })).body;
      const list = Array.isArray(fresh.profile_data) ? [...fresh.profile_data] : [];
      const idx = list.findIndex(entry => entry.profile_id === profileId);
      if (mode === 'remove') {
        if (idx >= 0) list.splice(idx, 1);
      } else {
        const entry = idx >= 0 ? { ...list[idx], data: { ...(list[idx].data || {}), ...data } } : { profile_id: profileId, data };
        if (idx >= 0) list[idx] = entry;
        else list.push(entry);
      }
      const updated = (await this._api.put(`/devices/${dev.id}`, { device: { profile_data: list } })).body;
      this._state.updateDevice(updated);
      return updated;
    });
    this._filter();
  }

  async _bulkAddFolder() {
    const tagId = $('#bulk-add-folder-sel').val(), tag = this._state.tagMap[tagId];
    if (!tagId || !tag) { this._toast.show('Select a folder first', 'warning'); return; }
    await this._runBulk(`Add folder "${tag.name}"`, this._getSelDevices(), async dev => {
      if ((dev.tags||[]).some(t => t.id === tagId)) return dev;
      const data = await this._api.put(`/devices/${dev.id}`, { device: { tags: [...(dev.tags||[]), { id: tagId }] } });
      this._state.updateDevice(data.body); return data.body;
    });
    this._filter();
  }

  async _bulkRemFolder() {
    const tagId = $('#bulk-rem-folder-sel').val(), tag = this._state.tagMap[tagId];
    if (!tagId || !tag) { this._toast.show('Select a folder first', 'warning'); return; }
    await this._runBulk(`Remove folder "${tag.name}"`, this._getSelDevices(), async dev => {
      if (!(dev.tags||[]).some(t => t.id === tagId)) return dev;
      const data = await this._api.put(`/devices/${dev.id}`, { device: { tags: (dev.tags||[]).filter(t => t.id !== tagId) } });
      this._state.updateDevice(data.body); return data.body;
    });
    this._filter();
  }

  _openBulkActionModal() {
    const n = this._selected.size; if (!n) return;
    $('#ba-title').text(`Send Action to ${n} device${n>1?'s':''}`);
    $('#ba-opts').removeClass('is-invalid');
    const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('bulk-action-modal'));
    $('#ba-submit').off('click').on('click', () => { modal.hide(); this._bulkSendAction(); });
    modal.show();
  }

  async _bulkSendAction() {
    const type = $('#ba-type').val().trim();
    if (!type) { this._toast.show('Action type is required', 'warning'); return; }
    let opts = {};
    const raw = $('#ba-opts').val().trim();
    if (raw) {
      try { opts = JSON.parse(raw); }
      catch { this._toast.show('Options: invalid JSON', 'warning'); return; }
    }
    const override = $('#ba-override').prop('checked');
    const cancelAfter = parseInt($('#ba-cancel-after').val()) || undefined;
    await this._runBulk(`Send "${type}"`, this._getSelDevices(), async dev => {
      const body = { type, opts, override, device_id: dev.id };
      if (cancelAfter) body.cancel_after = cancelAfter;
      return (await this._api.post('/actions', body)).body;
    });
  }

  async _bulkDelete() {
    const n = this._selected.size; if (!n) return;
    const ok = await this._confirm(`Delete ${n} device${n>1?'s':''}?`, `Permanently delete ${n} selected device${n>1?'s':''}. Cannot be undone.`);
    if (!ok) return;
    const devs = this._getSelDevices();
    await this._runBulk('Delete devices', devs, async dev => {
      await this._api.delete(`/devices/${dev.id}`);
      this._state.removeDevice(dev.id); this._selected.delete(dev.id);
    });
    this._filter(); this._updateBar();
  }

  _confirm(title, bodyText) {
    return new Promise(resolve => {
      document.getElementById('confirm-title').textContent = title;
      document.getElementById('confirm-body').textContent = bodyText;
      const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('confirm-modal'));
      let confirmed = false;
      document.getElementById('confirm-ok').onclick = () => { confirmed = true; modal.hide(); };
      document.getElementById('confirm-modal').addEventListener('hidden.bs.modal', () => resolve(confirmed), { once: true });
      modal.show();
    });
  }

  async _runBulk(label, devices, fn) {
    this._bm.show(label, devices.length);
    let done = 0;
    const results = await runConcurrent(devices, async dev => {
      try {
        const r = await fn(dev); done++;
        this._bm.update(done, devices.length, dev.name || dev.id, 'ok');
        return r;
      } catch(e) {
        done++;
        this._bm.update(done, devices.length, `${dev.name||dev.id}: ${e.message}`, 'error');
        throw e;
      }
    }, 3);
    this._toast.showBulkResult(label, results.succeeded.length, results.failed.length, results.failed);
  }
}

class TagView {
  constructor(api, state, toast) {
    this._api = api; this._state = state; this._toast = toast;
    this._filtered = []; this._regexSearch = false; this._filterTimer = null;
    this._bind();
  }
  _bind() {
    $('#folder-refresh').on('click', () => this.loadAll());
    $('#folder-stats').on('click', () => this.showStats());
    $('#folder-new').on('click', () => this._openForm(null));
    $('#folder-save').on('click', () => this._save());
    $('#folder-hue').on('input', () => this._updateHue());
    $('#tag-filter-name').on('input', () => { clearTimeout(this._filterTimer); this._filterTimer = setTimeout(() => this.render(), 250); });
    $('#tag-filter-regex').on('click', () => { this._regexSearch = !this._regexSearch; $('#tag-filter-regex').toggleClass('active', this._regexSearch); this.render(); });
    $('#tag-filter-mandate').on('change', () => this.render());
    $('#tag-filter-apply').on('click', () => this.render());
    $('#tag-filter-reset').on('click', () => {
      $('#tag-filter-name, #tag-filter-mandate').val('');
      this._regexSearch = false;
      $('#tag-filter-regex').removeClass('active');
      this.render();
    });
    $('#folders-tbody').on('click', '.folder-edit', e => this._openForm(this._state.tagMap[$(e.currentTarget).data('id')]));
    $('#folders-tbody').on('click', '.folder-del',  e => this._delete($(e.currentTarget).data('id')));
    $('#folders-tbody').on('click', '.folder-devices', e => this._viewDevices($(e.currentTarget).data('id')));
  }
  async loadAll() {
    $('#folders-not-loaded').addClass('d-none');
    $('#folders-loading').removeClass('d-none');
    $('#folders-table-wrap').addClass('d-none');
    try {
      const tags = await this._api.fetchAllPages('/tags', { limit: 100, sort: 'name', sort_direction: 'ascending' });
      this._state.setTags(tags); this.render(); $('#folder-count').text(tags.length);
      $('#folders-loading').addClass('d-none');
      $('#folders-table-wrap').removeClass('d-none');
      window._app?._devV.populateFolderDropdowns();
    } catch(e) { 
      $('#folders-loading').addClass('d-none');
      $('#folders-not-loaded').removeClass('d-none');
      this._toast.show(`Folders: ${e.message}`, 'danger'); 
    }
  }
  populateMandateDropdown() {
    const opts = this._state.mandates.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
    $('#tag-filter-mandate').html('<option value="">All mandates</option>' + opts);
    $('#tag-filter-mandate-wrap').toggleClass('d-none', this._state.mandates.length <= 1);
  }
  render() {
    if (this._state.isLoaded.tags) {
      $('#folders-not-loaded, #folders-loading').addClass('d-none');
      $('#folders-table-wrap').removeClass('d-none');
    }
    const q = $('#tag-filter-name').val() || '';
    const mandateId = $('#tag-filter-mandate').val();
    const matcher = buildSearchMatcher(q, this._regexSearch);
    this._filtered = this._state.tags.filter(t => {
      if (q && !(matcher(t.name) || matcher(t.slug))) return false;
      if (mandateId && t.mandate_id !== mandateId) return false;
      return true;
    });
    $('#tag-filter-count').text(this._filtered.length !== this._state.tags.length ? `${this._filtered.length} shown` : '');
    const counts = new Map();
    this._state.devices.forEach(d => (d.tags || []).forEach(t => counts.set(t.id, (counts.get(t.id) || 0) + 1)));
    const loaded = this._state.isLoaded.devices;
    const rows = this._filtered.map(t => {
      const c = t.color_hue != null ? hueToHex(t.color_hue) : '#6c757d';
      return `<tr>
        <td>${esc(t.name)}</td>
        <td><span class="tag-swatch" style="background:${c}" title="Hue ${t.color_hue}"></span></td>
        <td class="text-end">${loaded ? (counts.get(t.id) || 0) : '<span class="text-muted">—</span>'}</td>
        <td><code class="small">${esc(t.slug)}</code></td>
        <td class="text-muted small">${fmtDate(t.inserted_at)}</td>
        <td>${getMandateLabel(this._state, t.mandate_id)}</td>
        <td class="text-end">
          <button class="btn btn-sm btn-outline-primary py-0 folder-devices" data-id="${t.id}"><i class="bi bi-device-hdd"></i> Devices</button>
          <button class="btn btn-sm btn-outline-secondary py-0 folder-edit" data-id="${t.id}"><i class="bi bi-pencil"></i></button>
          <button class="btn btn-sm btn-outline-danger py-0 folder-del ms-1" data-id="${t.id}"><i class="bi bi-trash"></i></button>
        </td></tr>`;
    }).join('');
    document.getElementById('folders-tbody').innerHTML = rows ||
      '<tr><td colspan="7" class="text-center text-muted py-3">No folders found.</td></tr>';
  }
  showStats() {
    const tags = this._state.tags;
    if (!tags.length) {
      $('#stats-modal-title').text('Folder Statistics');
      $('#stats-modal-body').html('<div class="text-center py-5 text-muted"><i class="bi bi-bar-chart fs-1 d-block mb-3 opacity-25"></i><p>Load data first to see statistics.</p></div>');
      bootstrap.Modal.getOrCreateInstance(document.getElementById('stats-modal')).show();
      return;
    }
    const withDevices = tags.filter(t => {
      return this._state.devices.some(d => (d.tags || []).some(dt => dt.id === t.id));
    }).length;
    const byMandate = {};
    tags.forEach(t => {
      if (t.mandate_id) byMandate[t.mandate_id] = (byMandate[t.mandate_id] || 0) + 1;
    });
    const mandateRows = Object.entries(byMandate).map(([id, count]) => {
      const m = this._state.mandateMap[id];
      return `<tr><td>${esc(m?.name || shortId(id))}</td><td>${count}</td></tr>`;
    }).join('');
    $('#stats-modal-title').text('Folder Statistics');
    $('#stats-modal-body').html(`
      <div class="row g-3">
        <div class="col-md-4">
          <div class="card h-100">
            <div class="card-header">Total Folders</div>
            <div class="card-body text-center">
              <h2 class="mb-0">${tags.length}</h2>
            </div>
          </div>
        </div>
        <div class="col-md-4">
          <div class="card h-100">
            <div class="card-header">With Devices</div>
            <div class="card-body text-center">
              <h2 class="mb-0">${withDevices}</h2>
            </div>
          </div>
        </div>
        <div class="col-md-4">
          <div class="card h-100">
            <div class="card-header">Without Devices</div>
            <div class="card-body text-center">
              <h2 class="mb-0">${tags.length - withDevices}</h2>
            </div>
          </div>
        </div>
        <div class="col-12">
          <div class="card">
            <div class="card-header">By Mandate</div>
            <div class="card-body p-0" style="max-height: 200px; overflow-y: auto;">
              <table class="table table-sm mb-0"><tbody>${mandateRows || '<tr><td class="text-muted">No data</td></tr>'}</tbody></table>
            </div>
          </div>
        </div>
      </div>
    `);
    bootstrap.Modal.getOrCreateInstance(document.getElementById('stats-modal')).show();
  }
  _openForm(tag) {
    $('#folder-edit-id').val(tag?.id || '');
    $('#folder-modal-title').text(tag ? 'Edit Folder' : 'New Folder');
    $('#folder-name').val(tag?.name || '');
    $('#folder-hue').val(tag?.color_hue ?? 200);
    $('#folder-desc').val(tag?.description || '');
    this._updateHue();
    bootstrap.Modal.getOrCreateInstance(document.getElementById('folder-modal')).show();
  }
  _updateHue() { document.getElementById('hue-preview').style.background = hueToHex(parseInt($('#folder-hue').val()) || 0); }
  async _save() {
    const id = $('#folder-edit-id').val(), name = $('#folder-name').val().trim();
    if (!name) { this._toast.show('Name is required', 'warning'); return; }
    const hue = parseInt($('#folder-hue').val()) || 0, desc = $('#folder-desc').val().trim();
    try {
      const body = { tag: { name, color_hue: hue, ...(desc ? { description: desc } : {}) } };
      const data = id ? await this._api.put(`/tags/${id}`, body) : await this._api.post('/tags', body);
      this._state.updateTag(data.body); this.render();
      $('#folder-count').text(this._state.tags.length);
      window._app?._devV.populateFolderDropdowns();
      window._app?._netV.populateFolderDropdown();
      bootstrap.Modal.getInstance(document.getElementById('folder-modal')).hide();
      this._toast.show(`Folder "${name}" ${id ? 'updated' : 'created'}`, 'success');
    } catch(e) { this._toast.show(`Save failed: ${e.message}`, 'danger'); }
  }
  async _delete(id) {
    const tag = this._state.tagMap[id]; if (!tag) return;
    if (!confirm(`Delete folder "${tag.name}"?`)) return;
    try {
      await this._api.delete(`/tags/${id}`);
      this._state.removeTag(id); this.render(); $('#folder-count').text(this._state.tags.length);
      window._app?._devV.populateFolderDropdowns();
      this._toast.show('Folder deleted', 'success');
    } catch(e) { this._toast.show(`Delete failed: ${e.message}`, 'danger'); }
  }
  _viewDevices(id) {
    window._app._devV._folderMs.values = [id];
    window._app.navigateTo('devices');
    window._app._devV._filter();
  }
}

class MandateView {
  constructor(api, state, toast) { 
    this._api = api; this._state = state; this._toast = toast; 
    $('#mandates-load').on('click', () => this.loadAll());
    $('#mandates-stats').on('click', () => this.showStats());
  }
  async loadAll() {
    $('#mandates-not-loaded').addClass('d-none');
    $('#mandates-loading').removeClass('d-none');
    $('#mandates-container').addClass('d-none');
    try {
      const ms = await this._api.fetchAllPages('/mandates', { limit: 100 });
      this._state.setMandates(ms); 
      $('#mandates-loading').addClass('d-none');
      $('#mandates-container').removeClass('d-none');
      this._render();
    } catch(e) { 
      $('#mandates-loading').addClass('d-none');
      $('#mandates-not-loaded').removeClass('d-none');
      this._toast.show(`Mandates: ${e.message}`, 'danger'); 
    }
  }
  render() {
    if (!this._state.isLoaded.mandates) return;
    $('#mandates-not-loaded, #mandates-loading').addClass('d-none');
    $('#mandates-container').removeClass('d-none');
    this._render();
  }
  _render() {
    const c = document.getElementById('mandates-container');
    if (!this._state.mandates.length) { c.innerHTML = '<div class="col-12 text-muted">No mandates visible with this API key.</div>'; return; }
    const devCount = new Map(), gwCount = new Map(), tagCount = new Map();
    this._state.devices.forEach(d => (NetAnalysis.isGatewayDevice(d) ? gwCount : devCount).set(d.mandate_id, ((NetAnalysis.isGatewayDevice(d) ? gwCount : devCount).get(d.mandate_id) || 0) + 1));
    this._state.tags.forEach(t => tagCount.set(t.mandate_id, (tagCount.get(t.mandate_id) || 0) + 1));
    const loaded = this._state.isLoaded.devices;
    c.innerHTML = this._state.mandates.map(m => `
      <div class="col-md-6 col-lg-4"><div class="card h-100"><div class="card-body">
        <h6 class="card-title">${esc(m.name)}</h6>
        <span class="badge bg-secondary">${esc(m.slug)}</span>
        <div class="d-flex gap-3 small text-muted mt-2">
          <span title="Devices (loaded list)"><i class="bi bi-cpu me-1"></i>${loaded ? devCount.get(m.id) || 0 : '—'}</span>
          <span title="Gateways (loaded list)"><i class="bi bi-broadcast-pin me-1"></i>${loaded ? gwCount.get(m.id) || 0 : '—'}</span>
          <span title="Folders"><i class="bi bi-folder me-1"></i>${tagCount.get(m.id) || 0}</span>
        </div>
        <div class="input-group input-group-sm mt-2">
          <input type="text" class="form-control font-monospace" value="${esc(m.id)}" readonly>
          <button class="btn btn-outline-secondary copy-id" data-val="${esc(m.id)}" title="Copy ID"><i class="bi bi-clipboard"></i></button>
        </div>
      </div></div></div>`).join('');
    c.querySelectorAll('.copy-id').forEach(btn =>
      btn.addEventListener('click', () => navigator.clipboard.writeText(btn.dataset.val).then(() => this._toast.show('ID copied', 'info'))));
    $('#mandate-count').text(this._state.mandates.length);
  }
  showStats() {
    const mandates = this._state.mandates;
    if (!mandates.length) {
      $('#stats-modal-title').text('Mandate Statistics');
      $('#stats-modal-body').html('<div class="text-center py-5 text-muted"><i class="bi bi-bar-chart fs-1 d-block mb-3 opacity-25"></i><p>Load data first to see statistics.</p></div>');
      bootstrap.Modal.getOrCreateInstance(document.getElementById('stats-modal')).show();
      return;
    }
    const devices = this._state.devices;
    const tags = this._state.tags;
    const byMandate = {};
    mandates.forEach(m => { byMandate[m.id] = { name: m.name, devices: 0, folders: new Set() }; });
    devices.forEach(d => {
      if (d.mandate_id && byMandate[d.mandate_id]) byMandate[d.mandate_id].devices++;
    });
    tags.forEach(t => {
      if (t.mandate_id && byMandate[t.mandate_id]) byMandate[t.mandate_id].folders.add(t.id);
    });
    const rows = Object.entries(byMandate).map(([id, data]) => {
      return `<tr><td>${esc(data.name)}</td><td>${data.devices}</td><td>${data.folders.size}</td></tr>`;
    }).join('');
    $('#stats-modal-title').text('Mandate Statistics');
    $('#stats-modal-body').html(`
      <div class="row g-3">
        <div class="col-md-4">
          <div class="card h-100">
            <div class="card-header">Total Mandates</div>
            <div class="card-body text-center">
              <h2 class="mb-0">${mandates.length}</h2>
            </div>
          </div>
        </div>
        <div class="col-md-4">
          <div class="card h-100">
            <div class="card-header">Total Devices</div>
            <div class="card-body text-center">
              <h2 class="mb-0">${devices.length}</h2>
              <small class="text-muted">loaded</small>
            </div>
          </div>
        </div>
        <div class="col-md-4">
          <div class="card h-100">
            <div class="card-header">Total Folders</div>
            <div class="card-body text-center">
              <h2 class="mb-0">${tags.length}</h2>
            </div>
          </div>
        </div>
        <div class="col-12">
          <div class="card">
            <div class="card-header">By Mandate</div>
            <div class="card-body p-0" style="max-height: 300px; overflow-y: auto;">
              <table class="table table-sm mb-0"><thead><tr><th>Mandate</th><th>Devices</th><th>Folders</th></tr></thead><tbody>${rows}</tbody></table>
            </div>
          </div>
        </div>
      </div>
    `);
    bootstrap.Modal.getOrCreateInstance(document.getElementById('stats-modal')).show();
  }
}

class ActionsView {
  constructor(api, state, toast, bulkModal) {
    this._api = api; this._state = state; this._toast = toast;
    this._cursor = null;
    this._recentActions = [];
    this._schedules = [];
    this._selectedActions = new Set();
    this._selectedSchedules = new Set();
    this._selectedCreateDevices = new Set();
    this._bm = bulkModal;
    this._bind();
  }
  _bind() {
    $('#actions-nav a').on('click', e => {
      e.preventDefault();
      const tab = $(e.currentTarget).data('atab');
      $('#actions-nav a').removeClass('active'); $(e.currentTarget).addClass('active');
      $('#actions-recent-pane, #actions-schedules-pane, #actions-create-pane').addClass('d-none');
      $(`#actions-${tab}-pane`).removeClass('d-none');
      if (tab === 'create') this._renderDeviceChooser();
    });
    $('#actions-load').on('click', () => { this._cursor = null; this.loadRecent(false); });
    $('#actions-more-btn').on('click', () => this.loadRecent(true));
    $('#schedules-load').on('click', () => this.loadSchedules());
    $('#actions-state-filter').on('change', () => this.loadRecent(false));
    $('#actions-sel-all').on('change', e => this._toggleAllActions(e.target.checked));
    $('#sched-sel-all').on('change', e => this._toggleAllSchedules(e.target.checked));
    $('#actions-clear-selection').on('click', () => { this._selectedActions.clear(); this._renderRecentTable(); });
    $('#schedules-clear-selection').on('click', () => { this._selectedSchedules.clear(); this._renderSchedulesTable(); });
    $('#actions-cancel-selected').on('click', () => this._cancelSelected());
    $('#schedules-delete-selected').on('click', () => this._deleteSelectedSchedules());
    $('#act-dev-search').on('input', () => { clearTimeout(this._chooserTimer); this._chooserTimer = setTimeout(() => this._renderDeviceChooser(), 200); });
    $('#act-dev-all').on('click', () => this._selectVisibleCreateDevices(true));
    $('#act-dev-clear').on('click', () => this._selectVisibleCreateDevices(false));
    $('input[name="act-create-timing"]').on('change', () => this._syncTimingMode());
    $('#act-create-submit').on('click', () => this._createBulkActions());
    $('#actions-tbody').on('click', '.act-cancel', async e => {
      const id = $(e.currentTarget).data('id');
      try { await this._api.post(`/actions/${id}/cancel`, { body: { id, state: 'cancelled' } }); this._toast.show('Cancelled', 'success'); this._cursor = null; this.loadRecent(false); }
      catch(err) { this._toast.show(`Cancel failed: ${err.message}`, 'danger'); }
    });
    $('#actions-tbody').on('change', '.act-cb', e => {
      const id = $(e.currentTarget).data('id');
      e.target.checked ? this._selectedActions.add(id) : this._selectedActions.delete(id);
      this._updateActionBulkBar();
    });
    $('#schedules-tbody').on('change', '.sched-cb', e => {
      const id = $(e.currentTarget).data('id');
      e.target.checked ? this._selectedSchedules.add(id) : this._selectedSchedules.delete(id);
      this._updateScheduleBulkBar();
    });
    $('#act-dev-list').on('change', '.act-dev-cb', e => {
      const id = $(e.currentTarget).data('id');
      e.target.checked ? this._selectedCreateDevices.add(id) : this._selectedCreateDevices.delete(id);
      this._updateChooserCount();
    });
    this._populateTimeZones();
    this._syncTimingMode();
  }
  async loadRecent(append = false) {
    const params = { limit: 50, sort: 'inserted_at', sort_direction: 'descending' };
    const state = $('#actions-state-filter').val();
    if (state) params.state = state;
    if (append && this._cursor) params.retrieve_after = this._cursor;
    else if (!append) this._cursor = null;
    
    if (!append) {
      $('#actions-not-loaded').addClass('d-none');
      $('#actions-loading').removeClass('d-none');
      $('#actions-table-wrap').addClass('d-none');
    }
    try {
      const data = await this._api.get('/actions', params);
      const actions = Array.isArray(data.body) ? data.body : [];
      this._cursor = data.retrieve_after_id || null;
      this._recentActions = append ? this._recentActions.concat(actions) : actions;
      $('#actions-loading').addClass('d-none');
      $('#actions-table-wrap').removeClass('d-none');
      this._renderRecentTable();
      this._cursor && actions.length >= 50 ? $('#actions-more-btn').removeClass('d-none') : $('#actions-more-btn').addClass('d-none');
    } catch(e) { 
      $('#actions-loading').addClass('d-none');
      $('#actions-not-loaded').removeClass('d-none');
      this._toast.show(`Actions: ${e.message}`, 'danger'); 
    }
  }
  async loadSchedules() {
    $('#schedules-not-loaded').addClass('d-none');
    $('#schedules-loading').removeClass('d-none');
    $('#schedules-table-wrap').addClass('d-none');
    try {
      const data = await this._api.get('/actions/schedules', { limit: 100, sort_direction: 'ascending' });
      this._schedules = Array.isArray(data.body) ? data.body : [];
      $('#schedules-loading').addClass('d-none');
      $('#schedules-table-wrap').removeClass('d-none');
      this._renderSchedulesTable();
    } catch(e) { 
      $('#schedules-loading').addClass('d-none');
      $('#schedules-not-loaded').removeClass('d-none');
      this._toast.show(`Schedules: ${e.message}`, 'danger'); 
    }
  }
  _renderRecentTable() {
    const rows = this._recentActions.map(a => {
      const dev = this._state.deviceMap[a.device_id];
      const devName = dev ? esc(dev.name||dev.id) : esc(shortId(a.device_id));
      const canCancel = a.state === 'pending' || a.state === 'executing';
      return `<tr>
        <td><input type="checkbox" class="form-check-input act-cb" data-id="${a.id}" ${this._selectedActions.has(a.id) ? 'checked' : ''} ${canCancel ? '' : 'disabled'}></td>
        <td>${stateBadge(a.state)}</td>
        <td><code class="small">${esc(a.type)}</code></td>
        <td>${devName}</td>
        <td class="text-muted small">${fmtDate(a.inserted_at)}</td>
        <td>${canCancel ? `<button class="btn btn-sm btn-outline-danger py-0 act-cancel" data-id="${a.id}">Cancel</button>` : ''}</td>
      </tr>`;
    }).join('');
    document.getElementById('actions-tbody').innerHTML = rows || '<tr><td colspan="6" class="text-center text-muted py-3">No actions found.</td></tr>';
    this._updateActionBulkBar();
  }
  _renderSchedulesTable() {
    const rows = this._schedules.map(s => {
      const dev = this._state.deviceMap[s.device_id];
      const devName = dev ? esc(dev.name) : esc(shortId(s.device_id));
      const opts = s.opts ? Object.entries(s.opts).slice(0,2).map(([k,v]) => `${k}=${JSON.stringify(v)}`).join(', ') : '—';
      return `<tr>
        <td><input type="checkbox" class="form-check-input sched-cb" data-id="${s.id}" ${this._selectedSchedules.has(s.id) ? 'checked' : ''}></td>
        <td><code class="small">${esc(s.type)}</code></td>
        <td>${devName}</td>
        <td>${s.schedule ? `<code>${esc(s.schedule)}</code>` : (s.execute_at ? fmtDate(s.execute_at) : '—')}</td>
        <td class="small text-muted">${esc(opts)}</td>
        <td><button class="btn btn-sm btn-outline-danger py-0 sched-del" data-id="${s.id}"><i class="bi bi-trash"></i></button></td>
      </tr>`;
    }).join('');
    document.getElementById('schedules-tbody').innerHTML = rows || '<tr><td colspan="6" class="text-center text-muted py-3">No schedules.</td></tr>';
    document.querySelectorAll('.sched-del').forEach(btn => btn.addEventListener('click', () => this._deleteSchedule(btn.dataset.id)));
    this._updateScheduleBulkBar();
  }
  _updateActionBulkBar() {
    $('#act-selected-count').text(`${this._selectedActions.size} selected`);
    $('#act-bulk-bar').toggleClass('d-none', this._selectedActions.size === 0);
  }
  _updateScheduleBulkBar() {
    $('#sched-selected-count').text(`${this._selectedSchedules.size} selected`);
    $('#sched-bulk-bar').toggleClass('d-none', this._selectedSchedules.size === 0);
  }
  _toggleAllActions(checked) {
    this._recentActions.forEach(a => {
      if (a.state === 'pending' || a.state === 'executing') {
        checked ? this._selectedActions.add(a.id) : this._selectedActions.delete(a.id);
      }
    });
    this._renderRecentTable();
  }
  _toggleAllSchedules(checked) {
    this._schedules.forEach(s => checked ? this._selectedSchedules.add(s.id) : this._selectedSchedules.delete(s.id));
    this._renderSchedulesTable();
  }
  async _cancelSelected() {
    const ids = [...this._selectedActions];
    if (!ids.length) return;
    const results = await runConcurrent(ids, id => this._api.post(`/actions/${id}/cancel`, { body: { id, state: 'cancelled' } }), 4);
    this._toast.showBulkResult('Cancel actions', results.succeeded.length, results.failed.length, results.failed);
    this._selectedActions.clear();
    this.loadRecent(false);
  }
  async _deleteSelectedSchedules() {
    const ids = [...this._selectedSchedules];
    if (!ids.length) return;
    const results = await runConcurrent(ids, id => this._api.delete(`/actions/schedules/${id}`), 4);
    this._toast.showBulkResult('Delete schedules', results.succeeded.length, results.failed.length, results.failed);
    this._selectedSchedules.clear();
    this.loadSchedules();
  }
  _populateTimeZones() {
    const zones = ['UTC', getBrowserTimeZone(), 'Europe/Berlin', 'Europe/London', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Asia/Tokyo'];
    const uniq = [...new Set(zones.filter(Boolean))];
    $('#act-browser-tz').text(getBrowserTimeZone());
    $('#act-create-tz').html(uniq.map(z => `<option value="${esc(z)}">${esc(z)}</option>`).join('')).val(getBrowserTimeZone());
  }
  _syncTimingMode() {
    const mode = $('input[name="act-create-timing"]:checked').val();
    $('#act-execute-at-wrap').toggleClass('d-none', mode !== 'execute_at');
    $('#act-cron-wrap').toggleClass('d-none', mode !== 'cron');
    $('#act-create-tz-err').addClass('d-none');
  }
  // Renders at most 300 matches – thousands of checkboxes made typing sluggish. "Select all"
  // applies to every match, not only the rendered ones.
  _renderDeviceChooser() {
    const q = ($('#act-dev-search').val() || '').toLowerCase();
    this._chooserMatches = this._state.devices.filter(d => !NetAnalysis.isGatewayDevice(d) && (!q || (d.name || '').toLowerCase().includes(q) || (d.slug || '').toLowerCase().includes(q)));
    const shown = this._chooserMatches.slice(0, 300);
    const rows = shown.map(d => `<div class="form-check">
        <input class="form-check-input act-dev-cb" type="checkbox" data-id="${d.id}" id="act-dev-${d.id}" ${this._selectedCreateDevices.has(d.id) ? 'checked' : ''}>
        <label class="form-check-label small" for="act-dev-${d.id}">${esc(d.name || d.slug)} <span class="text-muted">(${esc(d.slug || shortId(d.id))})</span></label>
      </div>`).join('');
    const more = this._chooserMatches.length > shown.length ? `<div class="text-muted small mt-1">${this._chooserMatches.length - shown.length} more match(es) – refine the filter.</div>` : '';
    document.getElementById('act-dev-list').innerHTML = (rows || '<div class="text-muted small">No matching devices.</div>') + more;
    this._updateChooserCount();
  }
  _updateChooserCount() {
    $('#act-dev-count').text(this._selectedCreateDevices.size ? `${this._selectedCreateDevices.size} selected` : '');
  }
  _selectVisibleCreateDevices(checked) {
    (this._chooserMatches || []).forEach(d => (checked ? this._selectedCreateDevices.add(d.id) : this._selectedCreateDevices.delete(d.id)));
    this._renderDeviceChooser();
  }
  async _createBulkActions() {
    const ids = [...this._selectedCreateDevices];
    if (!ids.length) { this._toast.show('Select at least one device', 'warning'); return; }
    const type = $('#act-create-type').val().trim();
    if (!type) { this._toast.show('Action type is required', 'warning'); return; }
    let opts = {};
    const raw = $('#act-create-opts').val().trim();
    if (raw) {
      try { opts = JSON.parse(raw); } catch { this._toast.show('Options: invalid JSON', 'warning'); return; }
    }
    const mode = $('input[name="act-create-timing"]:checked').val();
    const override = $('#act-create-override').prop('checked');
    const cancelAfter = parseInt($('#act-create-cancel-after').val(), 10) || undefined;
    const executeAt = $('#act-create-execute-at').val();
    const cron = $('#act-create-cron').val().trim();
    const tz = $('#act-create-tz').val();
    if (mode === 'cron' && !tz) { $('#act-create-tz-err').removeClass('d-none'); return; }
    if (mode === 'execute_at' && !executeAt) { this._toast.show('Choose an execution time', 'warning'); return; }
    if (mode === 'cron' && !cron) { this._toast.show('Cron expression is required', 'warning'); return; }
    await this._runBulk('Create action', ids.map(id => this._state.deviceMap[id]).filter(Boolean), async dev => {
      const body = { device_id: dev.id, type, opts, override };
      if (cancelAfter) body.cancel_after = cancelAfter;
      if (mode === 'execute_at') body.execute_at = executeAt;
      if (mode === 'cron') { body.schedule = cron; body.schedule_tz = tz; }
      const path = mode === 'immediate' ? '/actions' : '/actions/schedules';
      return (await this._api.post(path, body)).body;
    });
    if (mode === 'immediate') this.loadRecent(false);
    else this.loadSchedules();
  }
  async _runBulk(label, items, fn) {
    this._bm.show(label, items.length);
    let done = 0;
    const results = await runConcurrent(items, async item => {
      try {
        const res = await fn(item);
        done++;
        this._bm.update(done, items.length, item.name || item.id, 'ok');
        return res;
      } catch (e) {
        done++;
        this._bm.update(done, items.length, `${item.name || item.id}: ${e.message}`, 'error');
        throw e;
      }
    }, 3);
    this._toast.showBulkResult(label, results.succeeded.length, results.failed.length, results.failed);
  }
  async _deleteSchedule(id) {
    if (!confirm('Delete this schedule?')) return;
    try { await this._api.delete(`/actions/schedules/${id}`); this._toast.show('Schedule deleted', 'success'); this.loadSchedules(); }
    catch(e) { this._toast.show(`Delete failed: ${e.message}`, 'danger'); }
  }
}

class DeviceDetailPanel {
  constructor(api, state, toast) {
    this._api = api; this._state = state; this._toast = toast;
    this._device = null; this._cache = {};
    this._ifaceCache = null;
    this._rCursor = null; this._pCursor = null; this._aCursor = null;
    this._oc = new bootstrap.Offcanvas(document.getElementById('device-detail-offcanvas'));
    this._bind();
  }
  _bind() {
    $('#detail-tabs a').on('click', e => {
      e.preventDefault();
      $('#detail-tabs a').removeClass('active'); $(e.currentTarget).addClass('active');
      this._loadTab($(e.currentTarget).data('dtab'));
    });
    $('#detail-edit-name').on('click', () => this._editName());
    document.getElementById('device-detail-offcanvas').addEventListener('hide.bs.offcanvas', () => {
      this._device = null; this._cache = {}; this._ifaceCache = null;
      this._rCursor = this._pCursor = this._aCursor = null;
    });
  }
  open(idOrDevice) {
    const d = typeof idOrDevice === 'object' ? idOrDevice : this._state.deviceMap[idOrDevice];
    if (!d) return;
    this._device = d; this._cache = {}; this._ifaceCache = null;
    this._rCursor = this._pCursor = this._aCursor = null;
    document.getElementById('detail-title').textContent = d.name || d.slug;
    $('#detail-tabs a').removeClass('active'); $('#detail-tabs a[data-dtab="overview"]').addClass('active');
    this._oc.show();
    this._loadTab('overview');
    this._refreshDevice(d.id);
  }

  // The list holds a light copy (no profile data, possibly stale) – load the current device.
  async _refreshDevice(id) {
    try {
      const fresh = (await this._api.get(`/devices/${id}`, { with_profile: 1 })).body;
      if (!fresh || this._device?.id !== id) return;
      this._device = fresh;
      if (this._state.deviceMap[id]) this._state.updateDevice(fresh);
      document.getElementById('detail-title').textContent = fresh.name || fresh.slug;
      delete this._cache.overview;
      if ($('#detail-tabs a.active').data('dtab') === 'overview') this._loadTab('overview');
    } catch { /* keep the list copy */ }
  }

  async _loadTab(tab) {
    const el = document.getElementById('detail-content');
    if (this._cache[tab]) { el.innerHTML = this._cache[tab]; this._reattach(tab); return; }
    el.innerHTML = '<div class="text-center py-5"><div class="spinner-border text-primary"></div></div>';
    try {
      await ({ overview: () => this._renderOverview(), interfaces: () => this._renderInterfaces(),
               readings: () => this._renderReadings(false), packets: () => this._renderPackets(false),
               reception: () => this._renderReception(),
               actions: () => this._renderActions(false) })[tab]?.call(this);
      this._cache[tab] = el.innerHTML;
      this._reattach(tab);
    } catch(e) { el.innerHTML = `<div class="alert alert-danger">${esc(e.message)}</div>`; }
  }

  _reattach(tab) {
    const el = document.getElementById('detail-content');
    if (tab === 'overview') {
      el.querySelector('#det-add-tag')?.addEventListener('click', () => this._addTag());
      el.querySelectorAll('.det-rem-tag').forEach(b => b.addEventListener('click', () => this._removeTag(b.dataset.id)));
    }
    if (tab === 'readings')   el.querySelector('#rd-more')?.addEventListener('click', () => { delete this._cache.readings; this._renderReadings(true); });
    if (tab === 'packets')    el.querySelector('#pk-more')?.addEventListener('click', () => { delete this._cache.packets; this._renderPackets(true); });
    if (tab === 'actions') {
      el.querySelector('#act-more')?.addEventListener('click', () => { delete this._cache.actions; this._renderActions(true); });
      el.querySelector('#det-action-form')?.addEventListener('submit', e => { e.preventDefault(); this._submitAction(); });
      el.querySelector('#det-iface-sel')?.addEventListener('change', e => this._loadActionTypes(e.target.value));
      el.querySelectorAll('.det-act-cancel').forEach(b => b.addEventListener('click', () => this._cancelAction(b.dataset.id)));
    }
  }

  async _renderOverview() {
    const d = this._device;
    const tags = (d.tags||[]).map(t => {
      const c = this._state.tagMap[t.id]?.color_hue != null ? hueToHex(this._state.tagMap[t.id].color_hue) : '#6c757d';
      return `<span class="badge me-1 mb-1" style="background:${c};color:#fff">${esc(t.name)} <button class="btn-close btn-close-white det-rem-tag" data-id="${t.id}" style="font-size:.5em;vertical-align:middle;"></button></span>`;
    }).join('');
    const tagOpts = this._state.tags.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
    const loc = d.location?.coordinates ? `${d.location.coordinates[1].toFixed(5)}, ${d.location.coordinates[0].toFixed(5)}` : '—';
    const meta = d.meta && Object.keys(d.meta).length ? `<pre class="bg-body-tertiary p-2 rounded small mb-0">${esc(JSON.stringify(d.meta,null,2))}</pre>` : '<span class="text-muted small">empty</span>';
    const mandate = getMandateLabel(this._state, d.mandate_id);
    const profiles = Array.isArray(d.profile_data) && d.profile_data.length
      ? d.profile_data.map(entry => {
          const profile = this._state.profileMap[entry.profile_id];
          const label = profile?.name || profile?.slug || entry.profile_id || 'Profile';
          return `<div class="mb-3">
            <div class="fw-semibold mb-1">${esc(label)}</div>
            ${formatProfileDataTable(entry)}
          </div>`;
        }).join('')
      : '<span class="text-muted small">none</span>';
    document.getElementById('detail-content').innerHTML = `
      <div class="row g-3">
        <div class="col-6"><div class="small text-muted">Name</div><strong>${esc(d.name)}</strong></div>
        <div class="col-6"><div class="small text-muted">Slug</div><code>${esc(d.slug)}</code></div>
        <div class="col-6"><div class="small text-muted">Type</div>${typeBadge(NetAnalysis.isGatewayDevice(d) ? 'gateway' : (d.type || 'device'))}</div>
        <div class="col-6"><div class="small text-muted">Location</div><small>${esc(loc)}</small></div>
        <div class="col-12"><div class="small text-muted">ID</div><small class="font-monospace">${esc(d.id)}</small></div>
        <div class="col-12"><div class="small text-muted mb-1">Mandate</div>${mandate}</div>
        <div class="col-12">
          <div class="small text-muted mb-1">Folders</div>
          <div>${tags || '<span class="text-muted small">none</span>'}</div>
          <div class="d-flex gap-2 mt-2">
            <select class="form-select form-select-sm" id="det-add-tag-sel" style="width:200px;">${tagOpts}</select>
            <button class="btn btn-sm btn-outline-primary" id="det-add-tag"><i class="bi bi-folder-plus me-1"></i>Add</button>
          </div>
        </div>
        <div class="col-12"><div class="small text-muted mb-1">Profiles</div>${profiles}</div>
        <div class="col-12"><div class="small text-muted mb-1">Meta</div>${meta}</div>
        <div class="col-12"><small class="text-muted">Created: ${fmtDate(d.inserted_at)} · Updated: ${fmtDate(d.updated_at)}</small></div>
      </div>`;
  }

  async _addTag() {
    const tagId = document.getElementById('det-add-tag-sel')?.value; if (!tagId) return;
    const d = this._device;
    if ((d.tags||[]).some(t => t.id === tagId)) { this._toast.show('Tag already on device', 'info'); return; }
    try {
      const r = await this._api.put(`/devices/${d.id}`, { device: { tags: [...(d.tags||[]), { id: tagId }] } });
      this._device = r.body; this._state.updateDevice(r.body);
      delete this._cache.overview; await this._renderOverview(); this._cache.overview = document.getElementById('detail-content').innerHTML; this._reattach('overview');
    } catch(e) { this._toast.show(`Add tag: ${e.message}`, 'danger'); }
  }

  async _removeTag(tagId) {
    const d = this._device;
    try {
      const r = await this._api.put(`/devices/${d.id}`, { device: { tags: (d.tags||[]).filter(t => t.id !== tagId) } });
      this._device = r.body; this._state.updateDevice(r.body);
      delete this._cache.overview; await this._renderOverview(); this._cache.overview = document.getElementById('detail-content').innerHTML; this._reattach('overview');
    } catch(e) { this._toast.show(`Remove tag: ${e.message}`, 'danger'); }
  }

  _editName() {
    const title = document.getElementById('detail-title');
    const cur = title.textContent;
    const inp = Object.assign(document.createElement('input'), { type: 'text', value: cur, className: 'form-control form-control-sm' });
    title.replaceWith(inp); inp.focus(); inp.select();
    const save = async () => {
      const nv = inp.value.trim();
      const span = Object.assign(document.createElement('h5'), { className: 'offcanvas-title mb-0', id: 'detail-title', textContent: nv || cur });
      inp.replaceWith(span);
      if (!nv || nv === cur) return;
      try {
        const r = await this._api.put(`/devices/${this._device.id}`, { device: { name: nv } });
        this._device = r.body; this._state.updateDevice(r.body);
        this._toast.show('Name updated', 'success');
        delete this._cache.overview;
      } catch(e) { this._toast.show(`Rename: ${e.message}`, 'danger'); }
    };
    inp.addEventListener('blur', save);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { inp.value = cur; inp.blur(); } });
  }

  async _ensureInterfaces() {
    if (!this._ifaceCache) {
      const r = await this._api.get(`/devices/${this._device.id}/interfaces`, { limit: 100, sort_direction: 'ascending' });
      this._ifaceCache = Array.isArray(r.body) ? r.body : [];
    }
    return this._ifaceCache;
  }

  async _renderInterfaces() {
    const ifaces = await this._ensureInterfaces();
    if (!ifaces.length) { document.getElementById('detail-content').innerHTML = '<p class="text-muted">No interfaces.</p>'; return; }
    const rows = ifaces.map(i => {
      const opts = i.opts ? Object.entries(i.opts).filter(([,v]) => v != null && v !== '').slice(0,4)
        .map(([k,v]) => `<div class="small"><strong>${esc(k)}:</strong> ${esc(String(v))}</div>`).join('') : '—';
      return `<tr><td class="font-monospace small">${esc(i.id)}</td><td class="small text-muted">${esc(i.driver_instance_id?.substring(0,8)||'—')}</td><td>${opts}</td></tr>`;
    }).join('');
    document.getElementById('detail-content').innerHTML =
      `<div class="table-responsive"><table class="table table-sm table-hover"><thead><tr><th>Interface ID</th><th>Driver Instance</th><th>Options</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  async _renderReadings(append) {
    const params = { limit: 20, sort_direction: 'descending' };
    if (append && this._rCursor) params.retrieve_after = this._rCursor;
    const r = await this._api.get(`/devices/${this._device.id}/readings`, params);
    const items = Array.isArray(r.body) ? r.body : [];
    this._rCursor = r.retrieve_after_id || null;
    if (!items.length && !append) { document.getElementById('detail-content').innerHTML = '<p class="text-muted">No readings.</p>'; return; }
    const rows = items.map(rd => {
      const vals = rd.data ? Object.entries(rd.data).slice(0,6).map(([k,v]) => `<span class="badge bg-body-tertiary text-body border me-1">${esc(k)}: ${esc(String(v))}</span>`).join('') : '—';
      return `<tr><td class="small">${fmtDate(rd.measured_at)}</td><td>${vals}</td></tr>`;
    }).join('');
    const more = this._rCursor ? `<button class="btn btn-sm btn-outline-secondary mt-2" id="rd-more">Load more</button>` : '';
    const el = document.getElementById('detail-content');
    if (append) { el.querySelector('tbody')?.insertAdjacentHTML('beforeend', rows); el.querySelector('#rd-more')?.remove(); if (more) el.insertAdjacentHTML('beforeend', more); }
    else el.innerHTML = `<div class="table-responsive"><table class="table table-sm table-hover"><thead><tr><th>Measured At</th><th>Values</th></tr></thead><tbody>${rows}</tbody></table></div>${more}`;
  }

  async _renderPackets(append) {
    const params = { limit: 20, sort_direction: 'descending' };
    if (append && this._pCursor) params.retrieve_after = this._pCursor;
    const r = await this._api.get(`/devices/${this._device.id}/packets`, params);
    const items = Array.isArray(r.body) ? r.body : [];
    this._pCursor = r.retrieve_after_id || null;
    if (!items.length && !append) { document.getElementById('detail-content').innerHTML = '<p class="text-muted">No packets.</p>'; return; }
    const rows = items.map(p => {
      const raw = p.body?.payload ?? p.payload ?? '—';
      const pl = typeof raw === 'string' ? raw : JSON.stringify(raw);
      return `<tr><td class="small">${fmtDate(p.transceived_at||p.inserted_at)}</td>
        <td><span class="badge bg-secondary">${esc(p.packet_type||'—')}</span></td>
        <td class="payload-cell font-monospace small" title="${esc(pl)}">${esc(pl.substring(0,40))}${pl.length>40?'…':''}</td></tr>`;
    }).join('');
    const more = this._pCursor ? `<button class="btn btn-sm btn-outline-secondary mt-2" id="pk-more">Load more</button>` : '';
    const el = document.getElementById('detail-content');
    if (append) { el.querySelector('tbody')?.insertAdjacentHTML('beforeend', rows); el.querySelector('#pk-more')?.remove(); if (more) el.insertAdjacentHTML('beforeend', more); }
    else el.innerHTML = `<div class="table-responsive"><table class="table table-sm table-hover"><thead><tr><th>Received</th><th>Type</th><th>Payload</th></tr></thead><tbody>${rows}</tbody></table></div>${more}`;
  }

  // Which gateways received the most recent uplinks of this device (from packet gateway stats).
  async _renderReception() {
    const d = this._device;
    if (NetAnalysis.isGatewayDevice(d)) {
      document.getElementById('detail-content').innerHTML = `<p class="text-muted">This is a gateway. To see which devices it receives, run an analysis in the
        <a href="#network" onclick="bootstrap.Offcanvas.getInstance(document.getElementById('device-detail-offcanvas'))?.hide()">Network</a> view and select it on the map.</p>`;
      return;
    }
    const r = await this._api.get(`/devices/${d.id}/packets`, { limit: 50, packet_type: 'up', sort_direction: 'descending' });
    const packets = Array.isArray(r.body) ? r.body : [];
    const el = document.getElementById('detail-content');
    if (!packets.length) { el.innerHTML = '<p class="text-muted">No uplink packets found.</p>'; return; }
    const gatewayDevices = this._state.devices.filter(x => NetAnalysis.isGatewayDevice(x));
    const res = NetAnalysis.analyze({ devices: [d], packetsByDevice: new Map([[d.id, packets]]), gatewayDevices });
    const st = res.devices[0];
    const links = [...st.links.values()].sort((a, b) => b.count - a.count);
    const linkRows = links.map(l => `<tr>
        <td>${esc(l.gw.name || l.gw.key)}${l.gw.name ? `<div class="small text-muted font-monospace">${esc(l.gw.key)}</div>` : ''}</td>
        <td class="text-end">${l.count}</td>
        <td class="text-end"><span class="net-q" style="--c:${NET_LINK_COLOR[l.quality]}"></span>${fmtNum(l.rssiAvg, 0)} <small class="text-muted">/ ${fmtNum(l.rssiBest, 0)}</small></td>
        <td class="text-end">${fmtNum(l.snrAvg)} <small class="text-muted">/ ${fmtNum(l.snrBest)}</small></td>
        <td class="text-end">${fmtNum(l.margin)}</td>
        <td class="text-end">${fmtDistance(l.distance)}</td>
        <td class="small text-muted">${fmtAgo(l.lastSeen)}</td></tr>`).join('');
    const pktRows = packets.slice(0, 20).map(p => {
      const gws = NetAnalysis.extractGateways(p).sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
      const sf = NetAnalysis.extractSf(p);
      return `<tr><td class="small">${fmtDate(p.transceived_at || p.inserted_at)}</td><td>${sf != null ? `SF${sf}` : '—'}</td>
        <td class="small">${gws.map(g => `<span class="badge bg-body-tertiary text-body border me-1" title="${esc(g.id)}">${esc(res.gateways.find(x => (x.ids || []).includes(g.id) || x.key === g.id)?.name || g.id)}: ${fmtNum(g.rssi, 0)} / ${fmtNum(g.snr)}</span>`).join('') || '<span class="text-muted">no gateway data</span>'}</td></tr>`;
    }).join('');
    const loadedGw = gatewayDevices.length ? '' : '<div class="small text-muted mb-2"><i class="bi bi-info-circle me-1"></i>Load devices (incl. gateways) in the Devices view to show gateway names and distances.</div>';
    el.innerHTML = `
      <div class="d-flex flex-wrap gap-3 mb-2 small">
        <div>${netStatusBadge(st.status)}</div>
        <div><span class="text-muted">Uplinks analysed:</span> ${st.packets}</div>
        <div><span class="text-muted">Gateways / packet:</span> ${fmtNum(st.gwAvg)}</div>
        <div><span class="text-muted">Avg SF:</span> ${st.sfAvg != null ? fmtNum(st.sfAvg) : '—'}</div>
      </div>
      ${loadedGw}
      ${links.length ? `<div class="table-responsive"><table class="table table-sm"><thead><tr><th>Gateway</th><th class="text-end">Pkt</th><th class="text-end">RSSI avg / best</th><th class="text-end">SNR avg / best</th><th class="text-end">Margin</th><th class="text-end">Dist.</th><th>Last</th></tr></thead><tbody>${linkRows}</tbody></table></div>`
        : '<p class="text-muted">The packets of this device carry no gateway statistics (depends on the driver).</p>'}
      <h6 class="mt-3">Latest uplinks <small class="text-muted">(RSSI / SNR per gateway)</small></h6>
      <div class="table-responsive"><table class="table table-sm table-hover"><thead><tr><th>Received</th><th>SF</th><th>Gateways</th></tr></thead><tbody>${pktRows}</tbody></table></div>`;
  }

  async _renderActions(append) {
    const ifaces = await this._ensureInterfaces();
    const params = { limit: 20, sort_direction: 'descending' };
    if (append && this._aCursor) params.retrieve_after = this._aCursor;
    const r = await this._api.get(`/devices/${this._device.id}/actions`, params);
    const items = Array.isArray(r.body) ? r.body : [];
    this._aCursor = r.retrieve_after_id || null;
    const rows = items.map(a => {
      const can = a.state === 'pending' || a.state === 'executing';
      return `<tr><td>${stateBadge(a.state)}</td><td><code class="small">${esc(a.type)}</code></td>
        <td class="text-muted small">${fmtDate(a.inserted_at)}</td>
        <td>${can ? `<button class="btn btn-sm btn-outline-danger py-0 det-act-cancel" data-id="${a.id}">Cancel</button>` : ''}</td></tr>`;
    }).join('');
    const more = this._aCursor ? `<button class="btn btn-sm btn-outline-secondary mt-2" id="act-more">Load more</button>` : '';
    const ifaceOpts = ifaces.map(i => `<option value="${i.id}">${esc(i.id.substring(0,8))}… (${esc(i.driver_instance_id?.substring(0,8)||'n/a')})</option>`).join('');
    const form = `
      <div class="card mt-3"><div class="card-header fw-semibold py-2 small">Create Action</div><div class="card-body">
        <form id="det-action-form">
          <div class="row g-2">
            <div class="col-6"><label class="form-label small mb-1">Interface</label>
              <select class="form-select form-select-sm" id="det-iface-sel">${ifaceOpts||'<option value="">No interfaces</option>'}</select></div>
            <div class="col-6"><label class="form-label small mb-1">Action Type</label>
              <select class="form-select form-select-sm" id="det-act-type"><option value="">Select interface first</option></select></div>
            <div class="col-12"><label class="form-label small mb-1">Options (JSON)</label>
              <textarea class="form-control form-control-sm font-monospace" id="det-act-opts" rows="3" placeholder='{"payload":"CAFE","port":1}'></textarea></div>
            <div class="col-12"><button type="submit" class="btn btn-sm btn-primary" ${!ifaces.length?'disabled':''}>Send</button></div>
          </div>
        </form>
      </div></div>`;
    const el = document.getElementById('detail-content');
    if (append) { el.querySelector('tbody')?.insertAdjacentHTML('beforeend', rows); el.querySelector('#act-more')?.remove(); if (more) el.querySelector('.card')?.insertAdjacentHTML('afterend', more); }
    else el.innerHTML = `<div class="table-responsive"><table class="table table-sm table-hover"><thead><tr><th>State</th><th>Type</th><th>Created</th><th></th></tr></thead><tbody>${rows||'<tr><td colspan="4" class="text-center text-muted py-2">No actions yet.</td></tr>'}</tbody></table></div>${more}${form}`;
  }

  async _loadActionTypes(ifaceId) {
    const sel = document.getElementById('det-act-type'); if (!sel || !ifaceId) return;
    sel.innerHTML = '<option>Loading…</option>';
    try {
      const r = await this._api.get(`/devices/${this._device.id}/interfaces/${ifaceId}/actions/types`);
      const types = Array.isArray(r.body) ? r.body : [];
      sel.innerHTML = types.map(t => `<option value="${esc(t.type)}">${esc(t.display||t.type)}</option>`).join('') || '<option value="">None available</option>';
    } catch { sel.innerHTML = '<option value="">Failed to load</option>'; }
  }

  async _submitAction() {
    const ifaceId = document.getElementById('det-iface-sel')?.value;
    const type    = document.getElementById('det-act-type')?.value;
    const raw     = document.getElementById('det-act-opts')?.value.trim() || '{}';
    if (!ifaceId || !type) { this._toast.show('Select interface and action type', 'warning'); return; }
    let opts;
    try { opts = JSON.parse(raw); } catch { this._toast.show('Invalid JSON in options', 'warning'); return; }
    try {
      await this._api.post(`/devices/${this._device.id}/interfaces/${ifaceId}/actions/${type}`, { opts });
      this._toast.show('Action sent', 'success');
      this._aCursor = null; delete this._cache.actions; await this._renderActions(false);
      this._cache.actions = document.getElementById('detail-content').innerHTML; this._reattach('actions');
    } catch(e) { this._toast.show(`Action: ${e.message}`, 'danger'); }
  }

  async _cancelAction(id) {
    try {
      await this._api.post(`/actions/${id}/cancel`, { body: { id, state: 'cancelled' } });
      this._toast.show('Cancelled', 'success');
      this._aCursor = null; delete this._cache.actions; await this._renderActions(false);
      this._cache.actions = document.getElementById('detail-content').innerHTML; this._reattach('actions');
    } catch(e) { this._toast.show(`Cancel: ${e.message}`, 'danger'); }
  }
}
