import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { MarketService } from '../server/markets.mjs';
import { createMarketRouter, bearerAuthenticator } from '../server/market-http.mjs';
import { createMarketClient } from '../ui/market-client.mjs';
import { NOW, FAST, context, station, buyer, mockApi, eventually, jsonResponse } from './fixtures/synthetic.mjs';

test('browser transport → authenticated loopback router → service → mocked source → persisted report and full CSV', async t => {
  const root = await mkdtemp(join(tmpdir(), 'routepilot-end-to-end-'));
  const token = 'synthetic-test-token-not-for-production-1234';
  let fail = false;
  const source = mockApi([...Array.from({ length: 130 }, (_, i) => station(i + 1)), buyer(500)]);
  const service = new MarketService({ root, now: () => NOW, getContext: () => context,
    fetchImpl: (...args) => fail ? Promise.resolve(jsonResponse({ error: 'simulated outage' }, 503)) : source(...args) });
  await service.ready; await service.configure(FAST);
  const route = createMarketRouter({ service, authenticate: bearerAuthenticator(token) });
  let unrelatedCalls = 0;
  const server = createServer((req, res) => {
    route(req, res).then(handled => {
      if (!handled) { unrelatedCalls++; res.writeHead(200, { 'content-type': 'text/plain' }); res.end('existing handler unchanged'); }
    }).catch(error => { res.writeHead(500); res.end(error.message); });
  });
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await service.close(); await rm(root, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = createMarketClient({ baseUrl: `${base}/api/markets`, getToken: () => token });
  assert.equal((await client.status()).hasReport, false);
  const saved = await client.configure({ cargoCapacity: 7, credits: 1000, creditReserve: 100 });
  assert.equal(saved.settings.cargoCapacity, 7);
  await client.refresh();
  await eventually(async () => !(await client.status()).refresh.running);
  const first = await client.results({ sort: 'closestSeller', limit: 100 });
  assert.equal(first.total, 130); assert.equal(first.rows.length, 100); assert.equal(first.rows[0].seller.id, '1');
  assert.equal(first.rows[0].affordableCargoPerTrip, 7);
  assert.equal(first.rows[0].profitPerLoad, 560);
  assert.equal((await client.results({ offset: 100 })).rows.length, 30);
  const csv = await (await client.csv({ limit: 1 })).text();
  assert.equal(csv.trimEnd().split('\r\n').length, 131);
  const committedBytes = await readFile(join(root, 'report.json'), 'utf8');
  fail = true; await client.refresh(); await eventually(async () => !(await client.status()).refresh.running);
  assert.equal((await client.status()).lastAttempt.outcome, 'failed');
  assert.equal((await client.results()).report.id, first.report.id);
  assert.equal(await readFile(join(root, 'report.json'), 'utf8'), committedBytes);
  assert.equal(await (await fetch(`${base}/existing-flight-status`)).text(), 'existing handler unchanged');
  assert.equal(unrelatedCalls, 1);
});
