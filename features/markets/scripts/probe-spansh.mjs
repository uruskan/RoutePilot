#!/usr/bin/env node
/** Explicit live contract probe, not part of npm test. Does not write scanner state.
 * One bounded POST and, only with --detail, one GET for an actual returned ID.
 */
import { SEARCH_URL, DETAIL_URL, timestampMs, normalizeStation } from '../server/markets.mjs';
const args = process.argv.slice(2);
if (args.some(arg => !['--detail', '--help'].includes(arg))) {
  console.error('Usage: node scripts/probe-spansh.mjs [--detail]'); process.exitCode = 1;
} else if (args.includes('--help')) {
  console.log('POST one page of the last 24 hours to Spansh. --detail also GETs one returned station. No files or game state are changed.');
} else {
  const end = new Date(Math.floor(Date.now() / 1000) * 1000), start = new Date(end.getTime() - 24 * 3_600_000);
  const body = { size: 25, page: 0, filters: { market_updated_at: { comparison: '<=>', value: [start.toISOString(), end.toISOString()] } },
    sort: [{ market_updated_at: { direction: 'desc' } }] };
  const report = { purpose: 'Explicit live Spansh contract probe; NOT a complete scan',
    attemptedAt: new Date().toISOString(), node: process.version, endpoint: SEARCH_URL, method: 'POST', request: body,
    success: false };
  async function json(url, options = {}) {
    const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}) } });
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
    const reader = response.body?.getReader(); if (!reader) throw new Error('No response body.');
    const chunks = []; let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 8 * 1024 * 1024) { await reader.cancel(); throw new Error('Probe response exceeded 8 MiB limit.'); }
        chunks.push(Buffer.from(part.value));
      }
    } finally { reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  function shape(record) {
    const normalized = normalizeStation(record);
    return {
      market_id: record.market_id, type: record.type ?? null, carrier_docking_access: record.carrier_docking_access ?? null,
      market_updated_at: record.market_updated_at ?? null, timestampAccepted: timestampMs(record.market_updated_at) !== null,
      normalized: normalized ? { isCarrier: normalized.isCarrier, publicDocking: normalized.publicDocking } : null,
      hasMarketArray: Array.isArray(record.market), marketEntries: Array.isArray(record.market) ? record.market.length : null,
      firstQuoteKeys: Array.isArray(record.market) && record.market[0] ? Object.keys(record.market[0]) : [],
    };
  }
  try {
    const payload = await json(SEARCH_URL, { method: 'POST', body: JSON.stringify(body) });
    const count = payload?.count;
    if (!Array.isArray(payload?.results) || !['number', 'string'].includes(typeof count) ||
      (typeof count === 'string' && !/^\d+$/.test(count)) ||
      !Number.isSafeInteger(Number(count)) || Number(count) < 0) throw new Error('Search response does not match {count, results}.');
    report.count = payload.count; report.returned = payload.results.length;
    report.samples = payload.results.slice(0, 5).map(shape);
    report.carrierDockingValuesObserved = [...new Set(payload.results.filter(r => /carrier/i.test(String(r.type))).map(r => r.carrier_docking_access))];
    if (args.includes('--detail') && payload.results.length) {
      const id = String(payload.results[0].market_id);
      if (!/^[1-9]\d{0,31}$/.test(id)) throw new Error('Actual returned station ID is not safe to use in a detail URL.');
      const detail = await json(`${DETAIL_URL}${id}`);
      if (!detail?.record || String(detail.record.market_id) !== id) throw new Error('Detail response record or ID mismatch.');
      report.detail = shape(detail.record);
    }
    report.success = true;
    report.note = 'This verifies only the observed page response. It does not prove cap size, completeness, live game prices, all docking enums, or all timestamp formats.';
  } catch (error) {
    report.error = { name: error.name, message: error.message, ...(error.status ? { httpStatus: error.status } : {}),
      ...(error.cause ? { cause: { code: error.cause.code, message: error.cause.message, hostname: error.cause.hostname } } : {}) };
    report.note = 'No successful live verification is claimed. Synthetic and mocked-network tests are separate.';
    process.exitCode = 1;
  }
  console.log(JSON.stringify(report, null, 2));
}
