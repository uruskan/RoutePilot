import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TelemetryReader } from './telemetry.mjs';
import { EngineController } from './engine.mjs';
import { MarketService } from '../features/markets/server/markets.mjs';
import { SPREADSHEET_DEFAULT_SETTINGS } from '../features/markets/presets.mjs';
import { createMarketRouter, bearerAuthenticator } from '../features/markets/server/market-http.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2' };

function sendJson(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(data));
}

export function createRoutePilotServer({ root = ROOT, publicDir = path.join(root, 'public'), journalDir,
  telemetry = new TelemetryReader({ journalDir }), engineRoot, spawnWorker, stopProcess,
  marketRoot = path.join(root, 'work', 'markets'), marketFetch, marketNow } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const eligibility = () => {
    const current = telemetry.snapshot();
    const blocked = current.checks.find((check) => !check.ok);
    return { ok: !blocked, reason: blocked?.detail ?? 'Rota hazır. Başlat ile uçuşu etkinleştirin.' };
  };
  const engine = new EngineController({ root, engineRoot, spawnWorker, stopProcess, eligibility });
  const markets = new MarketService({ root: marketRoot, fetchImpl: marketFetch, now: marketNow,
    defaultSettings: SPREADSHEET_DEFAULT_SETTINGS,
    getContext: () => {
      const current = telemetry.snapshot().telemetry;
      return { systemName: current.system, StarPos: current.position ?? null };
    } });
  const authenticateMarket = bearerAuthenticator(token);
  let routeMarkets;
  let closing;

  function snapshot() {
    const current = telemetry.snapshot();
    const blocked = current.checks.find((check) => !check.ok);
    const busy = engine.pendingStart || engine.sentStart || ['loading', 'running'].includes(engine.state.status);
    const available = !engine.child || engine.state.connected;
    return { app: { name: 'RoutePilot', version: '0.1.0' }, engine: { ...engine.state }, ...current,
      activity: engine.activity,
      controls: { canStart: !blocked && !busy && available && !engine.closing,
        canStop: Boolean(engine.child) && (busy || engine.state.status === 'error'),
        startReason: blocked?.detail ?? (busy ? 'Uçuş çalışıyor veya hazırlanıyor.'
          : !available ? 'Uçuş motoru hazır değil.' : 'Rota hazır. Elite Dangerous görünür ve önde kalmalı.') },
      settings: { autoSave: true, unlimitedJumps: true, stopAtDestination: true } };
  }

  const server = http.createServer(async (request, response) => {
    const port = server.address()?.port;
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!allowedHosts.has(request.headers.host)) return sendJson(response, 403, { ok: false, message: 'Geçersiz yerel sunucu adresi.' });
    let url;
    try { url = new URL(request.url, `http://${request.headers.host}`); }
    catch { return sendJson(response, 400, { ok: false, message: 'Geçersiz istek.' }); }
    try {
      if (routeMarkets && await routeMarkets(request, response)) return;
      if (request.method === 'GET' && url.pathname === '/api/health') return sendJson(response, 200, { app: 'RoutePilot', version: '0.1.0' });
      if (request.method === 'GET' && url.pathname === '/api/session') return sendJson(response, 200, { token });
      if (request.method === 'GET' && url.pathname === '/api/state') return sendJson(response, 200, snapshot());
      if (url.pathname === '/api/command') {
        if (request.method !== 'POST') return sendJson(response, 405, { ok: false, message: 'Komutlar yalnızca POST ile gönderilebilir.' });
        const origin = request.headers.origin;
        if (origin !== undefined && origin !== `http://${request.headers.host}`) return sendJson(response, 403, { ok: false, message: 'İstek kaynağı doğrulanamadı.' });
        const supplied = request.headers['x-routepilot-token'];
        const suppliedBytes = typeof supplied === 'string' ? Buffer.from(supplied) : Buffer.alloc(0);
        const expectedBytes = Buffer.from(token);
        if (suppliedBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(suppliedBytes, expectedBytes)) {
          return sendJson(response, 403, { ok: false, message: 'Oturum anahtarı geçersiz; sayfayı yenileyin.' });
        }
        if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) return sendJson(response, 415, { ok: false, message: 'JSON içerik türü gerekli.' });
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 4096) { sendJson(response, 413, { ok: false, message: 'Komut çok büyük.' }); return; }
          chunks.push(chunk);
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return sendJson(response, 400, { ok: false, message: 'Geçersiz JSON.' }); }
        if (!body || typeof body !== 'object' || Array.isArray(body) || !['start', 'stop', 'save', 'shutdown'].includes(body.action)) {
          return sendJson(response, 400, { ok: false, message: 'Geçersiz komut.' });
        }
        if (body.action === 'shutdown') {
          sendJson(response, 200, { ok: true, message: 'RoutePilot kapatılıyor.' });
          setImmediate(() => { void close(); });
          return;
        }
        const result = engine.command(body.action);
        return sendJson(response, result.status, { ok: result.ok, message: result.message });
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return sendJson(response, 405, { ok: false, message: 'Yöntem desteklenmiyor.' });
      if (url.pathname.startsWith('/api/')) return sendJson(response, 404, { ok: false, message: 'API bulunamadı.' });
      let requested;
      try { requested = decodeURIComponent(url.pathname); }
      catch { return sendJson(response, 400, { ok: false, message: 'Geçersiz dosya yolu.' }); }
      if (requested.includes('\0') || requested.includes('\\')) return sendJson(response, 403, { ok: false, message: 'Dosya yolu reddedildi.' });
      const file = path.resolve(publicDir, `.${requested === '/' ? '/index.html' : requested}`);
      const publicRoot = path.resolve(publicDir);
      if (!file.startsWith(publicRoot + path.sep)) return sendJson(response, 403, { ok: false, message: 'Dosya yolu reddedildi.' });
      let realFile;
      try {
        realFile = fs.realpathSync(file);
        const realRoot = fs.realpathSync(publicDir);
        if (!realFile.startsWith(realRoot + path.sep) || !fs.statSync(realFile).isFile()) throw new Error('outside');
      } catch { return sendJson(response, 404, { ok: false, message: 'Arayüz dosyası bulunamadı. Önce arayüzü derleyin.' }); }
      response.writeHead(200, { 'Content-Type': TYPES[path.extname(realFile)] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      if (request.method === 'HEAD') response.end();
      else fs.createReadStream(realFile).on('error', () => response.destroy()).pipe(response);
    } catch (error) {
      if (!response.headersSent) sendJson(response, 500, { ok: false, message: 'Yerel işlem tamamlanamadı.' });
      else response.destroy();
      engine.addActivity('error', 'Sunucu işlemi başarısız', error.message);
    }
  });
  server.once('close', () => { void engine.close(); void markets.close(); });

  async function close() {
    if (closing) return closing;
    closing = (async () => {
      const closed = new Promise((resolve) => { server.close(resolve); server.closeIdleConnections?.(); });
      await Promise.all([engine.close(), markets.close()]);
      await closed;
    })();
    return closing;
  }

  return { server, engine, telemetry, markets, snapshot, close,
    listen: async (port = 47856) => {
      await markets.ready;
      const address = await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        const bound = server.address();
        routeMarkets = createMarketRouter({ service: markets, authenticate: authenticateMarket,
          allowedOrigins: [`http://127.0.0.1:${bound.port}`, `http://localhost:${bound.port}`] });
        resolve(bound);
      });
      });
      await markets.startScheduler();
      return address;
    } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createRoutePilotServer();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close(); });
  process.once('uncaughtException', (error) => { console.error(error); void app.close().finally(() => { process.exitCode = 1; }); });
  process.once('unhandledRejection', (error) => { console.error(error); void app.close().finally(() => { process.exitCode = 1; }); });
  try { await app.listen(); console.log('RoutePilot: http://127.0.0.1:47856'); }
  catch (error) { console.error(`RoutePilot açılamadı: ${error.message}`); process.exitCode = 1; }
}
