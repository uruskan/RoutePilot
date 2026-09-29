import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMarkets, normalizeStation, normalizeContext, timestampMs, distanceLy, coordinates,
  validateSettings, DEFAULT_SETTINGS, prepareMarkets, csvCell, buildCsv, parseResultQuery } from '../server/markets.mjs';
import { NOW, HOUR, at, station, buyer, quote, basic, context } from './fixtures/synthetic.mjs';
const analyze = (rows = basic(), options = {}) => analyzeMarkets(rows, { now: NOW, context, ...options });

test('buy_price is paid, sell_price is received; exact demand and full-stock arithmetic', async () => {
  const report = await analyze([station(1), buyer(2, { market: [quote({ sell_price: 180, demand: 20, supply: 0 })] })],
    { settings: { cargoCapacity: 8, credits: 1_000, creditReserve: 250 } });
  assert.equal(report.total, 1);
  const row = report.rows[0];
  assert.equal(row.marginPerTonne, 80); assert.equal(row.fullStockCost, 2_000); assert.equal(row.fullStockProfit, 1_600);
  assert.equal(row.affordableCargoPerTrip, 7); assert.equal(row.costPerLoad, 700); assert.equal(row.profitPerLoad, 560);
  assert.equal(row.tripsNeeded, 3); assert.equal(row.fullStockProfitConditional, true);
  assert.equal(row.playerToSellerLy, 10); assert.equal(row.sellerToBuyerLy, 10);
});
test('only explicitly public fleet carriers may sell; inaccessible carriers cannot buy', async () => {
  const records = [station(1), station(3, { carrier_docking_access: 'Friends' }), station(4, { carrier_docking_access: null }),
    station(5, { type: 'Outpost' }), buyer(2, { type: 'Fleet Carrier', carrier_docking_access: 'Squadron' }),
    buyer(8, { type: 'FleetCarrier', carrier_docking_access: 'all' })];
  const report = await analyze(records);
  assert.deepEqual(report.rows.map(row => [row.seller.id, row.buyer.id]), [['1', '8']]);
});
test('observed Spansh Drake-Class Carrier type supports public trades and excludes restricted carriers', async () => {
  const type = 'Drake-Class Carrier';
  const records = [station(1, { type }), station(3, { type, carrier_docking_access: 'Friends' }),
    station(4, { type, carrier_docking_access: null }),
    buyer(2, { type, carrier_docking_access: 'Squadron', market: [quote({ sell_price: 500, supply: 0, demand: 200 })] }),
    buyer(8, { type, carrier_docking_access: 'All' })];
  const report = await analyze(records);
  assert.deepEqual(report.rows.map(row => [row.seller.id, row.buyer.id]), [['1', '8']]);
  assert.equal(report.rows[0].seller.isCarrier, true);
  assert.equal(report.rows[0].buyer.isCarrier, true);
  assert.equal(report.diagnostics.inaccessibleCarriers, 3);
});

