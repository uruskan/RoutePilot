import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarketService, atomicWriteJson } from '../server/markets.mjs';
import { NOW, HOUR, at, basic, station, buyer, quote, FAST, context, mockApi, eventually, jsonResponse } from './fixtures/synthetic.mjs';
async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'routepilot-markets-test-'));
  const api = options.fetchImpl || mockApi(basic());
  const service = new MarketService({ root, fetchImpl: api, now: () => NOW, getContext: () => context, ...options });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  await service.ready; await service.configure(FAST);
  return { root, api, service };
}

test('empty status/results do not access the network and show no fabricated report', async t => {
  const { service, api } = await setup(t);
  assert.equal((await service.status()).hasReport, false); assert.equal((await service.results()).total, 0); assert.equal(api.calls.length, 0);
});
test('successful refresh atomically persists source and computed reference results', async t => {
  const { service, root } = await setup(t);
  const outcome = await service.refresh(); assert.equal(outcome.outcome, 'succeeded');
  const saved = JSON.parse(await readFile(join(root, 'report.json'), 'utf8'));
  assert.equal(saved.stationSnapshot.count, 2); assert.equal(saved.referenceOpportunityCount, 1); assert.equal(saved.coverage.complete, true);
  assert.equal(Object.hasOwn(saved, 'stations'), false); assert.equal(Object.hasOwn(saved, 'opportunities'), false);
  assert.equal((await service.results()).total, 1); assert.ok(!(await readdir(root)).some(name => name.includes('.tmp-')));
});
test('a failed refresh retains both last successful file bytes and last successful in-memory report', async t => {
  let fail = false; const normal = mockApi(basic());
  const { service, root } = await setup(t, { fetchImpl: (...args) => fail ? Promise.resolve(jsonResponse({ error: 'failure' }, 503)) : normal(...args) });
  const success = await service.refresh(); const before = await readFile(join(root, 'report.json'), 'utf8'); fail = true;
  const failure = await service.refresh(); assert.equal(failure.outcome, 'failed'); assert.equal(failure.retainedReportId, success.id);
  assert.equal(await readFile(join(root, 'report.json'), 'utf8'), before); assert.equal((await service.results()).report.id, success.id);
  assert.equal((await service.status()).lastAttempt.outcome, 'failed');
});
test('cancellation retains the prior report and duplicate refresh calls return the identical promise', async t => {
  let blocked = false, entered = false; const normal = mockApi(basic());
  const { service, root } = await setup(t, { fetchImpl: (...args) => {
    if (!blocked) return normal(...args); entered = true; return new Promise(() => {});
  } });
  await service.refresh(); const before = await readFile(join(root, 'report.json'), 'utf8'); blocked = true;
  const first = service.refresh(), duplicate = service.refresh(); assert.equal(first, duplicate);
  await eventually(() => entered); assert.equal(service.cancel(), true); assert.equal(service.cancel(), false);
  assert.equal((await first).outcome, 'cancelled'); assert.equal(await readFile(join(root, 'report.json'), 'utf8'), before);
  assert.equal((await service.status()).scheduler.failureCount, 0); assert.equal(service.cancel(), false);
});
test('refreshing twice re-queries a moving rolling window; a complete prior report never freezes data', async t => {
  let now = NOW; const api = mockApi(basic());
  const { service } = await setup(t, { fetchImpl: api, now: () => now });
  await service.refresh(); now += HOUR;
  api.setRecords([station(1, { market_updated_at: at(0), market: [quote({ supply: 30 })] }), buyer(2)]);
  await service.refresh(); assert.equal(api.calls.length, 2);
  assert.notDeepEqual(api.calls[0].body.filters.market_updated_at.value, api.calls[1].body.filters.market_updated_at.value);
  assert.equal((await service.results()).rows[0].stock, 30);
});
test('results recompute budget/reserve, age and live context without another network request', async t => {
  let now = NOW, location = context;
  const { service, api } = await setup(t, { now: () => now, getContext: () => location });
  await service.refresh(); const requests = api.calls.length;
  await service.configure({ credits: 1_000, cargoCapacity: 20, creditReserve: 100 });
  assert.equal((await service.results()).rows[0].affordableCargoPerTrip, 9);
  location = { systemName: 'Moved', StarPos: [10, 0, 0] };
  assert.equal((await service.results()).rows[0].playerToSellerLy, 0);
  now += 25 * HOUR; assert.equal((await service.results()).total, 0);
  assert.equal((await service.status()).report.collectedAt, new Date(NOW).toISOString()); assert.equal(api.calls.length, requests);
});
test('paginated results and CSV preserve more than 100 opportunities', async t => {
  const api = mockApi([...Array.from({ length: 170 }, (_, i) => station(i + 1)), buyer(500)]);
  const { service } = await setup(t, { fetchImpl: api }); await service.refresh();
  const first = await service.results(), second = await service.results({ offset: 100 });
  assert.equal(first.total, 170); assert.equal(first.rows.length, 100); assert.equal(first.hasMore, true);
  assert.equal(second.rows.length, 70); assert.equal(new Set([...first.rows, ...second.rows].map(row => row.id)).size, 170);
  const csv = await service.csv({ limit: 1, offset: 100 }); assert.equal(csv.trimEnd().split('\r\n').length, 171);
});
test('persistence round-trip never reuses the previous process journal position', async t => {
  const { service, root } = await setup(t); await service.configure({ cargoCapacity: 8, credits: 2_000 }); await service.refresh();
  await service.close();
  const second = new MarketService({ root, now: () => NOW, fetchImpl: async () => { throw new Error('No network allowed'); } });
  t.after(() => second.close()); await second.ready;
  assert.equal((await second.status()).settings.cargoCapacity, 8); assert.equal((await second.results()).total, 1);
  assert.equal((await second.results()).rows[0].playerToSellerLy, null);
  await assert.rejects(second.results({ sort: 'closestSeller' }), { code: 'LOCATION_UNAVAILABLE' });
  await second.close();
});
test('concurrent configure calls serialize their patches without lost updates', async t => {
  const { service, root } = await setup(t);
  await Promise.all([service.configure({ credits: 111 }), service.configure({ cargoCapacity: 22 }), service.configure({ creditReserve: 10 })]);
  const saved = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'));
  assert.equal(saved.settings.credits, 111); assert.equal(saved.settings.cargoCapacity, 22); assert.equal(saved.settings.creditReserve, 10);
});
test('invalid settings leave existing persisted state unchanged', async t => {
  const { service, root } = await setup(t); const before = await readFile(join(root, 'state.json'), 'utf8');
  await assert.rejects(service.configure({ cargoCapacity: -1 }), { code: 'VALIDATION' });
  assert.equal(await readFile(join(root, 'state.json'), 'utf8'), before);
});
test('one writer owns a root, while a read-only reader can safely open the last report', async t => {
  const { service, root } = await setup(t); await service.refresh();
  const second = new MarketService({ root, now: () => NOW });
  await assert.rejects(second.ready, { code: 'STORAGE_BUSY' }); await second.close();
  const reader = new MarketService({ root, now: () => NOW, readOnly: true });
  await reader.ready; assert.equal((await reader.results()).total, 1);
  await assert.rejects(reader.configure({ credits: 1 }), { code: 'READ_ONLY' });
  await assert.rejects(reader.refresh(), { code: 'READ_ONLY' }); await reader.close();
  assert.equal((await service.refresh()).outcome, 'succeeded');
});
test('corrupt state fails closed without replacing user settings and releases its lock', async t => {
  const root = await mkdtemp(join(tmpdir(), 'routepilot-corrupt-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'state.json'), '{broken');
  const service = new MarketService({ root }); await assert.rejects(service.ready, { code: 'STORAGE' }); await service.close();
  assert.equal(await readFile(join(root, 'state.json'), 'utf8'), '{broken');
  assert.ok(!(await readdir(root)).includes('.routepilot-markets.lock'));
});
test('corrupt report is surfaced as a warning and can only be replaced by a successful refresh', async t => {
  const { service, root } = await setup(t); await service.close(); await writeFile(join(root, 'report.json'), '{broken');
  const second = new MarketService({ root, now: () => NOW, fetchImpl: mockApi(basic()) });
  await second.ready; const status = await second.status(); assert.equal(status.hasReport, false); assert.ok(status.warnings.length > 0);
  assert.equal((await second.refresh()).outcome, 'succeeded'); assert.equal((await second.results()).total, 1); await second.close();
});
test('interrupted saved refresh is recovered with backoff and its last report intact', async t => {
  const { service, root } = await setup(t); const success = await service.refresh(); await service.close();
  const saved = JSON.parse(await readFile(join(root, 'state.json'), 'utf8')); saved.schedule.lastOutcome = 'running';
  await writeFile(join(root, 'state.json'), JSON.stringify(saved));
  const second = new MarketService({ root, now: () => NOW }); await second.ready;
  const status = await second.status(); assert.equal(status.lastAttempt.outcome, 'interrupted'); assert.equal(status.report.id, success.id);
  assert.equal(status.scheduler.nextRetryAt, new Date(NOW + 1_000).toISOString()); await second.close();
});
test('incomplete coverage is visible in status but never replaces a prior successful report', async t => {
  const { service, api } = await setup(t); const prior = await service.refresh(); await service.configure({ queryResultCap: 2, maxSplitDepth: 0 });
  const outcome = await service.refresh(); assert.equal(outcome.error.code, 'INCOMPLETE_COVERAGE');
  assert.equal(outcome.error.details.complete, false); assert.equal((await service.status()).report.id, prior.id); assert.equal(api.calls.length, 2);
});
test('context provider failure becomes explicit unknown rather than a refresh failure', async t => {
  const { service } = await setup(t, { getContext: () => { throw new Error('Journal unavailable'); } });
  assert.equal((await service.refresh()).outcome, 'succeeded');
  const status = await service.status(); assert.equal(status.context.positionAvailable, false); assert.match(status.context.warning, /Journal unavailable/);
});
test('a saved distance-from-me preference cannot prevent collection when the journal is absent', async t => {
  const { service } = await setup(t, { getContext: () => null });
  await service.configure({ maxPlayerDistanceLy: 100 }); assert.equal((await service.refresh()).outcome, 'succeeded');
  await assert.rejects(service.results(), { code: 'LOCATION_UNAVAILABLE' });
  assert.equal((await service.results({ maxPlayerDistanceLy: null })).total, 1);
});
test('close aborts active work, waits for cleanup and releases the storage lock', async t => {
  let entered = false;
  const { service, root } = await setup(t, { fetchImpl: () => { entered = true; return new Promise(() => {}); } });
  const pending = service.refresh(); await eventually(() => entered); await service.close();
  assert.equal((await pending).outcome, 'cancelled'); assert.ok(!(await readdir(root)).includes('.routepilot-markets.lock'));
  await assert.rejects(service.results(), { code: 'CLOSED' }); await assert.rejects(service.refresh(), { code: 'CLOSED' });
});
test('accepted cancellation before an atomic write leaves the old JSON unchanged', async t => {
  const root = await mkdtemp(join(tmpdir(), 'routepilot-atomic-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'value.json'); await atomicWriteJson(path, { original: true });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(atomicWriteJson(path, { replaced: true }, { signal: controller.signal }), { code: 'CANCELLED' });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { original: true }); assert.deepEqual(await readdir(root), ['value.json']);
});

test('caller mutations of returned coordinates and metadata cannot alter later analyses', async t => {
  const { service } = await setup(t); await service.refresh();
  const first = await service.results();
  first.rows[0].seller.coordinates[0] = 999_999;
  first.rows[0].buyer.coordinates[0] = -999_999;
  first.context.StarPos[0] = 1234;
  first.report.coverage.complete = false;
  const later = await service.results();
  assert.equal(later.rows[0].playerToSellerLy, 10);
  assert.equal(later.rows[0].sellerToBuyerLy, 10);
  assert.equal(later.report.coverage.complete, true);
});
