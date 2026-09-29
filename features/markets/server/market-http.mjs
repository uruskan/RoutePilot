/** Optional, isolated Node HTTP adapter. Returns false without touching non-market routes. */
import { timingSafeEqual } from 'node:crypto';
import { MarketError, ValidationError, parseResultQuery } from './markets.mjs';

export function bearerAuthenticator(token) {
  if (typeof token !== 'string' || token.length < 24) throw new ValidationError('Use a high-entropy bearer token of at least 24 characters.');
  const expected = Buffer.from(`Bearer ${token}`);
  return req => {
    const supplied = Buffer.from(typeof req.headers.authorization === 'string' ? req.headers.authorization : '');
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  };
}
function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
}
function isLoopback(value) {
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}
function validHost(host) {
  if (typeof host !== 'string') return false;
  const match = /^(127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?$/i.exec(host);
  return Boolean(match && (!match[2] || (Number(match[2]) > 0 && Number(match[2]) <= 65535)));
}
async function bodyJson(req, maximum = 64 * 1024) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new MarketError('CONTENT_TYPE', 'POST requests require Content-Type: application/json.');
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maximum) throw new MarketError('BODY_TOO_LARGE', 'Request body is too large.');
  let bytes = 0;
  const chunks = [];
  const read = new Promise((resolvePromise, reject) => {
    const cleanup = () => {
      clearTimeout(timer); req.off('data', data); req.off('end', end); req.off('error', fail); req.off('aborted', aborted);
    };
    const fail = error => { cleanup(); reject(error); };
    const aborted = () => fail(new MarketError('BAD_REQUEST', 'Request was aborted.'));
    const data = chunk => {
      bytes += chunk.length;
      if (bytes > maximum) { req.pause(); fail(new MarketError('BODY_TOO_LARGE', 'Request body is too large.')); return; }
      chunks.push(chunk);
    };
    const end = () => { cleanup(); resolvePromise(Buffer.concat(chunks).toString('utf8')); };
    const timer = setTimeout(() => { req.pause(); fail(new MarketError('REQUEST_TIMEOUT', 'Request body timed out.')); }, 10_000);
    req.on('data', data); req.once('end', end); req.once('error', fail); req.once('aborted', aborted);
  });
  const raw = await read;
  let value;
  try { value = raw.trim() ? JSON.parse(raw) : {}; }
  catch { throw new ValidationError('Request body must contain valid JSON.'); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Request body must be a JSON object.');
  return value;
}

export function createMarketRouter({ service, authenticate, prefix = '/api/markets',
  allowedOrigins = ['http://127.0.0.1:47856'], authenticateReads = true } = {}) {
  if (!service || typeof authenticate !== 'function') throw new ValidationError('service and an authentication callback are required.');
  if (!/^\/[a-zA-Z0-9/_-]+$/.test(prefix) || prefix.endsWith('/')) throw new ValidationError('Use an absolute prefix without a trailing slash.');
  if (!Array.isArray(allowedOrigins) || allowedOrigins.some(origin => typeof origin !== 'string' || origin === '*')) throw new ValidationError('Use an explicit list of trusted renderer origins, never *.');
  const trusted = new Set(allowedOrigins);
  const routes = new Map([['/status', 'GET'], ['/results', 'GET'], ['/export', 'GET'],
    ['/refresh', 'POST'], ['/cancel', 'POST'], ['/settings', 'POST']]);
  return async function routeMarkets(req, res) {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return false; }
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return false;
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    try {
      if (!isLoopback(req.socket?.remoteAddress) || !validHost(req.headers.host)) throw new MarketError('FORBIDDEN', 'Market endpoints accept only loopback requests with a loopback Host.');
      const origin = req.headers.origin;
      if (origin && !trusted.has(origin)) throw new MarketError('FORBIDDEN', 'Renderer origin is not allowed.');
      if (origin) {
        res.setHeader('access-control-allow-origin', origin); res.setHeader('vary', 'Origin');
        res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
        res.setHeader('access-control-allow-headers', 'Authorization, Content-Type');
      }
      const path = url.pathname.slice(prefix.length), method = routes.get(path);
      if (!method) { json(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown market endpoint.' } }); return true; }
      if (req.method === 'OPTIONS') { res.writeHead(204, { allow: `${method}, OPTIONS` }); res.end(); return true; }
      if (req.method !== method) { res.setHeader('allow', `${method}, OPTIONS`); json(res, 405, { error: { code: 'METHOD', message: 'Method not allowed.' } }); return true; }
      if ((method === 'POST' || authenticateReads) && !await authenticate(req)) {
        res.setHeader('www-authenticate', 'Bearer'); throw new MarketError('UNAUTHORIZED', 'Authentication required.');
      }
      if (method === 'GET') {
        if (path === '/status') {
          if (url.search) throw new ValidationError('status does not accept query parameters.');
          json(res, 200, await service.status());
        } else {
          const query = parseResultQuery(url.searchParams);
          if (path === '/results') json(res, 200, await service.results(query));
          else {
            const csv = await service.csv(query);
            res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8',
              'content-disposition': 'attachment; filename="routepilot-trades.csv"' });
            res.end(csv);
          }
        }
      } else {
        if (url.search) throw new ValidationError('POST endpoints do not accept query parameters.');
        const body = await bodyJson(req);
        if (path === '/settings') json(res, 200, { settings: await service.configure(body) });
        else {
          if (Object.keys(body).length) throw new ValidationError('refresh and cancel accept only an empty JSON object.');
          if (path === '/cancel') json(res, 200, { accepted: service.cancel(), status: await service.status() });
          else {
            const current = await service.status();
            if (current.closed) throw new MarketError('CLOSED', 'The market service is closed.');
            if (current.storage.readOnly) throw new MarketError('READ_ONLY', 'The market service is read-only.');
            const pending = service.refresh();
            pending.catch(() => {}); // Operational failures are available through status.lastAttempt.
            json(res, 202, await service.status());
          }
        }
      }
    } catch (error) {
      if (!res.headersSent && !res.destroyed) {
        const status = { VALIDATION: 400, BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403,
          CONTENT_TYPE: 415, BODY_TOO_LARGE: 413, REQUEST_TIMEOUT: 408,
          LOCATION_UNAVAILABLE: 409, STORAGE_BUSY: 409, READ_ONLY: 409, CLOSED: 503 }[error.code] || 500;
        if (['BODY_TOO_LARGE', 'REQUEST_TIMEOUT'].includes(error.code)) res.setHeader('connection', 'close');
        json(res, status, { error: { code: error.code || 'INTERNAL',
          message: error instanceof MarketError ? error.message : 'The market request failed.' } });
      } else if (!res.destroyed) res.end();
    }
    return true;
  };
}
