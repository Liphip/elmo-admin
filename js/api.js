'use strict';

async function runConcurrent(items, asyncFn, concurrency = 3) {
  const results = { succeeded: [], failed: [] };
  const queue = [...items];
  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      try { results.succeeded.push({ item, result: await asyncFn(item) }); }
      catch (e) { results.failed.push({ item, error: e.message || String(e) }); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, worker));
  return results;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function hueToHex(hue) {
  const h = ((hue % 360) + 360) % 360, s = .65, l = .48;
  const a = s * Math.min(l, 1 - l);
  const f = n => { const k = (n + h / 30) % 12; return l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1); };
  const x = v => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${x(f(0))}${x(f(8))}${x(f(4))}`;
}

function typeBadge(type) {
  const m = { generic: 'bg-secondary', sensor: 'bg-success', gateway: 'bg-primary', virtual: 'bg-info text-dark' };
  return `<span class="badge ${m[type] || 'bg-secondary'}">${esc(type || 'generic')}</span>`;
}

function stateBadge(state) {
  return `<span class="badge state-${esc(state)}">${esc(state)}</span>`;
}

function shortId(id) {
  if (!id) return '—';
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function getBrowserTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
  catch { return 'UTC'; }
}

function buildSearchMatcher(query, regexEnabled) {
  const raw = String(query || '').trim();
  if (!raw) return () => true;
  if (regexEnabled) {
    try {
      const rx = new RegExp(raw, 'i');
      return value => rx.test(String(value || ''));
    } catch {}
  }
  const needle = raw.toLowerCase();
  return value => String(value || '').toLowerCase().includes(needle);
}

function getMandateLabel(state, mandateId) {
  if (!mandateId) return '<span class="text-muted">—</span>';
  const mandate = state.mandateMap?.[mandateId];
  const label = mandate?.slug || shortId(mandateId);
  return `<span class="badge bg-secondary">${esc(label)}</span>`;
}

function getProfileFieldDefs(profile) {
  const defs = profile?.fields || profile?.field_definitions || profile?.definition?.fields || profile?.schema?.fields || profile?.data_fields || [];
  if (Array.isArray(defs)) return defs;
  if (defs && typeof defs === 'object') {
    return Object.entries(defs).map(([key, value]) => typeof value === 'object' ? { key, ...value } : { key, type: value });
  }
  return [];
}

function normalizeProfileField(field, index) {
  const key = field?.key || field?.name || field?.slug || field?.id || `field_${index + 1}`;
  const label = field?.label || field?.display || field?.title || key;
  const type = String(field?.type || field?.field_type || field?.kind || 'text').toLowerCase();
  const rawOptions = field?.options || field?.choices || field?.enum || field?.values || [];
  const options = Array.isArray(rawOptions)
    ? rawOptions.map(opt => typeof opt === 'object' ? { value: opt.value ?? opt.id ?? opt.slug ?? opt.name, label: opt.label ?? opt.name ?? opt.slug ?? opt.value ?? opt.id } : { value: opt, label: opt })
    : Object.entries(rawOptions || {}).map(([value, labelText]) => ({ value, label: labelText }));
  return { key, label, type, options, placeholder: field?.placeholder || '', help: field?.help || field?.description || '', multiline: !!field?.multiline };
}

function renderProfileFieldEditor(profile, existing = {}) {
  const defs = getProfileFieldDefs(profile).map(normalizeProfileField);
  if (!defs.length) {
    return '<div class="text-muted small">No field definitions available for this profile.</div>';
  }
  return defs.map((field, index) => {
    const value = existing[field.key];
    const inputId = `bpe-field-${index}`;
    let control = '';
    if (field.options.length) {
      control = `<select class="form-select form-select-sm bpe-input" data-key="${esc(field.key)}">${['<option value="">Select…</option>'].concat(field.options.map(opt => `<option value="${esc(opt.value)}"${String(opt.value) === String(value ?? '') ? ' selected' : ''}>${esc(opt.label)}</option>`)).join('')}</select>`;
    } else if (field.type.includes('bool') || field.type === 'checkbox') {
      control = `<div class="form-check pt-1"><input class="form-check-input bpe-input" type="checkbox" id="${inputId}" data-key="${esc(field.key)}"${value ? ' checked' : ''}><label class="form-check-label" for="${inputId}">Enabled</label></div>`;
    } else if (field.multiline || field.type.includes('text') || field.type.includes('json') || field.type.includes('object')) {
      control = `<textarea class="form-control form-control-sm bpe-input font-monospace" data-key="${esc(field.key)}" rows="3" placeholder="${esc(field.placeholder)}">${esc(value ?? '')}</textarea>`;
    } else {
      const typeAttr = field.type.includes('int') || field.type.includes('float') || field.type.includes('number') ? 'number' : 'text';
      control = `<input type="${typeAttr}" class="form-control form-control-sm bpe-input" data-key="${esc(field.key)}" value="${esc(value ?? '')}" placeholder="${esc(field.placeholder)}">`;
    }
    return `<div class="profile-field-row">
      <label class="form-label small mb-1">${esc(field.label)}</label>
      ${control}
      ${field.help ? `<div class="form-text mt-1">${esc(field.help)}</div>` : ''}
    </div>`;
  }).join('');
}

function collectProfileFieldValues(container) {
  const data = {};
  container.querySelectorAll('.bpe-input').forEach(input => {
    const key = input.dataset.key;
    if (!key) return;
    let value;
    if (input.type === 'checkbox') value = input.checked;
    else if (input.type === 'number') value = input.value === '' ? '' : Number(input.value);
    else value = input.value;
    if (value === '') return;
    data[key] = value;
  });
  return data;
}

function formatProfileDataTable(entry) {
  const rows = Object.entries(entry?.data || {});
  if (!rows.length) return '<div class="text-muted small">No profile fields set.</div>';
  return `<div class="table-responsive"><table class="table table-sm table-bordered mb-0 profile-preview-table"><tbody>${
    rows.map(([key, value]) => `<tr><th class="w-25">${esc(key)}</th><td>${esc(typeof value === 'string' ? value : JSON.stringify(value))}</td></tr>`).join('')
  }</tbody></table></div>`;
}

class ApiClient {
  constructor(domain, apiKey) {
    this.domain = (domain || '').replace(/\/$/, '');
    this.apiKey = apiKey || '';
    this._rlRemaining = 50;
    this._rlReset = 10000;
    this._logger = window._apiLogger || null;
  }

  setLogger(logger) {
    this._logger = logger;
  }

  _buildUrl(path, params = {}) {
    const url = `${this.domain}/api/v1${path.startsWith('/') ? path : '/' + path}`;
    const qs = new URLSearchParams({ auth: this.apiKey });
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    return `${url}?${qs}`;
  }

  async _request(method, path, body = null, params = {}) {
    const startTime = Date.now();
    const url = this._buildUrl(path, params);
    const opts = { method, headers: { Accept: 'application/json' } };
    if (body !== null) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    let lastError;
    for (let attempt = 0; attempt <= 3; attempt++) {
      let res;
      try { res = await fetch(url, opts); }
      catch (e) {
        if (e instanceof TypeError) {
          const fromFile = location.protocol === 'file:';
          lastError = fromFile
            ? 'CORS blocked (file:// origin). Serve this file via a local HTTP server — see the blue info box in Configuration.'
            : `Network/CORS error: ${e.message}. The Element IoT server must allow this origin in its CORS settings.`;
          if (this._logger) this._logger.log(method, url, path, 0, Date.now() - startTime, lastError);
          throw new Error(lastError);
        }
        throw e;
      }
      this._rlRemaining = parseInt(res.headers.get('x-ratelimit-remaining') || '50');
      this._rlReset = parseInt(res.headers.get('x-ratelimit-reset') || '10000');
      if (res.status === 429) {
        if (attempt >= 3) { lastError = 'Rate limit exceeded after 3 retries'; break; }
        await sleep(this._rlReset);
        continue;
      }
      if (res.status === 401) { lastError = 'Unauthorized (401): invalid API key'; break; }
      if (res.status === 403) { lastError = 'Forbidden (403): insufficient permissions'; break; }
      let data;
      try { data = await res.json(); } catch { lastError = `HTTP ${res.status}: non-JSON response`; break; }
      if (!res.ok) {
        const msg = data?.errors ? JSON.stringify(data.errors) : (data?.message || res.statusText);
        lastError = `HTTP ${res.status}: ${msg}`;
        break;
      }
      if (this._logger) this._logger.log(method, url, path, res.status, Date.now() - startTime, null);
      return data;
    }
    if (this._logger) this._logger.log(method, url, path, 0, Date.now() - startTime, lastError);
    throw new Error(lastError);
  }

  async fetchAllPages(path, params = {}, onProgress = null) {
    const all = [];
    let cursor = null;
    const p = { limit: 100, sort: 'inserted_at', sort_direction: 'ascending', ...params };
    do {
      if (cursor) p.retrieve_after = cursor; else delete p.retrieve_after;
      const data = await this._request('GET', path, null, p);
      const body = Array.isArray(data.body) ? data.body : [];
      all.push(...body);
      cursor = data.retrieve_after_id || null;
      if (onProgress) onProgress(all.length);
      if (this._rlRemaining <= 5) await sleep(Math.ceil(this._rlReset / Math.max(this._rlRemaining, 1)));
      if (!cursor || body.length < p.limit) break;
    } while (true);
    return all;
  }

  get(path, params) { return this._request('GET', path, null, params); }
  post(path, body, params) { return this._request('POST', path, body, params); }
  put(path, body) { return this._request('PUT', path, body); }
  delete(path) { return this._request('DELETE', path); }

  async testConnection() {
    const data = await this._request('GET', '/mandates', null, { limit: 1, sort_direction: 'ascending' });
    const body = Array.isArray(data.body) ? data.body : (data.body ? [data.body] : []);
    return body.length > 0 ? (body[0].name || 'Connected') : 'Connected';
  }
}

class AppState {
  constructor() {
    this.devices = []; this.tags = []; this.mandates = []; this.profiles = [];
    this.deviceMap = {}; this.tagMap = {}; this.mandateMap = {}; this.profileMap = {};
    this.isLoaded = { devices: false, tags: false, mandates: false, profiles: false };
  }
  setDevices(list) { this.devices = list; this.deviceMap = {}; list.forEach(d => this.deviceMap[d.id] = d); this.isLoaded.devices = true; }
  setTags(list)    { this.tags = list; this.tagMap = {}; list.forEach(t => this.tagMap[t.id] = t); this.isLoaded.tags = true; }
  setMandates(list){ this.mandates = list; this.mandateMap = {}; list.forEach(m => this.mandateMap[m.id] = m); this.isLoaded.mandates = true; }
  setProfiles(list){ this.profiles = list; this.profileMap = {}; list.forEach(p => this.profileMap[p.id] = p); this.isLoaded.profiles = true; }
  updateDevice(d)  { this.deviceMap[d.id] = d; const i = this.devices.findIndex(x => x.id === d.id); if (i >= 0) this.devices[i] = d; else this.devices.push(d); }
  removeDevice(id) { delete this.deviceMap[id]; this.devices = this.devices.filter(d => d.id !== id); }
  updateTag(t)     { this.tagMap[t.id] = t; const i = this.tags.findIndex(x => x.id === t.id); if (i >= 0) this.tags[i] = t; else this.tags.push(t); }
  removeTag(id)    { delete this.tagMap[id]; this.tags = this.tags.filter(t => t.id !== id); }
}
