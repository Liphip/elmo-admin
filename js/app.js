'use strict';

class App {
  constructor() {
    const apiLogger = new ApiLogger(500);
    const api = new ApiClient('', '');
    api.setLogger(apiLogger);
    const state = new AppState();
    const toast = new ToastService();
    const lb = new LoadingBar();
    const bm = new BulkProgressModal();
    const detail = new DeviceDetailPanel(api, state, toast);
    const cfg = new ConfigView(api, toast);
    const devV = new DeviceView(api, state, toast, lb, detail, bm);
    const tagV = new TagView(api, state, toast);
    const manV = new MandateView(api, state, toast);
    const actV = new ActionsView(api, state, toast, bm);
    const netV = new NetworkView(api, state, toast, detail);

    this._api = api; this._apiLogger = apiLogger; this._state = state; this._cfg = cfg; this._toast = toast;
    this._devV = devV; this._tagV = tagV; this._manV = manV; this._actV = actV; this._netV = netV;

    this._loadSettings();
    this._bindNav();
    this._init();
    this._updateAppUrl();
    const initial = location.hash.replace('#', '');
    if (initial && document.getElementById(`view-${initial}`)) this.navigateTo(initial);
  }

  _updateAppUrl() {
    const url = window.location.origin;
    const urlEl = document.getElementById('app-url');
    if (urlEl) {
      urlEl.textContent = url;
    }
  }

  _loadSettings() {
    try {
      const settings = JSON.parse(localStorage.getItem('deviceAdminSettings') || '{}');
      if (settings.maxLogEntries) {
        this._apiLogger.setMaxEntries(settings.maxLogEntries);
        $('#cfg-max-log-entries').val(settings.maxLogEntries);
      }
      if (settings.maxDevices) {
        this._devV.setMaxDevices(settings.maxDevices);
        $('#cfg-max-devices').val(settings.maxDevices);
      }
    } catch {}
  }

  _bindNav() {
    if (location.protocol === 'file:') $('#cors-hint').removeClass('d-none');
    $('#sidebar .nav-link[data-view]').on('click', e => { e.preventDefault(); this.navigateTo($(e.currentTarget).data('view')); });
    $('#sidebar-toggle').on('click', () => $('#sidebar').toggleClass('collapsed'));
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { const oc = bootstrap.Offcanvas.getInstance(document.getElementById('device-detail-offcanvas')); if (oc) oc.hide(); }
      if ((e.ctrlKey||e.metaKey) && e.key === 'f' && $('#view-devices').hasClass('active')) { e.preventDefault(); document.getElementById('dev-filter-name').focus(); }
    });
    
    $('#api-log-refresh').on('click', () => this._renderApiLog());
    $('#api-log-clear').on('click', () => {
      if (confirm('Clear all API logs?')) {
        this._apiLogger.clear();
        this._renderApiLog();
      }
    });
    $('#api-log-export').on('click', () => {
      downloadFile(`elmo-api-log-${new Date().toISOString().slice(0, 10)}.json`, this._apiLogger.export(), 'application/json');
    });
    window.addEventListener('hashchange', () => {
      const view = location.hash.replace('#', '');
      if (view && document.getElementById(`view-${view}`) && !$(`#view-${view}`).hasClass('active')) this.navigateTo(view);
    });
    $('#api-log-search-btn').on('click', () => this._renderApiLog($('#api-log-search').val()));
    $('#api-log-search').on('keydown', e => { if (e.key === 'Enter') this._renderApiLog($('#api-log-search').val()); });
  }

  _renderApiLog(query = '') {
    const logs = this._apiLogger.filter(query);
    const tbody = document.getElementById('api-log-tbody');
    if (!logs.length) {
      $('#api-log-empty').removeClass('d-none');
      $('#api-log-table-wrap').addClass('d-none');
      return;
    }
    $('#api-log-empty').addClass('d-none');
    $('#api-log-table-wrap').removeClass('d-none');
    const rows = logs.map(log => {
      const statusClass = log.status >= 200 && log.status < 300 ? 'text-success' : (log.status >= 400 ? 'text-danger' : 'text-warning');
      const time = new Date(log.timestamp).toLocaleTimeString();
      return `<tr>
        <td><span class="badge bg-secondary">${esc(log.method)}</span></td>
        <td><code class="small">${esc(log.path)}</code></td>
        <td class="${statusClass}" title="${esc(log.error || '')}">${log.status || 'ERR'}</td>
        <td class="text-muted small">${log.duration}ms</td>
        <td class="text-muted small">${time}</td>
        <td class="text-muted small" title="${esc(log.url || '')}">${esc(log.url ? new URL(log.url).pathname + (log.url.includes('?') ? '?' + new URLSearchParams(new URL(log.url).search).toString().substring(0, 30) + '...' : '') : '')}</td>
      </tr>`;
    }).join('');
    tbody.innerHTML = rows;
  }

  navigateTo(view) {
    $('.view-section').removeClass('active'); $(`#view-${view}`).addClass('active');
    $('#sidebar .nav-link').removeClass('active'); $(`#sidebar .nav-link[data-view="${view}"]`).addClass('active');
    if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
    if (view === 'api-log') this._renderApiLog();
    if (view === 'network') this._netV.onShow();
  }

  async _init() {
    if (!this._api.apiKey || !this._api.domain) return;
    try {
      // Folders are required; the mandate list needs a privileged key and profiles may be
      // disabled, so failures there must not break the whole start-up.
      const optional = p => p.catch(e => { console.warn(e); return null; });
      const [tags, mandates, profiles] = await Promise.all([
        this._api.fetchAllPages('/tags', { limit: 100, sort: 'name', sort_direction: 'ascending' }),
        optional(this._api.fetchAllPages('/mandates', { limit: 100, sort: 'name', sort_direction: 'ascending' })),
        optional(this._api.fetchAllPages('/profiles', { limit: 100, sort: 'name', sort_direction: 'ascending' }))
      ]);
      this._state.setTags(tags);
      if (mandates) this._state.setMandates(mandates);
      if (profiles) this._state.setProfiles(profiles);
      this._tagV.render(); $('#folder-count').text(tags.length);
      this._manV.render();
      this._devV.populateFolderDropdowns();
      this._devV.populateMandateDropdown();
      this._devV.populateProfileDropdown();
      this._tagV.populateMandateDropdown();
      this._netV.populateFolderDropdown();
      this._actV._renderDeviceChooser();
      const host = (() => { try { return new URL(this._api.domain).host; } catch { return 'Connected'; } })();
      this._cfg.setConnected(host);
    } catch(e) {
      this._cfg.setDisconnected();
      this._toast.show(`Connection failed: ${e.message}`, 'danger');
      if (e.message.includes('CORS')) { $('#cors-hint').removeClass('d-none'); this.navigateTo('config'); }
      return;
    }
    this._devV.loadAll();
  }
}

$(document).ready(() => { window._app = new App(); });