test('zero spread, negative spread and self-trades are excluded', async () => {
  const self = station(1, { market: [quote({ sell_price: 200, demand: 100 })] });
  assert.equal((await analyze([self])).total, 0);
  for (const price of [0, 80, 100]) assert.equal((await analyze([station(1), buyer(2, { market: [quote({ sell_price: price, demand: 200 })] })])).total, 0);
});
test('buyer demand must cover ENTIRE advertised stock, not only affordable load', async () => {
  const report = await analyze([station(1), buyer(2, { market: [quote({ sell_price: 900, demand: 19, supply: 0 })] }), buyer(3)],
    { settings: { cargoCapacity: 1, credits: 100 } });
  assert.equal(report.rows[0].buyer.id, '3');
  assert.equal(report.rows[0].affordableCargoPerTrip, 1);
});
test('pad and route constraints are applied before selecting the best buyer', async () => {
  const records = [station(1), buyer(2, { has_large_pad: false, medium_pads: 1,
    market: [quote({ sell_price: 400, demand: 200, supply: 0 })] }),
    buyer(3, { system_x: 500, market: [quote({ sell_price: 300, demand: 200, supply: 0 })] }), buyer(4, { system_x: 15 })];
  const report = await analyze(records, { query: { requiredPad: 'L', maxRouteDistanceLy: 20 } });
  assert.equal(report.rows[0].buyer.id, '4');
});
test('nearby seller and short market-to-market route are independent filters', async () => {
  const records = [station(1, { system_x: 1_000 }), buyer(2, { system_x: 1_001 })];
  assert.equal((await analyze(records, { query: { maxRouteDistanceLy: 2 } })).total, 1);
  assert.equal((await analyze(records, { query: { maxPlayerDistanceLy: 2 } })).total, 0);
});
test('missing position disables location-dependent requests rather than inferring a system position', async () => {
  const unknown = { systemName: 'Sol', StarPos: null };
  await assert.rejects(analyze(basic(), { context: unknown, query: { sort: 'closestSeller' } }), { code: 'LOCATION_UNAVAILABLE' });
  await assert.rejects(analyze(basic(), { context: unknown, query: { maxPlayerDistanceLy: 50 } }), { code: 'LOCATION_UNAVAILABLE' });
  const report = await analyze(basic(), { context: unknown, query: { sort: 'shortestRoute' } });
  assert.equal(report.rows[0].playerToSellerLy, null); assert.equal(report.rows[0].sellerToBuyerLy, 10);
  assert.ok(!report.availableSorts.includes('closestSeller'));
});
test('missing/empty/boolean coordinates are unknown, while real origin coordinates are valid', () => {
  for (const value of [null, [], [0, 0], ['', 0, 0], [null, 0, 0], [false, 0, 0], [Infinity, 0, 0]]) assert.equal(coordinates(value), null);
  assert.deepEqual(coordinates(['0', '-2.5', '4']), [0, -2.5, 4]);
  assert.equal(distanceLy([0, 0, 0], [3, 4, 0]), 5); assert.equal(distanceLy(null, [0, 0, 0]), null);
  assert.equal(normalizeContext({ systemName: 'Sol' }).positionAvailable, false);
});
test('missing market timestamp is not replaced by station updated_at', async () => {
  const records = [station(1, { market_updated_at: null, updated_at: at(0) }), buyer(2)];
  assert.equal((await analyze(records)).total, 0);
  const row = (await analyze(records, { query: { maxMarketAgeHours: null } })).rows[0];
  assert.equal(row.seller.marketUpdatedAt, null); assert.equal(row.seller.marketAgeHours, null);
  assert.equal(row.seller.stationUpdatedAt, at(0)); assert.ok(row.flags.includes('seller:market-time-unknown'));
});
test('staleness applies independently to both endpoints and ages are evaluated at query time', async () => {
  assert.equal((await analyze([station(1, { market_updated_at: at(-25) }), buyer(2)])).total, 0);
  assert.equal((await analyze([station(1), buyer(2, { market_updated_at: at(-25) })])).total, 0);
  const earlier = await analyze();
  const later = await analyze(basic(), { now: NOW + 2 * HOUR });
  assert.equal(earlier.rows[0].seller.marketAgeHours, 1); assert.equal(later.rows[0].seller.marketAgeHours, 3);
});
test('future timestamps are flagged, not clamped to zero; finite age filter rejects them', async () => {
  const records = [station(1, { market_updated_at: at(1) }), buyer(2)];
  assert.equal((await analyze(records)).total, 0);
  const row = (await analyze(records, { query: { maxMarketAgeHours: null } })).rows[0];
  assert.equal(row.seller.marketAgeHours, -1); assert.ok(row.flags.includes('seller:future-market-time'));
});
test('timestamps require valid dates and explicit timezones', () => {
  for (const value of [null, '', 0, '2030-04-05 12:00:00', '2030-02-30T12:00:00Z', '2030-13-01T00:00:00Z', '2030-04-05T24:00:00Z']) assert.equal(timestampMs(value), null);
  assert.equal(timestampMs('2030-04-05T15:00:00+03:00'), NOW);
});
test('budget, reserve, capacity and stock all independently cap the affordable load', async () => {
  for (const [settings, load] of [
    [{ cargoCapacity: 100, credits: 700, creditReserve: 250 }, 4],
    [{ cargoCapacity: 2, credits: 10_000, creditReserve: 0 }, 2],
    [{ cargoCapacity: 100, credits: 10_000, creditReserve: 0 }, 20],
    [{ cargoCapacity: 100, credits: 100, creditReserve: 200 }, 0],
    [{ cargoCapacity: 0, credits: 10_000 }, 0],
  ]) {
    const row = (await analyze(basic(), { settings })).rows[0];
    assert.equal(row.affordableCargoPerTrip, load);
    assert.equal(row.tripsNeeded, load > 0 ? Math.ceil(20 / load) : null);
  }
});
test('unset credits/cargo stay unknown and affordable-only excludes unknown and zero loads', async () => {
  const row = (await analyze()).rows[0];
  assert.equal(row.affordableCargoPerTrip, null); assert.equal(row.profitPerLoad, null); assert.equal(row.tripsNeeded, null);
  assert.equal((await analyze(basic(), { query: { list: 'affordable' } })).total, 0);
  assert.equal((await analyze(basic(), { settings: { cargoCapacity: 20, credits: 50 }, query: { list: 'affordable' } })).total, 0);
});
test('unknown pads fail strict size filters; explicit no-large cannot be bypassed', async () => {
  const unknown = [station(1), buyer(2, { has_large_pad: null, medium_pads: null, small_pads: null })];
  assert.equal((await analyze(unknown, { query: { requiredPad: 'L' } })).total, 0);
  const permissive = await analyze(unknown, { query: { requiredPad: 'L', allowUnknownPad: true } });
  assert.ok(permissive.rows[0].flags.includes('buyer:pad-unknown'));
  assert.equal((await analyze([station(1), buyer(2, { has_large_pad: false })], { query: { requiredPad: 'L', allowUnknownPad: true } })).total, 0);
});
test('larger confirmed pads support smaller ships', async () => {
  for (const size of ['S', 'M', 'L']) assert.equal((await analyze(basic(), { query: { requiredPad: size } })).total, 1);
});
test('permits, surface landings and conservative corrosive hazard flags are exposed and filterable', async () => {
  const records = [station(1, { market: [quote({ commodity: 'Thargoid Sensor' })] }),
    buyer(2, { system_needs_permit: true, is_planetary: true,
      market: [quote({ commodity: 'Thargoid Sensor', sell_price: 300, demand: 200, supply: 0 })] })];
  const row = (await analyze(records)).rows[0];
  assert.ok(row.flags.includes('buyer:permit-required')); assert.ok(row.flags.includes('buyer:surface-landing'));
  assert.ok(row.flags.includes('potentially-corrosive-cargo')); assert.ok(row.flags.includes('bulk-price-unmodeled'));
  for (const query of [{ allowPermitSystems: false }, { allowPlanetary: false }, { excludePotentiallyCorrosive: true }]) assert.equal((await analyze(records, { query })).total, 0);
});
test('unknown permit/surface fields are excluded by restrictive filters', async () => {
  assert.equal((await analyze([station(1), buyer(2, { system_needs_permit: null })], { query: { allowPermitSystems: false } })).total, 0);
  assert.equal((await analyze([station(1), buyer(2, { is_planetary: null })], { query: { allowPlanetary: false } })).total, 0);
});
test('best-price ties use shortest known route, then newer quote', async () => {
  const records = [station(1), buyer(2, { system_x: 50 }), buyer(3, { system_x: 11, market_updated_at: at(-2) }),
    buyer(4, { system_x: 11, market_updated_at: at(-0.5) })];
  assert.equal((await analyze(records)).rows[0].buyer.id, '4');
});
test('all five rankings produce the expected top result', async () => {
  const records = [station(1, { system_x: 1, market: [quote({ commodity: 'A', buy_price: 100, supply: 100 })] }),
    station(2, { system_x: 50, market: [quote({ commodity: 'B', buy_price: 1_000, supply: 5 })] }),
    buyer(3, { system_x: 51, market: [quote({ commodity: 'A', sell_price: 200, supply: 0, demand: 500 }),
      quote({ commodity: 'B', sell_price: 1_200, supply: 0, demand: 500 })] })];
  for (const [sort, commodity] of [['closestSeller', 'A'], ['shortestRoute', 'B'], ['margin', 'B'], ['loadProfit', 'A'], ['stockProfit', 'A']]) {
    const report = await analyze(records, { settings: { cargoCapacity: 10, credits: 1_000 }, query: { sort } });
    assert.equal(report.rows[0].commodity, commodity, sort);
  }
});
test('unknown distances sort last and cannot pass a distance limit', async () => {
  const records = [station(1, { system_x: null }), station(3), buyer(2)];
  const report = await analyze(records, { query: { sort: 'shortestRoute' } });
  assert.equal(report.rows[0].seller.id, '3'); assert.equal(report.rows[1].sellerToBuyerLy, null);
  assert.equal((await analyze(records, { query: { maxRouteDistanceLy: 1_000 } })).total, 1);
});
test('more than 100 real opportunities are retained without summing shared demand', async () => {
  const records = Array.from({ length: 160 }, (_, i) => station(i + 1)); records.push(buyer(500));
  const report = await analyze(records);
  assert.equal(report.total, 160); assert.equal(report.rows.length, 160);
  assert.equal(new Set(report.rows.map(row => row.sharedBuyerDemandKey)).size, 1);
  assert.equal(Object.hasOwn(report, 'totalProfit'), false);
});
test('unsafe arithmetic is surfaced as null/overflow, not imprecise credit totals', async () => {
  const records = [station(1, { market: [quote({ buy_price: Number.MAX_SAFE_INTEGER - 20, supply: 100 })] }),
    buyer(2, { market: [quote({ sell_price: Number.MAX_SAFE_INTEGER - 10, demand: 100, supply: 0 })] })];
  const row = (await analyze(records)).rows[0];
  assert.equal(row.fullStockCost, null); assert.equal(row.fullStockProfit, 1_000); assert.ok(row.flags.includes('numeric-overflow'));
});
test('commodity matching is case insensitive; duplicate commodity records fail closed', async () => {
  const report = await analyze([station(1, { market: [quote({ commodity: 'gold' })] }), buyer(2)]);
  assert.equal(report.total, 1);
  assert.equal((await analyze([station(1, { market: [quote(), quote({ commodity: 'gold', buy_price: 1 })] }), buyer(2)])).total, 0);
});
test('latest station observation wins without merging old and new stock', async () => {
  const database = await prepareMarkets([station(1, { market_updated_at: at(-2), market: [quote({ supply: 100 })] }),
    station(1, { market_updated_at: at(-1), market: [quote({ supply: 10 })] }), buyer(2)]);
  const report = await analyzeMarkets(database, { prepared: true, now: NOW });
  assert.equal(report.rows[0].stock, 10); assert.equal(database.diagnostics.duplicateStations, 1);
});
test('invalid station IDs and missing types do not become eligible markets', async () => {
  assert.equal(normalizeStation({ market_id: Number.MAX_SAFE_INTEGER + 1 }), null);
  assert.equal((await analyze([station(1), buyer(2, { type: null })])).total, 0);
});
test('CSV protection covers formula prefixes, whitespace, newlines and embedded delimiters', async () => {
  for (const value of ['=1+1', '+cmd', '-cmd', '@SUM(A1)', '   =1', '\t=1', '\r=1', '\uFEFF=1']) assert.ok(csvCell(value).startsWith('"\''), JSON.stringify(value));
  assert.equal(csvCell('a,"b"'), '"a,""b"""'); assert.equal(csvCell(null), '""'); assert.equal(csvCell(10), '"10"');
  const row = (await analyze([station(1, { carrier_name: '=DANGEROUS()' }), buyer(2)])).rows[0];
  const csv = buildCsv([row]);
  assert.ok(csv.startsWith('\uFEFF')); assert.ok(csv.includes('"\'=DANGEROUS()"'));
  assert.ok(csv.includes('Conditional full-stock profit')); assert.ok(csv.endsWith('\r\n'));
});
test('settings and result queries reject typos, coercions, duplicates and invalid ranges', () => {
  for (const patch of [{ cargoCapacity: '' }, { credits: false }, { minStock: 0 }, { windowHours: 0 }, { requiredPad: 'XL' }, { dailyRefresh: 'false' }, { unknown: 1 }]) assert.throws(() => validateSettings(patch));
  assert.throws(() => parseResultQuery(new URLSearchParams('limit=1&limit=2')));
  assert.throws(() => parseResultQuery(new URLSearchParams('maxRouteDistanceLy=')));
  assert.throws(() => parseResultQuery(new URLSearchParams('maxRouteDistanceLy=NaN')));
  assert.deepEqual(parseResultQuery(new URLSearchParams('maxMarketAgeHours=null&allowPlanetary=false')), { maxMarketAgeHours: null, allowPlanetary: false });
  assert.equal(DEFAULT_SETTINGS.credits, null);
});
test('deterministic randomized matching agrees with an independent exhaustive oracle', async () => {
  let seed = 91827; const random = max => { seed = (seed * 16807) % 2147483647; return seed % max; };
  for (let trial = 0; trial < 25; trial++) {
    const sellers = Array.from({ length: 12 }, (_, i) => station(i + 1, { system_x: random(100),
      market: [quote({ buy_price: 10 + random(100), supply: 1 + random(100) })] }));
    const buyers = Array.from({ length: 15 }, (_, i) => buyer(100 + i, { system_x: random(100),
      market: [quote({ buy_price: 0, sell_price: 10 + random(200), supply: 0, demand: 1 + random(150) })] }));
    const maxRouteDistanceLy = 30;
    const expected = new Map();
    for (const seller of sellers) {
      const options = buyers.filter(b => b.market[0].demand >= seller.market[0].supply && b.market[0].sell_price > seller.market[0].buy_price && Math.abs(seller.system_x - b.system_x) <= maxRouteDistanceLy)
        .sort((a, b) => b.market[0].sell_price - a.market[0].sell_price || Math.abs(seller.system_x - a.system_x) - Math.abs(seller.system_x - b.system_x) || String(a.market_id).localeCompare(String(b.market_id)));
      if (options.length) expected.set(String(seller.market_id), String(options[0].market_id));
    }
    const report = await analyze([...sellers, ...buyers], { query: { maxRouteDistanceLy } });
    assert.equal(report.total, expected.size);
    for (const row of report.rows) assert.equal(row.buyer.id, expected.get(row.seller.id));
  }
});

test('CSV formula protection covers Unicode compatibility prefixes and control characters', () => {
  for (const value of ['＝SUM(A1:A2)', '\u200b=HYPERLINK("evil")', '\ufeff\t+1+1', '\u0000@SUM(A1:A2)']) {
    assert.ok(csvCell(value).startsWith('"\''), JSON.stringify(value));
  }
  assert.equal(csvCell('Normal trade name'), '"Normal trade name"');
  assert.equal(csvCell(-7), '"-7"');
});
