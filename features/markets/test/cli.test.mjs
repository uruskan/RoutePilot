import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runCLI } from '../cli/markets.mjs';
import { MarketService } from '../server/markets.mjs';
import { NOW, basic, FAST, mockApi, eventually } from './fixtures/synthetic.mjs';
async function setup(t, { seed = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'routepilot-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (seed) { const service = new MarketService({ root, now: () => NOW, fetchImpl: mockApi(basic()) });
    await service.ready; await service.configure(FAST); await service.refresh(); await service.close(); }
  return root;
}
async function run(root, args, options = {}) {
  let output = '', error = '';
  const code = await runCLI([...args, '--root', root], { now: () => NOW,
    fetchImpl: () => { throw new Error('unexpected networking'); },
    stdout: { write: value => { output += value; } }, stderr: { write: value => { error += value; } }, ...options });
  return { code, output, error };
}

test('real CLI entry point executes --help under Node without Electron', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['cli/markets.mjs', '--help'], { cwd: new URL('..', import.meta.url) });
  assert.match(stdout, /RoutePilot market scanner/); assert.match(stdout, /refresh/);
});
test('CLI refresh uses mocked networking and writes a reusable standalone report', async t => {
  const root = await setup(t, { seed: false }); const api = mockApi(basic());
  const result = await run(root, ['refresh', '--quiet', '--patch', JSON.stringify(FAST), '--cargo', '10', '--credits', '1000', '--reserve', '100'], { fetchImpl: api });
  assert.equal(result.code, 0, result.error); assert.equal(JSON.parse(result.output).outcome, 'succeeded'); assert.equal(api.calls.length, 1);
  const report = await run(root, ['results']); assert.equal(JSON.parse(report.output).rows[0].affordableCargoPerTrip, 9);
});
test('CLI read-only results can use explicit coordinates but never guesses a missing location', async t => {
  const root = await setup(t);
  const missing = await run(root, ['results', '--sort', 'closestSeller']); assert.equal(missing.code, 1); assert.match(missing.error, /LOCATION_UNAVAILABLE/);
  const known = await run(root, ['results', '--sort', 'closestSeller', '--system', 'Test', '--position=10,0,0']);
  assert.equal(known.code, 0, known.error); assert.equal(JSON.parse(known.output).rows[0].playerToSellerLy, 0);
});
test('CLI export writes CSV to the specified path and does not fetch', async t => {
  const root = await setup(t); const file = join(root, 'exports with spaces', 'trades.csv');
  const result = await run(root, ['export', '--output', file]); assert.equal(result.code, 0, result.error);
  const csv = await readFile(file, 'utf8'); assert.ok(csv.startsWith('\uFEFF')); assert.match(csv, /Conditional lot profit/);
});
test('CLI rejects malformed coordinates and unknown options instead of coercing them', async t => {
  const root = await setup(t);
  for (const args of [['results', '--position=,0,0'], ['results', '--unknown=1'], ['results', '--max-from-me', ''], ['settings', '--sort', 'margin']]) {
    assert.equal((await run(root, args)).code, 1);
  }
});
test('CLI invalid settings patch leaves the previous settings unchanged', async t => {
  const root = await setup(t); const before = await readFile(join(root, 'state.json'), 'utf8');
  const result = await run(root, ['settings', '--patch', '{"cargoCapacity":-1}']); assert.equal(result.code, 1);
  assert.equal(await readFile(join(root, 'state.json'), 'utf8'), before);
});
test('CLI watch will not silently enable daily refresh', async t => {
  const root = await setup(t); const result = await run(root, ['watch']); assert.equal(result.code, 1); assert.match(result.error, /disabled/);
});
test('CLI watch starts daily catch-up and exits cleanly on cancellation', async t => {
  const root = await setup(t, { seed: false }), controller = new AbortController(), api = mockApi(basic());
  const pending = run(root, ['watch', '--daily', 'true', '--patch', JSON.stringify(FAST)], { fetchImpl: api, signal: controller.signal });
  await eventually(() => api.calls.length > 0); controller.abort();
  const result = await pending; assert.equal(result.code, 0, result.error);
});
test('CLI refresh has a nonzero exit status on network failure', async t => {
  const root = await setup(t); const result = await run(root, ['refresh', '--quiet']);
  assert.equal(result.code, 1); assert.equal(JSON.parse(result.output).outcome, 'failed');
});
