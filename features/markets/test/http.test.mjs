import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarketService } from '../server/markets.mjs';
import { createMarketRouter, bearerAuthenticator } from '../server/market-http.mjs';
import { NOW, basic, FAST, context, mockApi, eventually } from './fixtures/synthetic.mjs';
const TOKEN = 'synthetic-test-token-not-for-production';
const auth = { authorization: `Bearer ${TOKEN}` };
const post = body => ({ method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'routepilot-http-'));
  const service = new MarketService({ root, fetchImpl: mockApi(basic()), now: () => NOW, getContext: () => context, ...options });
  await service.ready; await service.configure(FAST);
  const router = createMarketRouter({ service, authenticate: bearerAuthenticator(TOKEN), allowedOrigins: ['http://localhost:5173'] });
  let unrelated = 0;
  const server = createServer((req, res) => {
    router(req, res).then(handled => { if (!handled) { unrelated++; res.writeHead(200); res.end('existing-handler-untouched'); } })
      .catch(error => { res.writeHead(500); res.end(error.message); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await service.close(); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { service, base, request: (path, options = {}) => fetch(`${base}/api/markets${path}`, { headers: auth, ...options }), unrelated: () => unrelated };
}

test('router leaves unrelated paths and the existing flight handler untouched', async t => {
  const { base, unrelated } = await setup(t);
  assert.equal(await (await fetch(`${base}/api/flight/status`)).text(), 'existing-handler-untouched');
  assert.equal(await (await fetch(`${base}/api/markets-other`)).text(), 'existing-handler-untouched'); assert.equal(unrelated(), 2);
});
test('GET is authenticated by default; POST always requires authentication', async t => {
  const { request } = await setup(t);
  assert.equal((await request('/status', { headers: {} })).status, 401);
  assert.equal((await request('/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await request('/status')).status, 200);
});
test('browser origins and non-loopback Host headers are rejected even with a token', async t => {
  const { request, base } = await setup(t);
  assert.equal((await request('/status', { headers: { ...auth, origin: 'https://untrusted.example' } })).status, 403);
  // Node fetch owns the Host header; use the standard HTTP client to actually send a spoofed Host.
  const hostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(`${base}/api/markets/status`, { headers: { ...auth, host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(hostStatus, 403);
  const allowed = await request('/status', { headers: { ...auth, origin: 'http://localhost:5173' } });
  assert.equal(allowed.status, 200); assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:5173');
});
test('preflight is explicitly scoped and never emits wildcard CORS', async t => {
  const { request } = await setup(t);
  const response = await request('/refresh', { method: 'OPTIONS', headers: { origin: 'http://localhost:5173' } });
  assert.equal(response.status, 204); assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:5173');
});
test('POST settings validates JSON and reconfigures without touching flight routes', async t => {
  const { request, service } = await setup(t);
  assert.equal((await request('/settings', post({ credits: 5_000, cargoCapacity: 20, creditReserve: 1_000 }))).status, 200);
  assert.equal((await service.status()).settings.credits, 5_000);
  assert.equal((await request('/settings', post({ credits: -1 }))).status, 400);
  assert.equal((await request('/settings', { method: 'POST', headers: { ...auth, 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await request('/settings', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{bad' })).status, 400);
});
test('refresh responds immediately with a job; duplicate calls share it; cancel is authenticated', async t => {
  let calls = 0;
  const { request, service } = await setup(t, { fetchImpl: () => { calls++; return new Promise(() => {}); } });
  const first = await request('/refresh', post({})); assert.equal(first.status, 202);
  const firstStatus = await first.json(); await eventually(() => calls === 1);
  const second = await (await request('/refresh', post({}))).json(); assert.equal(firstStatus.refresh.id, second.refresh.id); assert.equal(calls, 1);
  const cancelled = await (await request('/cancel', post({}))).json(); assert.equal(cancelled.accepted, true);
  await eventually(async () => !(await service.status()).refresh.running);
  assert.equal((await service.status()).lastAttempt.outcome, 'cancelled');
});
test('GET results validates filters, provides pagination and surfaces missing location as 409', async t => {
  const { request, service } = await setup(t, { getContext: () => null }); await service.refresh();
  const response = await request('/results?limit=1&sort=margin'); assert.equal(response.status, 200); assert.equal((await response.json()).rows.length, 1);
  assert.equal((await request('/results?sort=closestSeller')).status, 409);
  assert.equal((await request('/results?limit=0')).status, 400); assert.equal((await request('/results?limit=1&limit=2')).status, 400);
  assert.equal((await request('/results?unknown=true')).status, 400);
});
test('CSV export has attachment headers, a UTF-8 BOM and conditional-profit labels', async t => {
  const { request, service } = await setup(t); await service.refresh();
  const response = await request('/export?list=all'); assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /attachment/);
  const bytes = Buffer.from(await response.arrayBuffer()); assert.deepEqual([...bytes.subarray(0, 3)], [239, 187, 191]);
  assert.match(bytes.toString('utf8'), /Conditional full-stock profit/);
});
test('method/route/body limits fail clearly without starting a refresh', async t => {
  const { request, service } = await setup(t);
  assert.equal((await request('/refresh')).status, 405); assert.equal((await request('/missing')).status, 404);
  assert.equal((await request('/refresh', post({ unexpected: 1 }))).status, 400);
  assert.equal((await request('/settings', post({ text: 'x'.repeat(70_000) }))).status, 413);
  assert.equal((await service.status()).refresh.running, false);
});
test('HTTP adapter requires authentication configuration and rejects wildcard CORS', () => {
  assert.throws(() => createMarketRouter({ service: {} })); assert.throws(() => bearerAuthenticator('short'));
  assert.throws(() => createMarketRouter({ service: {}, authenticate: () => true, allowedOrigins: ['*'] }));
});
