'use strict';

let _toastSeq = 0;

class ToastService {
  constructor() { this._el = document.getElementById('toast-container'); }
  show(msg, type = 'info') {
    const bg = { success: 'bg-success text-white', danger: 'bg-danger text-white', warning: 'bg-warning text-dark', info: 'bg-info text-dark' }[type] || '';
    const delay = (type === 'success' || type === 'info') ? 5000 : 0;
    const id = `toast-${++_toastSeq}`;
    this._el.insertAdjacentHTML('beforeend',
      `<div id="${id}" class="toast ${bg}" data-bs-autohide="${delay > 0}" data-bs-delay="${delay}" role="alert">
        <div class="d-flex"><div class="toast-body">${esc(msg)}</div>
        <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button></div></div>`);
    const el = document.getElementById(id);
    new bootstrap.Toast(el).show();
    el.addEventListener('hidden.bs.toast', () => el.remove());
  }
  showBulkResult(label, ok, fail, errors = []) {
    if (fail === 0) { this.show(`${label}: ${ok} succeeded`, 'success'); return; }
    const items = errors.slice(0, 5).map(e => `<li>${esc((e.item?.name || e.item || '?'))}: ${esc(e.error)}</li>`).join('');
    const more  = errors.length > 5 ? `<li>…and ${errors.length - 5} more</li>` : '';
    const id = `toast-${++_toastSeq}`;
    this._el.insertAdjacentHTML('beforeend',
      `<div id="${id}" class="toast bg-warning" data-bs-autohide="false" role="alert">
        <div class="toast-header"><strong class="me-auto">${esc(label)}</strong>
          <button type="button" class="btn-close" data-bs-dismiss="toast"></button></div>
        <div class="toast-body">${ok} ok, <strong>${fail} failed</strong><ul class="mb-0 mt-1 small">${items}${more}</ul></div></div>`);
    const el = document.getElementById(id);
    new bootstrap.Toast(el).show();
    el.addEventListener('hidden.bs.toast', () => el.remove());
  }
}

class LoadingBar {
  constructor() { this._bar = document.getElementById('loading-bar'); this._txt = document.getElementById('loading-text'); }
  start()             { this._bar.style.width = '5%'; this._txt.style.display = 'none'; }
  setProgress(p, lbl) { this._bar.style.width = Math.min(p, 99) + '%'; if (lbl) { this._txt.textContent = lbl; this._txt.style.display = 'block'; } }
  finish()            { this._bar.style.width = '100%'; this._txt.style.display = 'none'; setTimeout(() => this._bar.style.width = '0%', 400); }
}

class BulkProgressModal {
  constructor() {
    this._modal = new bootstrap.Modal(document.getElementById('bulk-prog-modal'));
    this._title = document.getElementById('bp-title');
    this._bar   = document.getElementById('bp-bar');
    this._count = document.getElementById('bp-count');
    this._errs  = document.getElementById('bp-errs');
    this._log   = document.getElementById('bulk-log');
    this._close = document.getElementById('bp-close');
    this._errCount = 0;
  }
  show(label, total) {
    this._title.textContent = label; this._errCount = 0;
    this._bar.style.width = '0%'; this._count.textContent = `0 / ${total}`;
    this._errs.textContent = ''; this._log.innerHTML = '';
    this._close.classList.add('d-none');
    this._modal.show();
  }
  update(done, total, name, status) {
    const pct = Math.round(done / total * 100);
    this._bar.style.width = pct + '%';
    this._count.textContent = `${done} / ${total}`;
    if (status === 'error') {
      this._errCount++;
      this._errs.textContent = `${this._errCount} error(s)`;
      this._log.insertAdjacentHTML('beforeend', `<div class="log-err">[ERR] ${esc(name)}</div>`);
    } else {
      this._log.insertAdjacentHTML('beforeend', `<div class="log-ok">[ OK] ${esc(name)}</div>`);
    }
    this._log.scrollTop = this._log.scrollHeight;
    if (done >= total) this._close.classList.remove('d-none');
  }
  hide() { try { this._modal.hide(); } catch {} }
}

