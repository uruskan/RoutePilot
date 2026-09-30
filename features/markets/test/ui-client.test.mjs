import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarketClient, draftToPatch, settingsToDraft, formatNumber, formatAge } from '../ui/market-client.mjs';
import { DEFAULT_SETTINGS } from '../server/markets.mjs';
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('UI client encodes filters explicitly, including null, zero and false', async () => {
  let call;
  const client = createMarketClient({ getToken: async () => 'test-token', fetchImpl: async (...args) => { call = args; return response({ rows: [] }); } });
  await client.results({ maxMarketAgeHours: null, maxRouteDistanceLy: 0, allowPlanetary: false });
  const url = new URL(call[0]); assert.equal(url.searchParams.get('maxMarketAgeHours'), 'null');
  assert.equal(url.searchParams.get('maxRouteDistanceLy'), '0'); assert.equal(url.searchParams.get('allowPlanetary'), 'false');
  assert.equal(call[1].headers.authorization, 'Bearer test-token'); assert.equal(call[1].credentials, 'omit');
});
test('UI mutations only use the isolated market namespace and explicit JSON POSTs', async () => {
  const calls = []; const client = createMarketClient({ fetchImpl: async (...args) => { calls.push(args); return response({}); } });
  await client.refresh(); await client.cancel(); await client.configure({ credits: 100 });
  assert.deepEqual(calls.map(([url]) => new URL(url).pathname), ['/api/markets/refresh', '/api/markets/cancel', '/api/markets/settings']);
  for (const [, init] of calls) { assert.equal(init.method, 'POST'); assert.equal(init.headers['content-type'], 'application/json'); }
  assert.equal(calls[0][1].body, '{}');
});
test('UI client surfaces typed server errors and does not hide authentication failures', async () => {
  const client = createMarketClient({ fetchImpl: async () => response({ error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } }, 401) });
  await assert.rejects(client.status(), { code: 'UNAUTHORIZED', status: 401 });
});
test('UI client returns a Blob for CSV without stripping the UTF-8 BOM', async () => {
  const client = createMarketClient({ fetchImpl: async () => new Response('\uFEFF"Commodity"\r\n"Gold"\r\n', { headers: { 'content-type': 'text/csv' } }) });
  const blob = await client.csv(); assert.ok(blob instanceof Blob);
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer()).subarray(0, 3)], [239, 187, 191]);
});
test('UI timeout works even with a hung token provider or signal-ignoring fetch', async () => {
  for (const config of [{ getToken: () => new Promise(() => {}) }, { fetchImpl: () => new Promise(() => {}) }]) {
    const client = createMarketClient({ timeoutMs: 15, ...config }); await assert.rejects(client.status(), { code: 'TIMEOUT' });
  }
});
test('UI caller cancellation aborts request lifetime', async () => {
  const controller = new AbortController();
  const client = createMarketClient({ fetchImpl: () => new Promise(() => {}) });
  const pending = client.status(controller.signal); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});
test('UI client refuses to send a local bearer token to a non-loopback or credential-bearing URL', () => {
  for (const baseUrl of ['https://attacker.example/api/markets', 'http://u:p@127.0.0.1/api/markets', 'file:///api/markets']) {
    assert.throws(() => createMarketClient({ baseUrl }), { code: 'CONFIG' });
  }
});
test('UI draft conversion preserves blank unknown values, actual zero and booleans', () => {
  const draft = settingsToDraft(DEFAULT_SETTINGS); assert.equal(draft.credits, ''); assert.equal(draft.creditReserve, 0);
  const patch = draftToPatch({ ...draft, cargoCapacity: '0', credits: '100', maxMarketAgeHours: '', allowPlanetary: false });
  assert.equal(patch.cargoCapacity, 0); assert.equal(patch.credits, 100); assert.equal(patch.maxMarketAgeHours, null); assert.equal(patch.allowPlanetary, false);
  assert.throws(() => draftToPatch({ ...draft, minStock: '' }));
  assert.throws(() => draftToPatch({ ...draft, credits: ' ' }));
});
test('UI formatting distinguishes unknown, zero and future market times', () => {
  assert.equal(formatNumber(null), 'Unknown'); assert.equal(formatNumber(0), '0'); assert.equal(formatNumber(false), 'Unknown');
  assert.equal(formatAge(null), 'Age unknown'); assert.equal(formatAge(-1), 'Future timestamp'); assert.equal(formatAge(0), '<1 min old');
  assert.equal(formatAge(0.5), '30 min old');
});

test('UI editing round-trips access, market types and demand coverage without converting enums to numbers', () => {
  const draft = settingsToDraft({ ...DEFAULT_SETTINGS, sellerType: 'all', buyerType: 'stations', excludeCarrierAccess: true, requireFullStockDemand: false });
  const patch = draftToPatch(draft);
  assert.equal(patch.sellerType, 'all'); assert.equal(patch.buyerType, 'stations');
  assert.equal(patch.excludeCarrierAccess, true); assert.equal(patch.requireFullStockDemand, false);
});
test('UI malformed JSON errors are explicit', async () => {
  const client = createMarketClient({ fetchImpl: async () => new Response('not json') });
  await assert.rejects(client.status(), { code: 'SCHEMA' });
});

test('an already-aborted UI request does not fetch or leak a late token rejection', async () => {
  const controller = new AbortController(); controller.abort(); let fetches = 0;
  const client = createMarketClient({ getToken: async () => { throw new Error('late token failure'); },
    fetchImpl: async () => { fetches++; return response({}); } });
  await assert.rejects(client.status(controller.signal), { name: 'AbortError' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetches, 0);
});
