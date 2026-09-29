import test from 'node:test';
import assert from 'node:assert/strict';
import { collectMarkets } from '../server/markets.mjs';
import { NOW, HOUR, at, station, basic, FAST, mockApi, jsonResponse, eventually } from './fixtures/synthetic.mjs';
const collect = (fetchImpl, settings = {}, extra = {}) => collectMarkets({ fetchImpl, settings: { ...FAST, ...settings }, now: () => NOW, ...extra });

test('paginates to count, sends the observed request shape and bounds concurrency', async () => {
  const api = mockApi(Array.from({ length: 9 }, (_, i) => station(i + 1)), { latencyMs: 10 });
  const result = await collect(api, { pageSize: 2, concurrency: 2 });
  assert.equal(result.stations.length, 9); assert.equal(result.coverage.pages, 5);
  assert.equal(api.peak(), 2); assert.equal(result.coverage.complete, true);
  assert.deepEqual(api.calls[0].body.filters.market_updated_at.value, [at(-24), at(0)]);
  assert.deepEqual(api.calls[0].body.sort, [{ market_updated_at: { direction: 'desc' } }]);
  assert.equal(api.calls[0].options.redirect, 'error');
});
test('adapts when the server clamps the requested page size', async () => {
  const api = mockApi(Array.from({ length: 7 }, (_, i) => station(i + 1)), { actualPageSize: 2 });
  const result = await collect(api, { pageSize: 500 });
  assert.equal(result.stations.length, 7); assert.equal(result.coverage.pages, 4);
});
test('cap guard bisects the time window and deduplicates overlapping boundaries', async () => {
  const records = [-3.5, -2.5, -2, -1.5, -0.5].map((time, i) => station(i + 1, { market_updated_at: at(time) }));
  const result = await collect(mockApi(records), { windowHours: 4, queryResultCap: 4 });
  assert.equal(result.stations.length, 5); assert.equal(result.coverage.splits, 1); assert.equal(result.coverage.boundaryDuplicates, 1);
});
test('an exactly capped count is subdivided, recovering records hidden behind a reported cap', async () => {
  const records = Array.from({ length: 8 }, (_, i) => station(i + 1, { market_updated_at: at(-0.5 - i) }));
  const result = await collect(mockApi(records, { cap: 3, countCap: 3 }), { windowHours: 8, queryResultCap: 3 });
  assert.equal(result.stations.length, 8); assert.ok(result.coverage.splits > 1);
});
test('pagination shortfalls are subdivided even when actual cap differs from the configured guard', async () => {
  const records = Array.from({ length: 8 }, (_, i) => station(i + 1, { market_updated_at: at(-0.5 - i) }));
  const result = await collect(mockApi(records, { cap: 2 }), { pageSize: 2, windowHours: 8, queryResultCap: 100 });
  assert.equal(result.stations.length, 8); assert.ok(result.coverage.splits > 0);
});
test('unpartitionable same-timestamp cap reports incomplete coverage rather than claiming success', async () => {
  const records = Array.from({ length: 5 }, (_, i) => station(i + 1, { market_updated_at: new Date(NOW - 30_000).toISOString() }));
  await assert.rejects(collect(mockApi(records), { windowHours: 1 / 60, queryResultCap: 3 }), error => {
    assert.equal(error.code, 'INCOMPLETE_COVERAGE'); assert.equal(error.details.complete, false);
    assert.ok(error.details.reasons[0].reasons.includes('count-at-or-above-cap-guard')); return true;
  });
});
test('deep-page rejection leads to smaller slices, not a silently truncated report', async () => {
  const records = Array.from({ length: 5 }, (_, i) => station(i + 1, { market_updated_at: at(-0.5 - i) }));
  const api = mockApi(records, { onRequest: ({ body }) => body.page > 0 ? jsonResponse({ error: 'result window exceeded' }, 400) : undefined });
  const result = await collect(api, { pageSize: 2, windowHours: 6 });
  assert.equal(result.stations.length, 5); assert.ok(result.coverage.splits > 0);
});
test('changing counts during pagination are detected and retried through subdivision', async () => {
  const records = Array.from({ length: 4 }, (_, i) => station(i + 1, { market_updated_at: at(-0.5 - i) }));
  let changed = false;
  const api = mockApi(records, { onRequest: ({ body }) => {
    if (body.page === 1 && !changed) { changed = true; return jsonResponse({ count: 5, results: records.slice(2) }); }
  } });
  const result = await collect(api, { pageSize: 2, windowHours: 4 });
  assert.equal(result.stations.length, 4); assert.ok(result.coverage.splits > 0);
});
test('duplicate page contents cannot masquerade as complete coverage', async () => {
  const same = station(1);
  const api = mockApi([], { onRequest: () => jsonResponse({ count: 2, results: [same, same] }) });
  await assert.rejects(collect(api, { maxSplitDepth: 0 }), error => error.code === 'INCOMPLETE_COVERAGE' && error.details.reasons[0].reasons.includes('duplicate-id-within-page-sequence'));
});
test('out-of-window records reveal an ignored or inconsistent API filter', async () => {
  const api = mockApi([], { onRequest: () => jsonResponse({ count: 1, results: [station(1, { market_updated_at: at(1) })] }) });
  await assert.rejects(collect(api, { maxSplitDepth: 0 }), error => error.code === 'INCOMPLETE_COVERAGE' && error.details.reasons[0].reasons.includes('timestamp-outside-query-window'));
});
test('missing market arrays are hydrated via GET /api/station/id record wrapper', async () => {
  const api = mockApi(basic(), { omitMarkets: true, latencyMs: 5 });
  const result = await collect(api);
  assert.equal(result.stations.length, 2); assert.equal(api.calls.filter(call => call.options.method === 'GET').length, 2);
  assert.ok(result.stations.every(row => Array.isArray(row.market))); assert.ok(api.peak() <= 2);
});
test('detail hydration never borrows a search timestamp for a detail quote without one', async () => {
  const api = mockApi(basic(), { omitMarkets: true, onRequest: call => {
    if (call.options.method === 'GET') {
      const row = basic().find(row => String(row.market_id) === call.url.split('/').pop());
      delete row.market_updated_at; return jsonResponse({ record: row });
    }
  } });
  const result = await collect(api);
  assert.ok(result.stations.every(row => row.market_updated_at === undefined));
});
test('malformed detail wrappers or wrong IDs fail instead of attaching another station quote', async () => {
  const api = mockApi(basic(), { omitMarkets: true, onRequest: call => call.options.method === 'GET' ? jsonResponse({ record: station(999) }) : undefined });
  await assert.rejects(collect(api), { code: 'SCHEMA' });
});
test('missing markets are explicitly incomplete if hydration is disabled or exceeds its budget', async () => {
  await assert.rejects(collect(mockApi(basic(), { omitMarkets: true }), { hydrateMissingMarkets: false }), { code: 'INCOMPLETE_COVERAGE' });
  await assert.rejects(collect(mockApi(basic(), { omitMarkets: true }), { maxDetailRequests: 1 }), { code: 'INCOMPLETE_COVERAGE' });
});
test('transient 503 is retried but 400 is not', async () => {
  const api = mockApi(basic(), { onRequest: (_, index) => index === 1 ? jsonResponse({ error: 'retry' }, 503) : undefined });
  const result = await collect(api, { maxRetries: 1 });
  assert.equal(api.calls.length, 2); assert.equal(result.progress.retries, 1);
  const bad = mockApi([], { onRequest: () => jsonResponse({ error: 'bad request' }, 400) });
  await assert.rejects(collect(bad, { maxRetries: 3 }), { code: 'HTTP' }); assert.equal(bad.calls.length, 1);
});
test('429 Retry-After is respected', async () => {
  const api = mockApi(basic(), { onRequest: (_, index) => index === 1 ? jsonResponse({}, 429, { 'retry-after': '0.025' }) : undefined });
  await collect(api, { maxRetries: 1 });
  assert.ok(api.calls[1].started - api.calls[0].started >= 20);
});
test('long Retry-After fails promptly and exposes retry delay instead of retrying too soon', async () => {
  const api = mockApi([], { onRequest: () => jsonResponse({}, 429, { 'retry-after': '600' }) });
  await assert.rejects(collect(api, { maxRetries: 3 }), error => error.code === 'HTTP' && error.details.retryAfterMs === 600_000);
  assert.equal(api.calls.length, 1);
});
test('connection failures have a bounded retry count', async () => {
  let requests = 0;
  await assert.rejects(collect(async () => { requests++; throw new TypeError('synthetic network failure'); }, { maxRetries: 2 }), { code: 'NETWORK' });
  assert.equal(requests, 3);
});
test('timeout also works with a fetch implementation that ignores AbortSignal', async () => {
  const start = performance.now();
  await assert.rejects(collect(() => new Promise(() => {}), { timeoutMs: 20 }), { code: 'TIMEOUT' });
  assert.ok(performance.now() - start < 1_000);
});
test('timeout covers response body reads, not only receipt of response headers', async () => {
  const fetchImpl = async () => new Response(new ReadableStream({ start() {} }), { status: 200 });
  await assert.rejects(collect(fetchImpl, { timeoutMs: 20 }), { code: 'TIMEOUT' });
});
test('request starts obey global pacing even with parallel workers', async () => {
  const api = mockApi(Array.from({ length: 5 }, (_, i) => station(i + 1)), { latencyMs: 5 });
  await collect(api, { pageSize: 1, concurrency: 3, minRequestIntervalMs: 15 });
  for (let i = 1; i < api.calls.length; i++) assert.ok(api.calls[i].started - api.calls[i - 1].started >= 12);
});
test('cancellation before collection performs no request', async () => {
  const controller = new AbortController(); controller.abort(); const api = mockApi(basic());
  await assert.rejects(collect(api, {}, { signal: controller.signal }), { code: 'CANCELLED' }); assert.equal(api.calls.length, 0);
});
test('cancellation interrupts active networking even when fetch ignores the signal', async () => {
  const controller = new AbortController(); let entered = false;
  const pending = collect(() => { entered = true; return new Promise(() => {}); }, {}, { signal: controller.signal });
  await eventually(() => entered); controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' });
});
test('cancellation interrupts exponential retry sleep', async () => {
  const controller = new AbortController(); let retrying = false;
  const api = mockApi([], { onRequest: () => jsonResponse({}, 503) });
  const pending = collect(api, { maxRetries: 2, retryBaseMs: 10_000, retryMaxMs: 10_000 }, {
    signal: controller.signal, onProgress: state => { if (state.retries) retrying = true; },
  });
  await eventually(() => retrying); controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' }); assert.equal(api.calls.length, 1);
});
test('request and station safety budgets return explicit incomplete coverage', async () => {
  await assert.rejects(collect(mockApi(basic()), { pageSize: 1, maxRequests: 1 }), { code: 'INCOMPLETE_COVERAGE' });
  await assert.rejects(collect(mockApi(basic()), { maxStations: 1 }), { code: 'INCOMPLETE_COVERAGE' });
});
test('malformed successful responses are schema errors', async () => {
  for (const response of [() => new Response('not json'), () => jsonResponse({ results: [] }),
    () => jsonResponse({ count: 1, results: [{ name: 'missing ID' }] })]) {
    await assert.rejects(collect(async () => response()), { code: 'SCHEMA' });
  }
});
test('oversized responses are rejected using both declared and streamed size', async () => {
  await assert.rejects(collect(async () => new Response('x', { headers: { 'content-length': '10000' } }), { maxResponseBytes: 1024 }), { code: 'RESPONSE_TOO_LARGE' });
  await assert.rejects(collect(async () => new Response('x'.repeat(2_000)), { maxResponseBytes: 1024 }), { code: 'RESPONSE_TOO_LARGE' });
});
test('a valid empty source produces an empty, reconciled snapshot', async () => {
  const result = await collect(mockApi([])); assert.deepEqual(result.stations, []); assert.equal(result.coverage.complete, true);
});

test('cancellation from a progress callback cannot miss the request abort listener', async () => {
  const controller = new AbortController(); let fetches = 0;
  await assert.rejects(collect(async () => { fetches++; return jsonResponse({ count: 0, results: [] }); }, {}, {
    signal: controller.signal,
    onProgress: value => { if (value.requests === 1) controller.abort(); },
  }), { code: 'CANCELLED' });
  assert.equal(fetches, 0);
});
