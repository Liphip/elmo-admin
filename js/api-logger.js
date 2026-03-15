'use strict';

class ApiLogger {
  constructor(maxEntries = 500) {
    this.maxEntries = maxEntries;
    this.logs = this._load();
  }

  _load() {
    try {
      const data = localStorage.getItem('deviceAdminApiLog');
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  }

  _save() {
    try {
      localStorage.setItem('deviceAdminApiLog', JSON.stringify(this.logs));
    } catch (e) {
      console.warn('Failed to save API log:', e);
    }
  }

  _anonymizeUrl(url) {
    try {
      const urlObj = new URL(url);
      const params = new URLSearchParams(urlObj.search);
      if (params.has('auth')) {
        params.set('auth', '***');
        urlObj.search = params.toString();
      }
      return urlObj.toString();
    } catch {
      return url.replace(/auth=[^&]*/g, 'auth=***');
    }
  }

  log(method, url, path, status, duration, error = null) {
    const anonymizedUrl = this._anonymizeUrl(url);
    const entry = {
      id: Date.now() + Math.random().toString(36).substr(2, 9),
      method: method.toUpperCase(),
      url: anonymizedUrl,
      path: path,
      status: status,
      duration: duration,
      error: error,
      timestamp: new Date().toISOString()
    };
    this.logs.unshift(entry);
    if (this.logs.length > this.maxEntries) {
      this.logs = this.logs.slice(0, this.maxEntries);
    }
    this._save();
    return entry;
  }

  getLogs() {
    return this.logs;
  }

  clear() {
    this.logs = [];
    this._save();
  }

  setMaxEntries(n) {
    this.maxEntries = Math.max(1, Math.min(10000, parseInt(n) || 500));
    if (this.logs.length > this.maxEntries) {
      this.logs = this.logs.slice(0, this.maxEntries);
      this._save();
    }
  }

  getMaxEntries() {
    return this.maxEntries;
  }

  export() {
    return JSON.stringify(this.logs, null, 2);
  }

  filter(query) {
    if (!query) return this.logs;
    const q = query.toLowerCase();
    return this.logs.filter(log => 
      log.method.toLowerCase().includes(q) ||
      log.path.toLowerCase().includes(q) ||
      (log.url && log.url.toLowerCase().includes(q)) ||
      String(log.status).includes(q)
    );
  }
}
