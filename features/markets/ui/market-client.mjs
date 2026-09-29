/** Browser-only transport helpers; no Electron/Node privileges. */
export class MarketClientError extends Error {
  constructor(code, message, status = 0) { super(message); this.name = 'MarketClientError'; this.code = code; this.status = status; }
}
function raceAbort(promise, signal) {
  if (signal.aborted) { Promise.resolve(promise).catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
export function createMarketClient({ baseUrl = 'http://127.0.0.1:47856/api/markets',
  getToken = () => null, fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  const base = new URL(baseUrl, globalThis.location?.href || 'http://127.0.0.1:47856');
  if (!['http:', 'https:'].includes(base.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password || base.search || base.hash) {
    throw new MarketClientError('CONFIG', 'MarketPanel must target an explicit loopback HTTP URL without credentials, query or fragment.');
  }
  if (typeof fetchImpl !== 'function' || typeof getToken !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new MarketClientError('CONFIG', 'Invalid market client configuration.');
  const prefix = base.href.replace(/\/$/, '');
  async function request(path, { method = 'GET', query = {}, body, signal, csv = false } = {}) {
    const controller = new AbortController();
    const stop = () => controller.abort(signal.reason || new DOMException('Aborted', 'AbortError'));
    if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
    const timeout = setTimeout(() => controller.abort(new MarketClientError('TIMEOUT', 'The local market service did not respond in time.')), timeoutMs);
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      const operation = (async () => {
        const token = await getToken();
        if (controller.signal.aborted) throw controller.signal.reason;
        if (token !== null && token !== undefined && typeof token !== 'string') throw new MarketClientError('AUTH', 'getToken() must return a string or null.');
        const url = new URL(`${prefix}${path}`);
        for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, value === null ? 'null' : String(value));
        const response = await fetchImpl(url.href, { method, signal: controller.signal, credentials: 'omit',
          cache: 'no-store', redirect: 'error', headers: { accept: csv ? 'text/csv' : 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        if (!response.ok) {
          let payload;
          try { payload = await response.json(); } catch {}
          throw new MarketClientError(payload?.error?.code || 'HTTP', payload?.error?.message || `Market service returned HTTP ${response.status}.`, response.status);
        }
        if (csv) return response.blob();
        try { return await response.json(); }
        catch { throw new MarketClientError('SCHEMA', 'The local market service returned invalid JSON.'); }
      })();
      return await raceAbort(operation, controller.signal);
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', stop); }
  }
  return {
    status: signal => request('/status', { signal }),
    results: (query = {}, signal) => request('/results', { query, signal }),
    refresh: signal => request('/refresh', { method: 'POST', body: {}, signal }),
    cancel: signal => request('/cancel', { method: 'POST', body: {}, signal }),
    configure: (patch, signal) => request('/settings', { method: 'POST', body: patch, signal }),
    csv: (query = {}, signal) => request('/export', { query, signal, csv: true }),
  };
}

export const DRAFT_FIELDS = Object.freeze(['cargoCapacity', 'credits', 'creditReserve', 'windowHours',
  'minStock', 'maxMarketAgeHours', 'requiredPad', 'maxPlayerDistanceLy', 'maxRouteDistanceLy',
  'allowUnknownPad', 'allowPermitSystems', 'allowPlanetary', 'excludePotentiallyCorrosive', 'dailyRefresh', 'dailyUtcHour']);
const NULLABLE = new Set(['cargoCapacity', 'credits', 'maxMarketAgeHours', 'maxPlayerDistanceLy', 'maxRouteDistanceLy']);
const BOOLEAN = new Set(['allowUnknownPad', 'allowPermitSystems', 'allowPlanetary', 'excludePotentiallyCorrosive', 'dailyRefresh']);
export function settingsToDraft(settings) {
  return Object.fromEntries(DRAFT_FIELDS.map(key => [key, BOOLEAN.has(key) ? settings[key] : settings[key] ?? '']));
}
export function draftToPatch(draft) {
  const patch = {};
  for (const key of DRAFT_FIELDS) {
    const value = draft[key];
    if (BOOLEAN.has(key)) { if (typeof value !== 'boolean') throw new MarketClientError('VALIDATION', `${key} must be a checkbox value.`); patch[key] = value; }
    else if (key === 'requiredPad') patch[key] = value;
    else if (value === '' || value === null || value === undefined) {
      if (!NULLABLE.has(key)) throw new MarketClientError('VALIDATION', `${key} is required.`);
      patch[key] = null;
    } else {
      if ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim() || !Number.isFinite(Number(value))) throw new MarketClientError('VALIDATION', `${key} must be numeric.`);
      patch[key] = Number(value);
    }
  }
  return patch;
}
export function formatNumber(value, digits = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(value) : 'Unknown';
}
export function formatAge(hours) {
  if (typeof hours !== 'number' || !Number.isFinite(hours)) return 'Age unknown';
  if (hours < 0) return 'Future timestamp';
  if (hours < 1 / 60) return '<1 min old';
  if (hours < 1) return `${Math.floor(hours * 60)} min old`;
  if (hours < 24) return `${formatNumber(hours, 1)} h old`;
  return `${formatNumber(hours / 24, 1)} days old`;
}
