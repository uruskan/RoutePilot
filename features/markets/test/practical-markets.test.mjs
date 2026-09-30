import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeMarkets, prepareMarkets, validateSettings, parseResultQuery, buildCsv, MarketService } from '../server/markets.mjs';
import { isKnownCarrierAccessSystem } from '../access-rules.mjs';
import { NOW, station, buyer, quote, FAST, context, mockApi } from './fixtures/synthetic.mjs';

const analyze = (records, options = {}) => analyzeMarkets(records, { now: NOW, context, ...options });
const sale = (id, price, demand, overrides = {}) => buyer(id, {
  market: [quote({ buy_price: 0, sell_price: price, demand, supply: 0 })], ...overrides,
});

test('known carrier-access matching normalizes case and spaces without guessing other systems', () => {
  assert.equal(isKnownCarrierAccessSystem('  hip  58832  '), true);
  for (const name of ['HIP 5883', 'HIP 58832 A', 'Sol', null, '']) {
    assert.equal(isKnownCarrierAccessSystem(name), false);
  }
});

test('carrier-access exclusion removes sellers and re-matches buyers before selecting a price', async () => {
  const records = [station(1), station(2, { system_name: 'HIP 58832' }),
    sale(3, 500, 100, { system_name: 'hip   58832' }), sale(4, 200, 100)];
  const defaults = await analyze(records);
  assert.deepEqual(defaults.rows.map(row => [row.seller.id, row.buyer.id]), [['1', '4']]);
  const allowed = await analyze(records, { query: { excludeCarrierAccess: false } });
  assert.equal(allowed.total, 2);
  assert.equal(allowed.rows.find(row => row.seller.id === '1').buyer.id, '3');
  assert.ok(allowed.rows.every(row => row.flags.includes('buyer:carrier-transport-required')));
  assert.ok(allowed.rows.find(row => row.seller.id === '2').flags.includes('seller:carrier-transport-required'));
});

test('prepared market cache supports station and carrier sellers with independently selected buyers', async () => {
  const records = [station(1), station(2, { type: 'Outpost' }),
    station(3, { carrier_docking_access: 'Friends' }),
    station(4, { type: null }), sale(10, 250, 100, { type: 'Drake-Class Carrier' }),
    sale(11, 200, 100), sale(12, 900, 100, { type: 'Drake-Class Carrier', carrier_docking_access: 'Squadron' })];
  const database = await prepareMarkets(records);
  assert.deepEqual(database.sellers.map(entry => entry.station.id), ['1', '2']);
  assert.deepEqual((await analyze(database, { prepared: true })).rows.map(row => row.seller.id), ['1']);
  const stationTrades = await analyze(database, { prepared: true, query: { sellerType: 'stations', buyerType: 'stations' } });
  assert.deepEqual(stationTrades.rows.map(row => [row.seller.id, row.buyer.id]), [['2', '11']]);
  const allTrades = await analyze(database, { prepared: true, query: { sellerType: 'all', buyerType: 'carriers' } });
  assert.deepEqual(allTrades.rows.map(row => [row.seller.id, row.buyer.id]), [['1', '10'], ['2', '10']]);
});

test('partial-demand option caps tradable stock, all costs, profits, load and trips', async () => {
  const records = [station(1, { market: [quote({ supply: 1_000 })] }), sale(2, 250, 25, { type: 'Fleet Carrier' }), sale(3, 180, 1_000)];
  const settings = { cargoCapacity: 16, credits: 100_000, creditReserve: 0 };
  const full = (await analyze(records, { settings })).rows[0];
  assert.equal(full.buyer.id, '3'); assert.equal(full.stock, 1_000); assert.equal(full.demandLimited, false);
  const partial = (await analyze(records, { settings, query: { requireFullStockDemand: false } })).rows[0];
  assert.equal(partial.buyer.id, '2'); assert.equal(partial.sellerStock, 1_000);
  assert.equal(partial.stock, 25); assert.equal(partial.buyerDemand, 25); assert.equal(partial.demandLimited, true);
  assert.equal(partial.fullStockCost, 2_500); assert.equal(partial.fullStockProfit, 3_750);
  assert.equal(partial.affordableCargoPerTrip, 16); assert.equal(partial.costPerLoad, 1_600);
  assert.equal(partial.profitPerLoad, 2_400); assert.equal(partial.tripsNeeded, 2);
  assert.equal(partial.stockToDemandFraction, 1); assert.equal(partial.loadToDemandFraction, 16 / 25);
  assert.ok(partial.flags.includes('buyer-demand-limits-lot'));
  const oneLoad = (await analyze(records, { settings: { ...settings, cargoCapacity: 100 }, query: { requireFullStockDemand: false } })).rows[0];
  assert.equal(oneLoad.affordableCargoPerTrip, 25); assert.equal(oneLoad.profitPerLoad, 3_750); assert.equal(oneLoad.tripsNeeded, 1);
});

