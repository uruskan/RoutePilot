import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarketService, nextDailyRun, validateSettings } from '../server/markets.mjs';
import { NOW, HOUR, basic, FAST, mockApi, jsonResponse, fakeScheduler, eventually } from './fixtures/synthetic.mjs';
const DAY = 24 * HOUR;
async function setup(t, { fetchImpl, clock = fakeScheduler() } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'routepilot-schedule-'));
  const api = fetchImpl || mockApi(() => basic().map(row => ({ ...row, market_updated_at: new Date(clock.now() - HOUR).toISOString() })));
  const service = new MarketService({ root, fetchImpl: api, now: clock.now, timers: clock.timers });
  await service.ready; await service.configure({ ...FAST, dailyRefresh: true, dailyUtcHour: 3 });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  return { service, root, api, clock };
}
const settled = service => eventually(async () => {
  const s = await service.status(); return !s.refresh.running && s.lastAttempt && s.lastAttempt.outcome !== 'running';
});

test('UTC deadline calculation handles pre-deadline, post-deadline and manual successes', () => {
  const settings = validateSettings({ dailyRefresh: true, dailyUtcHour: 3 });
  assert.equal(nextDailyRun({ nowMs: NOW, lastSuccessAt: null, settings }), NOW);
  assert.equal(nextDailyRun({ nowMs: NOW, lastSuccessAt: new Date(NOW).toISOString(), settings }), Date.parse('2030-04-06T03:00:00Z'));
  const early = Date.parse('2030-04-05T02:00:00Z');
  assert.equal(nextDailyRun({ nowMs: early, lastSuccessAt: new Date(early).toISOString(), settings }), Date.parse('2030-04-05T03:00:00Z'));
  assert.equal(nextDailyRun({ nowMs: NOW, settings: validateSettings({ dailyRefresh: false }) }), null);
});
test('daily refresh is opt-in and starts only after startScheduler', async t => {
  const { service, clock, api } = await setup(t);
  assert.deepEqual(clock.pending(), []); assert.equal(api.calls.length, 0);
  await service.configure({ dailyRefresh: false }); await service.startScheduler();
  assert.deepEqual(clock.pending(), []); clock.advance(DAY); assert.equal(api.calls.length, 0);
});
test('startup catch-up runs once; the next refresh is the next UTC deadline', async t => {
  const { service, clock, api } = await setup(t);
  await service.startScheduler(); assert.deepEqual(clock.pending(), [NOW]);
  clock.advance(0); await settled(service); assert.equal(api.calls.length, 1);
  const next = Date.parse('2030-04-06T03:00:00Z'); assert.deepEqual(clock.pending(), [next]);
  clock.advance(next - clock.now() - 1); assert.equal(api.calls.length, 1);
  clock.advance(1); await settled(service); assert.equal(api.calls.length, 2);
});
test('manual success satisfies the elapsed daily deadline without an extra catch-up run', async t => {
  const { service, clock, api } = await setup(t); await service.refresh();
  await service.startScheduler(); clock.advance(0); assert.equal(api.calls.length, 1);
  assert.deepEqual(clock.pending(), [Date.parse('2030-04-06T03:00:00Z')]);
});
test('failure uses exponential backoff, not a tight retry loop, and success resets it', async t => {
  let attempts = 0;
  const good = mockApi(basic());
  const fetchImpl = (...args) => ++attempts <= 2 ? Promise.resolve(jsonResponse({}, 503)) : good(...args);
  const { service, clock } = await setup(t, { fetchImpl });
  await service.startScheduler(); clock.advance(0); await settled(service);
  assert.equal(attempts, 1); assert.deepEqual(clock.pending(), [NOW + 1_000]);
  clock.advance(999); assert.equal(attempts, 1); clock.advance(1); await settled(service);
  assert.equal(attempts, 2); assert.equal((await service.status()).scheduler.failureCount, 2);
  assert.deepEqual(clock.pending(), [NOW + 3_000]);
  clock.advance(2_000); await settled(service); assert.equal(attempts, 3);
  assert.equal((await service.status()).scheduler.failureCount, 0);
});
test('Retry-After can postpone the scheduler beyond its ordinary exponential backoff', async t => {
  const { service, clock } = await setup(t, { fetchImpl: async () => jsonResponse({}, 429, { 'retry-after': '600' }) });
  await service.startScheduler(); clock.advance(0); await settled(service);
  assert.deepEqual(clock.pending(), [NOW + 600_000]);
});
test('cancellation applies a persisted cooldown instead of immediately restarting the same daily run', async t => {
  let attempts = 0;
  const { service, clock } = await setup(t, { fetchImpl: () => { attempts++; return new Promise(() => {}); } });
  await service.startScheduler(); clock.advance(0); await eventually(() => attempts === 1);
  service.cancel(); await settled(service);
  assert.deepEqual(clock.pending(), [NOW + 2_000]); assert.equal((await service.status()).scheduler.failureCount, 0);
  clock.advance(1_999); assert.equal(attempts, 1);
});
test('restart preserves failed-run backoff and does not immediately retry', async t => {
  const { service, clock, root } = await setup(t, { fetchImpl: async () => jsonResponse({}, 503) });
  await service.refresh(); await service.close(); clock.advance(500);
  const api = mockApi(basic());
  const second = new MarketService({ root, fetchImpl: api, now: clock.now, timers: clock.timers });
  await second.ready; await second.startScheduler(); assert.deepEqual(clock.pending(), [NOW + 1_000]);
  clock.advance(499); assert.equal(api.calls.length, 0); clock.advance(1); await settled(second);
  assert.equal(api.calls.length, 1); await second.close();
});
test('several missed days coalesce to one startup catch-up, not a backlog of daily scans', async t => {
  const { service, clock, root } = await setup(t); await service.refresh(); await service.close();
  clock.advance(4 * DAY);
  const api = mockApi([]); const second = new MarketService({ root, fetchImpl: api, now: clock.now, timers: clock.timers });
  await second.ready; await second.startScheduler(); clock.advance(0); await settled(second);
  assert.equal(api.calls.length, 1); assert.equal(clock.pending().length, 1); assert.ok(clock.pending()[0] > clock.now()); await second.close();
});
test('enabling/disabling persisted preference arms or clears a running scheduler', async t => {
  const { service, clock } = await setup(t); await service.configure({ dailyRefresh: false }); await service.startScheduler();
  assert.equal(clock.pending().length, 0); await service.configure({ dailyRefresh: true }); assert.equal(clock.pending().length, 1);
  await service.configure({ dailyRefresh: false }); assert.equal(clock.pending().length, 0);
});
test('manual refresh can explicitly bypass failure backoff without duplicating a running job', async t => {
  let attempts = 0;
  const { service } = await setup(t, { fetchImpl: async () => { attempts++; return jsonResponse({}, 503); } });
  await service.refresh(); await service.refresh(); assert.equal(attempts, 2);
});
test('closing the service removes daily timers', async t => {
  const { service, clock } = await setup(t); await service.startScheduler(); assert.equal(clock.pending().length, 1);
  await service.close(); assert.equal(clock.pending().length, 0);
});
