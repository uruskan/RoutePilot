import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeMarkets, DEFAULT_SETTINGS, MarketService, validateSettings } from '../server/markets.mjs';
import { SPREADSHEET_DEFAULT_SETTINGS, SPREADSHEET_PRESETS, NEAR_ME_PRESET } from '../presets.mjs';
import { NOW, HOUR, at, station, buyer, quote, FAST, mockApi } from './fixtures/synthetic.mjs';

const sell = (id, commodity, supply = 100, overrides = {}) => station(id, {
  system_x: 0, market: [quote({ commodity, supply })], ...overrides,
});
const buy = (id, commodity, sellPrice = 200, overrides = {}) => buyer(id, {
  system_x: 10, market: [quote({ commodity, buy_price: 0, sell_price: sellPrice, supply: 0, demand: 1_000 })], ...overrides,
});

test('Near me finds demand-limited station trades with fresh short legs and preserves ship planning inputs', async () => {
  const settings = { ...SPREADSHEET_DEFAULT_SETTINGS, ...NEAR_ME_PRESET.settings, cargoCapacity: 80, credits: 100_000, creditReserve: 5_000 };
  const records = [sell(1, 'Gold', 1_000, { type: 'Outpost', system_x: 100 }),
    buy(2, 'Gold', 250, { type: 'Fleet Carrier', system_x: 125, market: [quote({ commodity: 'Gold', supply: 0, buy_price: 0, sell_price: 250, demand: 150 })] }),
    buy(3, 'Gold', 900, { system_x: 151 }), buy(4, 'Gold', 800, { system_x: 101, market_updated_at: at(-25) }),
    sell(5, 'Silver', 1_000, { type: 'Outpost', system_x: 201 }), buy(6, 'Silver', 900, { system_x: 202 })];
  const result = await analyzeMarkets(records, { settings, context: { systemName: 'Origin', StarPos: [0, 0, 0] }, now: NOW });
  assert.equal(result.total, 1); assert.equal(result.rows[0].buyer.id, '2');
  assert.equal(result.rows[0].stock, 150); assert.equal(result.rows[0].affordableCargoPerTrip, 80);
  assert.equal(result.sort, 'loadProfit'); assert.equal(settings.creditReserve, 5_000);
  assert.equal(Object.hasOwn(NEAR_ME_PRESET.settings, 'cargoCapacity'), false);
  assert.equal(Object.hasOwn(NEAR_ME_PRESET.settings, 'credits'), false);
  assert.equal(NEAR_ME_PRESET.settings.excludeCarrierAccess, true);
});

test('nearby spreadsheet query enforces 100t/48h/150ly boundaries and recomputes the best eligible buyer', async () => {
  const records = [
    sell(1, 'Gold', 100, { market_updated_at: at(-48) }),
    buy(2, 'Gold', 200, { system_x: 150, market_updated_at: at(-48) }),
    buy(3, 'Gold', 900, { system_x: 151 }),
    buy(4, 'Gold', 800, { market_updated_at: at(-48.001) }),
    buy(5, 'Gold', 700, { market: [quote({ commodity: 'Gold', supply: 0, sell_price: 700, demand: 99 })] }),
    sell(6, 'Silver', 99), buy(7, 'Silver', 2_000),
    sell(8, 'Platinum', 100, { market_updated_at: at(-48.001) }), buy(9, 'Platinum', 2_000),
    sell(10, 'Palladium', 100, { carrier_docking_access: 'None' }), buy(11, 'Palladium', 2_000),
  ];
  const result = await analyzeMarkets(records, { settings: SPREADSHEET_DEFAULT_SETTINGS, now: NOW });
  assert.equal(result.total, 1);
  assert.equal(result.rows[0].seller.id, '1');
  assert.equal(result.rows[0].buyer.id, '2');
  assert.equal(result.rows[0].stock, 100);
  assert.equal(result.rows[0].sellerToBuyerLy, 150);
  assert.equal(result.rows[0].profitPerLoad, 1_600);
  assert.equal(result.rows[0].fullStockProfit, 10_000);
  assert.equal(result.sort, 'stockProfit');
});

test('highest-buyers spreadsheet query includes small older distant lots without weakening whole-stock demand coverage', async () => {
  const records = [
    sell(1, 'Gold', 1, { market_updated_at: at(-192) }),
    buy(2, 'Gold', 900, { system_x: 20_000, market_updated_at: at(-192) }),
    sell(3, 'Silver', 100),
    buy(4, 'Silver', 900, { market: [quote({ commodity: 'Silver', supply: 0, sell_price: 900, demand: 99 })] }),
    sell(5, 'Platinum', 100, { market_updated_at: at(-192.001) }), buy(6, 'Platinum', 900),
  ];
  const result = await analyzeMarkets(records, { settings: SPREADSHEET_PRESETS.highestBuyers.settings, now: NOW });
  assert.equal(result.total, 1);
  assert.equal(result.rows[0].stock, 1);
  assert.equal(result.rows[0].sellerToBuyerLy, 20_000);
  assert.equal(result.sort, 'stockProfit');
});