test('minimum stock applies to tradable quantity, not just large advertised supply', async () => {
  const records = [station(1, { market: [quote({ supply: 1_000 })] }),
    sale(2, 500, 1, { type: 'Fleet Carrier' }), sale(3, 250, 99, { type: 'Fleet Carrier' }), sale(4, 180, 100, { type: 'Fleet Carrier' })];
  const report = await analyze(records, { query: { requireFullStockDemand: false, minStock: 100 } });
  assert.equal(report.rows[0].buyer.id, '4'); assert.equal(report.rows[0].stock, 100);
  assert.equal((await analyze(records.slice(0, 3), { query: { requireFullStockDemand: false, minStock: 100 } })).total, 0);
});

test('new settings and result parameters validate strictly and do not mutate defaults', () => {
  const patch = { sellerType: 'all', buyerType: 'stations', excludeCarrierAccess: false, requireFullStockDemand: false };
  assert.deepEqual(parseResultQuery(new URLSearchParams(patch)), patch);
  const validated = validateSettings(patch);
  for (const [key, value] of Object.entries(patch)) assert.equal(validated[key], value);
  assert.equal(validateSettings({}).sellerType, 'carriers');
  assert.equal(validateSettings({}).excludeCarrierAccess, true);
  assert.equal(validateSettings({}).requireFullStockDemand, true);
  for (const bad of [{ sellerType: 'station' }, { buyerType: null }, { excludeCarrierAccess: 'false' }, { requireFullStockDemand: 0 }]) {
    assert.throws(() => validateSettings(bad), { code: 'VALIDATION' });
  }
  for (const query of ['sellerType=station', 'buyerType=Stations', 'excludeCarrierAccess=0', 'requireFullStockDemand=', 'sellerType=all&sellerType=carriers']) {
    assert.throws(() => parseResultQuery(new URLSearchParams(query)), { code: 'VALIDATION' });
  }
});

test('CSV distinguishes advertised seller stock from the demand-limited tradable lot', async () => {
  const report = await analyze([station(1, { market: [quote({ supply: 1_000 })] }), sale(2, 250, 25, { type: 'Fleet Carrier' })],
    { query: { requireFullStockDemand: false } });
  const [header, values] = buildCsv(report.rows).trimEnd().split('\r\n').map(line => line.replace(/^\uFEFF/, '').split(',').map(cell => cell.slice(1, -1)));
  const row = Object.fromEntries(header.map((name, index) => [name, values[index]]));
  assert.equal(row['Seller stock (t)'], '1000'); assert.equal(row['Buyer demand (t)'], '25');
  assert.equal(row['Tradable lot (t)'], '25'); assert.equal(row['Demand-limited lot'], 'true');
  assert.equal(row['Lot cost (Cr)'], '2500'); assert.equal(row['Conditional lot profit (Cr)'], '3750');
  assert.ok(!header.some(name => name.includes('full-stock')));
});

test('settings survive restart and cached station sellers are queryable without another refresh', async t => {
  const root = await mkdtemp(join(tmpdir(), 'routepilot-practical-test-'));
  const api = mockApi([station(1), station(2, { type: 'Outpost', market: [quote({ supply: 1_000 })] }), sale(3, 200, 40)]);
  let service = new MarketService({ root, fetchImpl: api, now: () => NOW, getContext: () => context });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  await service.ready; await service.configure(FAST); await service.refresh();
  assert.deepEqual((await service.results()).rows.map(row => row.seller.id), ['1']);
  const requestCount = api.calls.length;
  const patch = { sellerType: 'stations', buyerType: 'stations', excludeCarrierAccess: false, requireFullStockDemand: false };
  await service.configure(patch);
  assert.equal((await service.results()).rows[0].seller.id, '2');
  assert.equal((await service.results()).rows[0].stock, 1_000);
  assert.equal((await service.results({ sellerType: 'carriers' })).rows[0].seller.id, '1');
  assert.equal(api.calls.length, requestCount);
  const saved = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'));
  for (const [key, value] of Object.entries(patch)) assert.equal(saved.settings[key], value);
  await service.close();
  service = new MarketService({ root, fetchImpl: async () => { throw new Error('No network on restart'); }, now: () => NOW, getContext: () => context });
  await service.ready;
  for (const [key, value] of Object.entries(patch)) assert.equal((await service.status()).settings[key], value);
  assert.equal((await service.results()).rows[0].seller.id, '2');
  assert.equal((await service.results({ sellerType: 'all' })).total, 2);
});

