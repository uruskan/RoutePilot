import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRoutePilotServer } from '../server/index.mjs';
import { TelemetryReader } from '../server/telemetry.mjs';
import { runCli } from '../cli/routepilot.mjs';
import { openMarketSource } from '../desktop/market-links.mjs';
import { station, buyer, mockApi, NOW, FAST } from '../features/markets/test/fixtures/synthetic.mjs';

test('market HTTP/CLI use shared auth, current location, full CSV and persisted settings without starting flight', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'routepilot-market-host-'));
  let position = [0, 0, 0], workers = 0;
  const records = [...Array.from({ length: 125 }, (_, i) => station(i + 1, { type: 'Drake-Class Carrier' })), buyer(999)];
  const options = { root, telemetry: { snapshot: () => ({ telemetry: { system: 'Live position', position },
    route: {}, checks: [{ id: 'test', ok: false, detail: 'No test flight' }] }) },
    spawnWorker: () => { workers++; throw new Error('Flight must never start'); }, marketFetch: mockApi(records), marketNow: () => NOW };
  let app = createRoutePilotServer(options);
  t.after(async () => { await app.close(); await fs.rm(root, { recursive: true, force: true }); });
  const { port } = await app.listen(0), base = `http://127.0.0.1:${port}`;
  const { token } = await (await fetch(`${base}/api/session`)).json();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: base };
  assert.equal((await fetch(`${base}/api/markets/status`)).status, 401);
  assert.equal((await fetch(`${base}/api/markets/status`, { headers: { ...headers, Origin: 'https://other.example' } })).status, 403);
  assert.equal((await fetch(`${base}/api/markets/refresh`, { headers })).status, 405);
  const initial = await app.markets.status();
  assert.equal(initial.settings.minStock, 100);
  assert.equal(initial.settings.maxMarketAgeHours, 48);
  assert.equal(initial.settings.maxRouteDistanceLy, 150);
  assert.equal(initial.settings.windowHours, 192);
  assert.equal(initial.settings.defaultSort, 'stockProfit');
  // This pagination fixture deliberately includes tiny, far-away lots.
  const settings = { ...FAST, minStock: 1, maxRouteDistanceLy: null,
    cargoCapacity: 1232, credits: 220000000, creditReserve: 20000000 };
  assert.equal((await fetch(`${base}/api/markets/settings`, { method: 'POST', headers, body: JSON.stringify(settings) })).status, 200);
  const out = [], err = [], cli = { baseUrl: base, out: value => out.push(value), err: value => err.push(value), pollMs: 1 };
  assert.equal(await runCli(['markets', 'refresh'], cli), 0, err.join('\n'));
  let result = await (await fetch(`${base}/api/markets/results?sort=closestSeller&limit=100`, { headers })).json();
  assert.equal(result.total, 125); assert.equal(result.rows.length, 100); assert.equal(result.hasMore, true);
  assert.equal(result.rows[0].seller.id, '1');
  position = [1250, 0, 0];
  result = await (await fetch(`${base}/api/markets/results?sort=closestSeller`, { headers })).json();
  assert.equal(result.rows[0].seller.id, '125'); assert.equal(result.rows[0].playerToSellerLy, 0);
  const csvPath = path.join(root, 'export.csv');
  assert.equal(await runCli(['markets', 'export', csvPath, '--sort', 'closestSeller'], cli), 0);
  const csv = await fs.readFile(csvPath, 'utf8');
  assert.equal(csv.trim().split(/\r?\n/).length, 126);
  assert.equal(await runCli(['markets', 'list', '--limit', '1'], cli), 0);
  position = null;
  assert.equal((await fetch(`${base}/api/markets/results?sort=closestSeller`, { headers })).status, 409);
  assert.equal((await fetch(`${base}/api/state`)).status, 200);
  assert.equal(workers, 0);
  await app.close();
  app = createRoutePilotServer(options);
  await app.listen(0);
  const restored = await app.markets.status();
  assert.equal(restored.hasReport, true); assert.equal(restored.settings.cargoCapacity, 1232);
  assert.equal(restored.scheduler.started, true); assert.equal(restored.scheduler.enabled, false);
  assert.equal(workers, 0);
});

test('journal coordinates follow jumps, are copied and become unknown across sessions or incomplete events', () => {
  const reader = new TelemetryReader({ journalDir: 'missing-test-journals' });
  reader.processEvent({ event: 'Location', StarSystem: 'A', StarPos: [1, 2, 3] });
  const value = reader.snapshot().telemetry.position;
  value[0] = 99;
  assert.deepEqual(reader.snapshot().telemetry.position, [1, 2, 3]);
  reader.processEvent({ event: 'CarrierJump', StarSystem: 'B', StarPos: [4, 5, 6] });
  assert.deepEqual(reader.snapshot().telemetry.position, [4, 5, 6]);
  reader.processEvent({ event: 'FSDJump', StarSystem: 'C' });
  assert.equal(reader.snapshot().telemetry.position, null);
  reader.processEvent({ event: 'Location', StarSystem: 'A', StarPos: [1, 2, 3] });
  reader.processEvent({ event: 'LoadGame' });
  assert.equal(reader.snapshot().telemetry.position, null);
  reader.processEvent({ event: 'Location', StarSystem: 'A', StarPos: [1, 2, 3] });
  reader.processEvent({ event: 'Shutdown' });
  assert.equal(reader.snapshot().telemetry.position, null);
});

test('desktop opens only exact Spansh station links when clicked', async () => {
  const opened = [];
  for (const url of ['file:///C:/Windows/System32/cmd.exe', 'https://evil.example/station/123',
    'https://spansh.co.uk.evil.example/station/123', 'https://user@spansh.co.uk/station/123',
    'https://spansh.co.uk/station/123?redirect=elsewhere', 'http://spansh.co.uk/station/123']) {
    assert.equal(await openMarketSource(url, value => opened.push(value)), false);
  }
  assert.equal(await openMarketSource('https://spansh.co.uk/station/123', value => opened.push(value)), true);
  assert.deepEqual(opened, ['https://spansh.co.uk/station/123']);
});