test('spreadsheet ranking uses whole-stock profit and shorter routes for ties, not per-tonne margin', async () => {
  const records = [
    sell(1, 'Gold', 100), buy(2, 'Gold', 200, { system_x: 100 }),
    sell(3, 'Silver', 200), buy(4, 'Silver', 150, { system_x: 10 }),
    sell(5, 'Platinum', 400), buy(6, 'Platinum', 150, { system_x: 140 }),
  ];
  const result = await analyzeMarkets(records, { settings: SPREADSHEET_DEFAULT_SETTINGS, now: NOW });
  assert.deepEqual(result.rows.map(row => row.commodity), ['Platinum', 'Silver', 'Gold']);
  assert.deepEqual(result.rows.map(row => row.fullStockProfit), [20_000, 10_000, 10_000]);
  const overridden = await analyzeMarkets(records, { settings: SPREADSHEET_DEFAULT_SETTINGS, query: { sort: 'margin' }, now: NOW });
  assert.equal(overridden.rows[0].commodity, 'Gold');
});

test('host defaults preserve saved custom filters and ranking across restarts, while current location remains live', async t => {
  const root = await mkdtemp(join(tmpdir(), 'routepilot-spreadsheet-presets-'));
  const services = [];
  t.after(async () => { for (const service of services) await service.close(); await rm(root, { recursive: true, force: true }); });
  let context = { systemName: 'First location', StarPos: [0, 0, 0] };
  const api = mockApi([sell(1, 'Gold', 100, { system_x: 10 }), buy(2, 'Gold')]);
  const open = async defaults => {
    const service = new MarketService({ root, fetchImpl: api, now: () => NOW, getContext: () => context, defaultSettings: defaults });
    services.push(service); await service.ready; return service;
  };
  const first = await open(SPREADSHEET_DEFAULT_SETTINGS);
  assert.equal((await first.status()).settings.minStock, 100);
  assert.equal((await first.status()).settings.defaultSort, 'stockProfit');
  await first.configure({ ...FAST, minStock: 77, cargoCapacity: 8, defaultSort: 'shortestRoute' });
  assert.equal((await first.refresh()).outcome, 'succeeded');
  assert.equal(Date.parse(api.calls[0].body.filters.market_updated_at.value[0]), NOW - 192 * HOUR);
  assert.equal((await first.results()).rows[0].playerToSellerLy, 10);
  const requests = api.calls.length;
  context = { systemName: 'Current location', StarPos: [10, 0, 0] };
  assert.equal((await first.results()).rows[0].playerToSellerLy, 0);
  assert.equal(api.calls.length, requests);
  await first.close();
  const second = await open(SPREADSHEET_DEFAULT_SETTINGS);
  const saved = (await second.status()).settings;
  assert.equal(saved.minStock, 77);
  assert.equal(saved.cargoCapacity, 8);
  assert.equal(saved.defaultSort, 'shortestRoute');
  assert.equal((await second.results()).sort, 'shortestRoute');
  await second.close();

  // A pre-upgrade state has no defaultSort. Fill that new key from the host's
  // defaults without replacing any existing customized filter or budget.
  const statePath = join(root, 'state.json');
  const legacy = JSON.parse(await readFile(statePath, 'utf8'));
  delete legacy.settings.defaultSort;
  await writeFile(statePath, JSON.stringify(legacy));
  context = null;
  const third = await open(SPREADSHEET_DEFAULT_SETTINGS);
  assert.equal((await third.status()).settings.minStock, 77);
  assert.equal((await third.status()).settings.defaultSort, 'stockProfit');
  const result = await third.results();
  assert.equal(result.sort, 'stockProfit');
  assert.equal(result.rows[0].playerToSellerLy, null);
});

test('preset objects are immutable and library defaults remain generic; defaultSort is validated', () => {
  assert.equal(DEFAULT_SETTINGS.minStock, 1);
  assert.equal(DEFAULT_SETTINGS.windowHours, 24);
  assert.equal(DEFAULT_SETTINGS.defaultSort, 'margin');
  assert.ok(Object.isFrozen(SPREADSHEET_PRESETS));
  for (const preset of Object.values(SPREADSHEET_PRESETS)) {
    assert.ok(Object.isFrozen(preset));
    assert.ok(Object.isFrozen(preset.settings));
    assert.equal(Object.hasOwn(preset.settings, 'credits'), false);
    assert.equal(Object.hasOwn(preset.settings, 'StarPos'), false);
    assert.equal(preset.settings.maxPlayerDistanceLy, null);
  }
  assert.throws(() => validateSettings({ defaultSort: 'invented' }), { code: 'VALIDATION' });
  assert.throws(() => new MarketService({ root: '.', defaultSettings: { defaultSort: 'invented' } }), { code: 'VALIDATION' });
});

test('a persisted closest-seller ranking cannot block collection while the journal position is unknown', async t => {
  const root = await mkdtemp(join(tmpdir(), 'routepilot-spreadsheet-sort-'));
  const service = new MarketService({ root, fetchImpl: mockApi([sell(1, 'Gold'), buy(2, 'Gold')]),
    now: () => NOW, defaultSettings: { ...SPREADSHEET_DEFAULT_SETTINGS, ...FAST, defaultSort: 'closestSeller' } });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  await service.ready;
  assert.equal((await service.refresh()).outcome, 'succeeded');
  await assert.rejects(service.results(), { code: 'LOCATION_UNAVAILABLE' });
  assert.equal((await service.results({ sort: 'stockProfit' })).total, 1);
});
