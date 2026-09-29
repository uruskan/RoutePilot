import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteReport, readMarketReport, MarketService, SCHEMA_VERSION } from '../server/markets.mjs';
import { NOW, station, buyer, quote } from './fixtures/synthetic.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'routepilot-report-storage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, file: join(root, 'report.json') };
}
const report = () => ({ schemaVersion: SCHEMA_VERSION, id: randomUUID(),
  collectedAt: new Date(NOW).toISOString(), coverage: { complete: true }, referenceOpportunityCount: 1 });

test('many station records round-trip through bounded NDJSON and a small manifest, including read-only service restart', async t => {
  const { root, file } = await setup(t);
  const records = [...Array.from({ length: 1_200 }, (_, i) => station(i + 1, {
    unneededRawPayload: 'Do not persist this',
    market: Array.from({ length: 20 }, (_, j) => quote({ commodity: `Synthetic commodity ${j}` })),
  })), buyer(5_000, { market: [quote({ commodity: 'Synthetic commodity 0', supply: 0, sell_price: 200, demand: 200 })] })];
  const saved = await atomicWriteReport(file, report(), records);
  assert.ok((await stat(file)).size < 2_000);
  assert.ok((await stat(join(root, saved.stationSnapshot.file))).size > 1_000_000);
  const loaded = await readMarketReport(file);
  assert.equal(loaded.stations.length, 1_201);
  assert.equal(loaded.stations[0].market.length, 20);
  assert.equal(loaded.stations[0].unneededRawPayload, undefined);
  assert.equal(loaded.opportunities, undefined);
  const reader = new MarketService({ root, readOnly: true, now: () => NOW });
  t.after(() => reader.close());
  await reader.ready;
  assert.equal((await reader.results()).total, 1_200);
  assert.equal((await reader.status()).hasReport, true);
  assert.deepEqual((await readdir(root)).sort(), ['report.json', saved.stationSnapshot.file].sort());
});

test('manifest failure preserves previous snapshot and removes only the failed owned candidate', async t => {
  const { root, file } = await setup(t);
  const previous = await atomicWriteReport(file, report(), [station(1), buyer(2)]);
  const before = await readFile(file, 'utf8');
  await assert.rejects(atomicWriteReport(file, previous, [station(3)]), /already exists/);
  await writeFile(join(root, 'unrelated.ndjson'), 'keep');
  await assert.rejects(atomicWriteReport(file, report(), [station(3), buyer(4)], {
    previousReport: previous, writeManifest: async () => { throw new Error('Injected manifest disk failure'); },
  }), /Injected manifest disk failure/);
  assert.equal(await readFile(file, 'utf8'), before);
  assert.equal((await readMarketReport(file)).stations[0].market_id, 1);
  assert.deepEqual((await readdir(root)).sort(), ['report.json', previous.stationSnapshot.file, 'unrelated.ndjson'].sort());
});

test('cancellation during station streaming retains the old manifest and cleans the temporary file', async t => {
  const { root, file } = await setup(t);
  const previous = await atomicWriteReport(file, report(), [station(1), buyer(2)]);
  const controller = new AbortController();
  const trigger = station(3);
  Object.defineProperty(trigger, 'name', { enumerable: true, get() { controller.abort(); return 'Cancel during save'; } });
  await assert.rejects(atomicWriteReport(file, report(), [trigger, buyer(4)], {
    signal: controller.signal, previousReport: previous,
  }));
  assert.equal((await readMarketReport(file)).id, previous.id);
  assert.deepEqual((await readdir(root)).sort(), ['report.json', previous.stationSnapshot.file].sort());
});

test('successful replacement retires only the previous owned station snapshot', async t => {
  const { root, file } = await setup(t);
  const previous = await atomicWriteReport(file, report(), [station(1), buyer(2)]);
  await writeFile(join(root, 'unrelated.ndjson'), 'keep');
  const latest = await atomicWriteReport(file, report(), [station(3), buyer(4)], { previousReport: previous });
  assert.equal((await readMarketReport(file)).id, latest.id);
  assert.deepEqual((await readdir(root)).sort(), ['report.json', latest.stationSnapshot.file, 'unrelated.ndjson'].sort());
});

test('legacy embedded-station reports remain readable and upgrade on the next save', async t => {
  const { root, file } = await setup(t);
  const legacy = { ...report(), id: 'legacy-test-report', stations: [station(1), buyer(2)], opportunities: [{ obsolete: true }] };
  await writeFile(file, JSON.stringify(legacy));
  assert.equal((await readMarketReport(file)).stations.length, 2);
  const reader = new MarketService({ root, readOnly: true, now: () => NOW });
  t.after(() => reader.close()); await reader.ready;
  assert.equal((await reader.results()).total, 1);
  const saved = await atomicWriteReport(file, report(), legacy.stations, { previousReport: legacy });
  assert.equal((await readMarketReport(file)).id, saved.id);
  assert.equal(Object.hasOwn(JSON.parse(await readFile(file, 'utf8')), 'stations'), false);
});

test('snapshot references reject traversal, mismatched identifiers, unsupported format and corrupt/missing records', async t => {
  const { root, file } = await setup(t);
  const valid = await atomicWriteReport(file, report(), [station(1)]);
  for (const patch of [
    { file: '../outside.ndjson' }, { file: `stations-${randomUUID()}.ndjson` },
    { file: 'C:/outside.ndjson' }, { format: 'unsupported' }, { count: -1 },
  ]) {
    await writeFile(file, JSON.stringify({ ...valid, stationSnapshot: { ...valid.stationSnapshot, ...patch } }));
    await assert.rejects(readMarketReport(file), { code: 'STORAGE' });
  }
  await writeFile(file, JSON.stringify(valid));
  await writeFile(join(root, valid.stationSnapshot.file), `${JSON.stringify(station(1))}\n${JSON.stringify(station(2))}\n`);
  await assert.rejects(readMarketReport(file), /count exceeds/);
  await writeFile(join(root, valid.stationSnapshot.file), '{broken\n');
  await assert.rejects(readMarketReport(file), { code: 'STORAGE' });
  await rm(join(root, valid.stationSnapshot.file));
  await assert.rejects(readMarketReport(file), { code: 'STORAGE' });
  const reader = new MarketService({ root, readOnly: true, now: () => NOW });
  t.after(() => reader.close()); await reader.ready;
  assert.equal((await reader.status()).hasReport, false);
  assert.match((await reader.status()).warnings[0], /could not be loaded/);
});
