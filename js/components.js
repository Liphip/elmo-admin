'use strict';

class ToastService {
  constructor() { this._el = document.getElementById('toast-container'); }
  show(msg, type = 'info') {
    const bg = { success: 'bg-success text-white', danger: 'bg-danger text-white', warning: 'bg-warning text-dark', info: 'bg-info text-dark' }[type] || '';
    const delay = (type === 'success' || type === 'info') ? 5000 : 0;
    const id = 'toast-' + Date.now();
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
    const id = 'toast-' + Date.now();
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
