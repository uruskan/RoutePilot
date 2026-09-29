// Entirely synthetic test data. These are not live trades or real stations.
export const NOW = Date.parse('2030-04-05T12:00:00Z');
export const HOUR = 3_600_000;
export const at = (offsetHours = -1) => new Date(NOW + offsetHours * HOUR).toISOString();
export function quote(overrides = {}) {
  return { commodity: 'Gold', category: 'Metals', buy_price: 100, sell_price: 0, supply: 20, demand: 0, ...overrides };
}
export function station(id = 1, overrides = {}) {
  return { market_id: id, name: `Synthetic ${id}`, carrier_name: null, real_name: null,
    type: 'Fleet Carrier', system_name: `Test system ${id}`, system_x: id * 10, system_y: 0, system_z: 0,
    distance_to_arrival: 125, has_large_pad: true, medium_pads: 2, small_pads: 4,
    is_planetary: false, carrier_docking_access: 'All', system_needs_permit: false,
    market_updated_at: at(), updated_at: at(), government: 'Synthetic', market: [quote()], ...overrides };
}
export function buyer(id = 100, overrides = {}) {
  return station(id, { type: 'Coriolis Starport', market: [quote({ buy_price: 0, sell_price: 180, supply: 0, demand: 200 })], ...overrides });
}
export const basic = () => [station(1), buyer(2)];
export const FAST = { minRequestIntervalMs: 0, maxRetries: 0, timeoutMs: 500,
  retryBaseMs: 0, retryMaxMs: 0, pageSize: 500, schedulerRetryBaseMs: 1_000, schedulerRetryMaxMs: 8_000,
  cancellationBackoffMs: 2_000 };
export const context = { systemName: 'Synthetic origin', StarPos: [0, 0, 0] };
export const jsonResponse = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json', ...headers },
});
export function mockApi(initialRecords, { cap = Infinity, countCap = Infinity, actualPageSize = Infinity,
  latencyMs = 0, omitMarkets = false, onRequest } = {}) {
  let records = initialRecords;
  let active = 0, peak = 0;
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    const call = { url, body, options, started: performance.now() };
    calls.push(call); active++; peak = Math.max(peak, active);
    try {
      if (options.signal?.aborted) throw options.signal.reason;
      if (latencyMs) await new Promise((resolve, reject) => {
        const done = () => { cleanup(); resolve(); };
        const abort = () => { clearTimeout(timer); cleanup(); reject(options.signal.reason); };
        const cleanup = () => options.signal?.removeEventListener('abort', abort);
        const timer = setTimeout(done, latencyMs);
        options.signal?.addEventListener('abort', abort, { once: true });
      });
      if (onRequest) { const override = await onRequest(call, calls.length); if (override !== undefined) return override; }
      const current = typeof records === 'function' ? records() : records;
      if (options.method === 'GET') {
        const id = String(url).split('/').pop();
        return jsonResponse({ record: current.find(row => String(row.market_id) === id) });
      }
      if (!body || options.method !== 'POST' || body.filters?.market_updated_at?.comparison !== '<=>') throw new Error('Unexpected request contract');
      const [lo, hi] = body.filters.market_updated_at.value.map(Date.parse);
      const selected = current.filter(row => Date.parse(row.market_updated_at) >= lo && Date.parse(row.market_updated_at) <= hi)
        .sort((a, b) => Date.parse(b.market_updated_at) - Date.parse(a.market_updated_at) || String(a.market_id).localeCompare(String(b.market_id)));
      const size = Math.min(body.size, actualPageSize);
      const accessible = selected.slice(0, cap);
      const results = accessible.slice(body.page * size, (body.page + 1) * size).map(row => {
        const copy = structuredClone(row); if (omitMarkets) delete copy.market; return copy;
      });
      return jsonResponse({ count: Math.min(selected.length, countCap), results });
    } finally { active--; }
  };
  fetchImpl.calls = calls;
  fetchImpl.setRecords = value => { records = value; };
  fetchImpl.peak = () => peak;
  return fetchImpl;
}
export async function eventually(predicate, { timeout = 2_000, interval = 2 } = {}) {
  const end = performance.now() + timeout;
  for (;;) {
    if (await predicate()) return;
    if (performance.now() >= end) throw new Error('Condition did not become true in time');
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}
export function fakeScheduler(start = NOW) {
  let time = start, sequence = 0;
  const tasks = new Map();
  return {
    now: () => time,
    timers: {
      setTimeout(fn, delay) { const id = ++sequence; tasks.set(id, { at: time + delay, fn }); return id; },
      clearTimeout(id) { tasks.delete(id); },
    },
    advance(ms) {
      time += ms;
      const ready = [...tasks.entries()].filter(([, task]) => task.at <= time).sort((a, b) => a[1].at - b[1].at);
      for (const [id, task] of ready) if (tasks.delete(id)) task.fn();
    },
    pending: () => [...tasks.values()].map(task => task.at),
  };
}