let _msSeq = 0;

// Dropdown with a searchable checkbox list. Nothing selected means "no restriction".
class MultiSelect {
  constructor(host, { placeholder = 'All', search = true } = {}) {
    this._host = typeof host === 'string' ? document.querySelector(host) : host;
    this._opts = []; this._sel = new Set(); this._ph = placeholder; this._handlers = [];
    this._id = `ms${++_msSeq}`;
    this._host.classList.add('dropdown', 'ms-wrap');
    this._host.innerHTML = `<button type="button" class="form-select form-select-sm text-start ms-btn" data-bs-toggle="dropdown" data-bs-auto-close="outside" aria-expanded="false"></button>
      <div class="dropdown-menu p-2 ms-menu">
        ${search ? '<input type="search" class="form-control form-control-sm mb-2 ms-search" placeholder="Filter…" aria-label="Filter options">' : ''}
        <div class="d-flex gap-3 mb-1 small"><a href="#" class="ms-all">Select shown</a><a href="#" class="ms-none">Clear</a></div>
        <div class="ms-list"></div>
      </div>`;
    this._btn = this._host.querySelector('.ms-btn');
    this._list = this._host.querySelector('.ms-list');
    this._search = this._host.querySelector('.ms-search');
    this._search?.addEventListener('input', () => this._renderList());
    this._list.addEventListener('change', e => {
      const v = e.target.dataset.value;
      if (v == null) return;
      e.target.checked ? this._sel.add(v) : this._sel.delete(v);
      this._changed();
    });
    this._host.querySelector('.ms-all').addEventListener('click', e => { e.preventDefault(); this._shown().forEach(o => this._sel.add(o.value)); this._renderList(); this._changed(); });
    this._host.querySelector('.ms-none').addEventListener('click', e => { e.preventDefault(); this._sel.clear(); this._renderList(); this._changed(); });
    this._renderButton();
  }
  _shown() {
    const q = (this._search?.value || '').trim().toLowerCase();
    return q ? this._opts.filter(o => `${o.label} ${o.hint || ''}`.toLowerCase().includes(q)) : this._opts;
  }
  _renderList() {
    const shown = this._shown();
    this._list.innerHTML = shown.map((o, k) => `<div class="form-check">
        <input class="form-check-input" type="checkbox" id="${this._id}-${k}" data-value="${esc(o.value)}"${this._sel.has(o.value) ? ' checked' : ''}>
        <label class="form-check-label small" for="${this._id}-${k}">${esc(o.label)}${o.hint ? ` <span class="text-muted">${esc(o.hint)}</span>` : ''}</label>
      </div>`).join('') || '<div class="small text-muted">No options</div>';
  }
  _renderButton() {
    const n = this._sel.size;
    const one = n === 1 ? this._opts.find(o => this._sel.has(o.value)) : null;
    this._btn.textContent = !n ? this._ph : (one ? one.label : `${n} selected`);
    this._btn.classList.toggle('ms-active', n > 0);
    this._btn.title = n ? this._opts.filter(o => this._sel.has(o.value)).map(o => o.label).join('\n') : '';
  }
  _changed() { this._renderButton(); this._handlers.forEach(fn => fn(this.values)); }
  setOptions(options) {
    this._opts = options;
    const valid = new Set(options.map(o => o.value));
    [...this._sel].forEach(v => { if (!valid.has(v)) this._sel.delete(v); });
    this._renderList(); this._renderButton();
  }
  get values() { return [...this._sel]; }
  set values(vals) { this._sel = new Set(vals || []); this._renderList(); this._renderButton(); }
  labelOf(v) { return this._opts.find(o => o.value === v)?.label ?? v; }
  onChange(fn) { this._handlers.push(fn); }
}