test('NPC reported demand zero can buy in normal mode; carrier zero and unknown demand cannot', async () => {
  const records = [station(1, { market: [quote({ supply: 1_000 })] }),
    sale(2, 250, 0), sale(3, 500, 0, { type: 'Fleet Carrier' }), sale(4, 900, null)];
  const query = { requireFullStockDemand: false, minStock: 100, maxRouteDistanceLy: 50 };
  const row = (await analyze(records, { query, settings: { cargoCapacity: 16, credits: 100_000 } })).rows[0];
  assert.equal(row.buyer.id, '2'); assert.equal(row.buyerDemand, 0);
  assert.equal(row.stock, 1_000); assert.equal(row.sellerStock, 1_000); assert.equal(row.demandLimited, false);
  assert.equal(row.fullStockProfit, 150_000); assert.equal(row.affordableCargoPerTrip, 16);
  assert.equal(row.loadToDemandFraction, null); assert.equal(row.stockToDemandFraction, null);
  assert.ok(row.flags.includes('station-demand-not-order-limit'));
  assert.equal((await analyze(records, { query: { ...query, requireFullStockDemand: true } })).total, 0);
  assert.equal((await analyze(records.slice(0, 1).concat(records.slice(2)), { query })).total, 0);
});

test('NPC small positive demand does not cap quantity in normal mode but legacy whole-stock filter remains strict', async () => {
  const records = [station(1, { market: [quote({ supply: 1_000 })] }), sale(2, 250, 2)];
  assert.equal((await analyze(records)).total, 0);
  const row = (await analyze(records, { query: { requireFullStockDemand: false, minStock: 100 } })).rows[0];
  assert.equal(row.stock, 1_000); assert.equal(row.buyerDemand, 2); assert.equal(row.demandLimited, false);
});

test('spatial buyer search includes negative, boundary and exact-zero routes and preserves price/distance/freshness ties', async () => {
  const seller = station(1, { system_x: -0.25, system_y: -0.5, system_z: -0.75 });
  const atPosition = (id, position, price = 200, extra = {}) => sale(id, price, 200, {
    system_x: position[0], system_y: position[1], system_z: position[2], ...extra,
  });
  const records = [seller, atPosition(2, [0.25, -0.5, -0.75], 300),
    atPosition(3, [-0.25, -0.5, -0.75]), atPosition(4, [-0.25, -0.5, -0.75], 200,
      { market_updated_at: new Date(NOW - 1000).toISOString() }),
    atPosition(5, [-0.25, 0.000001, -0.75], 900), atPosition(6, [null, 0, 0], 1_000)];
  assert.equal((await analyze(records, { query: { maxRouteDistanceLy: 0.5 } })).rows[0].buyer.id, '2');
  assert.equal((await analyze(records, { query: { maxRouteDistanceLy: 0 } })).rows[0].buyer.id, '4');
  assert.equal((await analyze(records, { query: { maxRouteDistanceLy: 0.01 } })).rows[0].buyer.id, '4');
});

test('nearby matching does not walk thousands of higher-priced remote buyers per seller', async () => {
  const records = [station(1), sale(2, 180, 100), ...Array.from({ length: 5_000 }, (_, i) =>
    sale(i + 100, 900, 100, { system_x: 1_000 + i, system_y: 2_000, system_z: -2_000 }))];
  const report = await analyze(records, { query: { maxRouteDistanceLy: 50 } });
  assert.equal(report.rows[0].buyer.id, '2');
  assert.ok(report.diagnostics.comparisons < 10, `Compared ${report.diagnostics.comparisons} candidates`);
});
