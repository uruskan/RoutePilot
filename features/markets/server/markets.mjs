/**
 * RoutePilot market scanner. Node.js >=22; ES modules; no runtime dependencies.
 * This module never reads game files or sends game input. Its only location source
 * is the injected, read-only getContext callback. See docs/INTEGRATION.md.
 */
import { mkdir, open, readFile, rename, unlink, lstat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import { isKnownCarrierAccessSystem } from '../access-rules.mjs';

export const SCHEMA_VERSION = 1;
export const SEARCH_URL = 'https://spansh.co.uk/api/stations/search';
export const DETAIL_URL = 'https://spansh.co.uk/api/station/';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const clone = value => structuredClone(value);

export class MarketError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'MarketError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
export class ValidationError extends MarketError {
  constructor(message) { super('VALIDATION', message); }
}
export class CoverageError extends MarketError {
  constructor(message, coverage) { super('INCOMPLETE_COVERAGE', message, coverage); }
}
const abortError = () => new MarketError('CANCELLED', 'Refresh cancelled; the previous report was retained.');
function checkAbort(signal) { if (signal?.aborted) throw abortError(); }
function errorInfo(error) {
  return { code: error?.code || 'INTERNAL', message: String(error?.message || error),
    ...(error?.details !== undefined ? { details: error.details } : {}) };
}
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function finite(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function whole(value) {
  const number = finite(value);
  return number !== null && Number.isSafeInteger(number) && number >= 0 ? number : null;
}
function bool(value) {
  if (value === true || value === 1 || value === 'true' || value === '1') return true;
  if (value === false || value === 0 || value === 'false' || value === '0') return false;
  return null;
}
function marketId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9]\d{0,31}$/.test(value)) return value;
  return null;
}
/** Reject missing, timezone-less and impossible dates; never use updated_at as a market timestamp. */
export function timestampMs(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, ys, mos, ds, hs, mis, ss, zone] = match;
  const [y, mo, d, h, mi, s] = [ys, mos, ds, hs, mis, ss].map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate() || h > 23 || mi > 59 || s > 59) return null;
  if (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59)) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}
function iso(ms) { return new Date(ms).toISOString(); }
function clockMs(now) {
  const result = now();
  const ms = result instanceof Date ? result.getTime() : result;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || !Number.isFinite(new Date(ms).getTime())) throw new ValidationError('now() must return a valid Date or epoch milliseconds.');
  return ms;
}
export function coordinates(value) {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const result = value.map(finite);
  return result.every(n => n !== null) ? result : null;
}
export function distanceLy(a, b) {
  const left = coordinates(a), right = coordinates(b);
  if (!left || !right) return null;
  const result = Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
  return Number.isFinite(result) ? result : null;
}
export function normalizeContext(value) {
  const input = record(value) ? value : {};
  const StarPos = coordinates(input.StarPos);
  return { systemName: text(input.systemName) || text(input.StarSystem), StarPos,
    positionAvailable: StarPos !== null,
    warning: StarPos ? null : 'Current position is unknown. No location is inferred from the system name.' };
}

export const DEFAULT_SETTINGS = Object.freeze({
  cargoCapacity: null, credits: null, creditReserve: 0, defaultSort: 'margin',
  windowHours: 24, minStock: 1, maxMarketAgeHours: 24, requiredPad: 'any',
  maxPlayerDistanceLy: null, maxRouteDistanceLy: null,
  allowUnknownPad: false, allowPermitSystems: true, allowPlanetary: true,
  excludePotentiallyCorrosive: false, excludeCarrierAccess: true,
  sellerType: 'carriers', buyerType: 'all', requireFullStockDemand: true,
  dailyRefresh: false, dailyUtcHour: 3,
  concurrency: 2, minRequestIntervalMs: 500, timeoutMs: 20_000,
  maxRetries: 3, retryBaseMs: 1_000, retryMaxMs: 30_000,
  // Live Spansh results include large nested station payloads; 500 rows can
  // exceed the bounded 32 MiB response reader before compaction.
  pageSize: 100, queryResultCap: 10_000, maxPagesPerSlice: 20,
  minSliceMs: 1_000, maxSplitDepth: 24, maxRequests: 2_000,
  maxStations: 100_000, hydrateMissingMarkets: true, maxDetailRequests: 2_000,
  maxResponseBytes: 32 * 1024 * 1024,
  schedulerRetryBaseMs: 5 * 60_000, schedulerRetryMaxMs: 6 * HOUR,
  cancellationBackoffMs: 30 * 60_000,
});
const NUMERIC_RULES = {
  cargoCapacity: [0, 1_000_000, true, true], credits: [0, MAX_SAFE, true, true],
  creditReserve: [0, MAX_SAFE, true, false], windowHours: [1 / 60, 24 * 30, false, false],
  minStock: [1, MAX_SAFE, true, false], maxMarketAgeHours: [0, 24 * 365, false, true],
  maxPlayerDistanceLy: [0, 1_000_000, false, true], maxRouteDistanceLy: [0, 1_000_000, false, true],
  dailyUtcHour: [0, 23, true, false], concurrency: [1, 8, true, false],
  minRequestIntervalMs: [0, 60_000, true, false], timeoutMs: [10, 300_000, true, false],
  maxRetries: [0, 10, true, false], retryBaseMs: [0, 60_000, true, false],
  retryMaxMs: [0, 300_000, true, false], pageSize: [1, 500, true, false],
  queryResultCap: [1, 1_000_000, true, false], maxPagesPerSlice: [1, 1_000, true, false],
  minSliceMs: [1_000, DAY, true, false], maxSplitDepth: [0, 30, true, false],
  maxRequests: [1, 100_000, true, false], maxStations: [1, 1_000_000, true, false],
  maxDetailRequests: [0, 100_000, true, false], maxResponseBytes: [1_024, 256 * 1024 * 1024, true, false],
  schedulerRetryBaseMs: [1_000, DAY, true, false], schedulerRetryMaxMs: [1_000, 7 * DAY, true, false],
  cancellationBackoffMs: [1_000, DAY, true, false],
};
const BOOLEAN_KEYS = new Set(['allowUnknownPad', 'allowPermitSystems', 'allowPlanetary',
  'excludePotentiallyCorrosive', 'excludeCarrierAccess', 'requireFullStockDemand', 'dailyRefresh', 'hydrateMissingMarkets']);
export const FILTER_KEYS = Object.freeze(['cargoCapacity', 'credits', 'creditReserve', 'minStock',
  'maxMarketAgeHours', 'requiredPad', 'maxPlayerDistanceLy', 'maxRouteDistanceLy',
  'allowUnknownPad', 'allowPermitSystems', 'allowPlanetary', 'excludePotentiallyCorrosive',
  'excludeCarrierAccess', 'sellerType', 'buyerType', 'requireFullStockDemand']);
export const MARKET_TYPES = Object.freeze(['carriers', 'stations', 'all']);
export const SORTS = Object.freeze(['closestSeller', 'shortestRoute', 'margin', 'loadProfit', 'stockProfit']);
export const LISTS = Object.freeze(['all', 'affordable']);

export function validateSettings(patch, base = DEFAULT_SETTINGS) {
  if (!record(patch)) throw new ValidationError('Settings must be an object.');
  const output = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) throw new ValidationError(`Unknown setting: ${key}`);
    if (NUMERIC_RULES[key]) {
      const [min, max, integer, nullable] = NUMERIC_RULES[key];
      if (value === null && nullable) { output[key] = null; continue; }
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) {
        throw new ValidationError(`${key} must be ${nullable ? 'null or ' : ''}${integer ? 'an integer' : 'a number'} in [${min}, ${max}].`);
      }
    } else if (BOOLEAN_KEYS.has(key)) {
      if (typeof value !== 'boolean') throw new ValidationError(`${key} must be a boolean.`);
    } else if (key === 'defaultSort' && !SORTS.includes(value)) {
      throw new ValidationError(`defaultSort must be one of ${SORTS.join(', ')}.`);
    } else if (key === 'requiredPad' && !['any', 'S', 'M', 'L'].includes(value)) {
      throw new ValidationError('requiredPad must be any, S, M or L.');
    } else if (['sellerType', 'buyerType'].includes(key) && !MARKET_TYPES.includes(value)) {
      throw new ValidationError(`${key} must be one of ${MARKET_TYPES.join(', ')}.`);
    }
    output[key] = value;
  }
  if (output.retryMaxMs < output.retryBaseMs) throw new ValidationError('retryMaxMs must be >= retryBaseMs.');
  if (output.schedulerRetryMaxMs < output.schedulerRetryBaseMs) throw new ValidationError('schedulerRetryMaxMs must be >= schedulerRetryBaseMs.');
  return output;
}
function queryOptions(query, settings) {
  if (!record(query)) throw new ValidationError('Result options must be an object.');
  const allowed = new Set([...FILTER_KEYS, 'list', 'sort', 'limit', 'offset']);
  for (const key of Object.keys(query)) if (!allowed.has(key)) throw new ValidationError(`Unknown result option: ${key}`);
  const patch = {};
  for (const key of FILTER_KEYS) if (Object.hasOwn(query, key)) patch[key] = query[key];
  const filters = validateSettings(patch, settings);
  const list = query.list ?? 'all', sort = query.sort ?? settings.defaultSort;
  const limit = query.limit ?? 100, offset = query.offset ?? 0;
  if (!LISTS.includes(list)) throw new ValidationError(`list must be ${LISTS.join(' or ')}.`);
  if (!SORTS.includes(sort)) throw new ValidationError(`sort must be one of ${SORTS.join(', ')}.`);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new ValidationError('limit must be an integer in [1, 1000].');
  if (!Number.isSafeInteger(offset) || offset < 0) throw new ValidationError('offset must be a nonnegative integer.');
  return { filters, list, sort, limit, offset };
}
/** HTTP/CLI query conversion is explicit: empty strings never mean zero. */
export function parseResultQuery(params) {
  const result = {};
  for (const [key, value] of params) {
    if (Object.hasOwn(result, key)) throw new ValidationError(`Duplicate query parameter: ${key}`);
    if (['list', 'sort', 'requiredPad', 'sellerType', 'buyerType'].includes(key)) result[key] = value;
    else if (BOOLEAN_KEYS.has(key) && FILTER_KEYS.includes(key)) {
      if (!['true', 'false'].includes(value)) throw new ValidationError(`${key} must be true or false.`);
      result[key] = value === 'true';
    } else if (NUMERIC_RULES[key] && FILTER_KEYS.includes(key)) {
      if (value === 'null' && NUMERIC_RULES[key][3]) result[key] = null;
      else if (finite(value) !== null) result[key] = finite(value);
      else throw new ValidationError(`Invalid numeric query parameter: ${key}`);
    } else if (['limit', 'offset'].includes(key) && whole(value) !== null) result[key] = whole(value);
    else throw new ValidationError(`Unknown or invalid query parameter: ${key}`);
  }
  queryOptions(result, DEFAULT_SETTINGS);
  return result;
}

const STATION_FIELDS = ['market_id', 'name', 'carrier_name', 'real_name', 'type', 'system_name',
  'system_x', 'system_y', 'system_z', 'distance_to_arrival', 'has_large_pad', 'medium_pads',
  'small_pads', 'is_planetary', 'carrier_docking_access', 'system_needs_permit',
  'market_updated_at', 'updated_at', 'government'];
function compactStation(value) {
  if (!record(value)) return {};
  const output = {};
  for (const key of STATION_FIELDS) if (Object.hasOwn(value, key)) output[key] = value[key];
  if (Array.isArray(value.market)) output.market = value.market.map(entry => record(entry) ? {
    commodity: entry.commodity, category: entry.category, buy_price: entry.buy_price,
    sell_price: entry.sell_price, supply: entry.supply, demand: entry.demand,
  } : null);
  return output;
}
export function isFleetCarrier(value) {
  return typeof value === 'string' && ['fleetcarrier', 'drakeclasscarrier'].includes(value.toLowerCase().replace(/[\s_-]+/g, ''));
}
/** Fail closed. Never infer public access from missing, friends, squadron or numeric values. */
export function publicDocking(value) {
  return typeof value === 'string' && ['all', 'public'].includes(value.trim().toLowerCase());
}
export function normalizeStation(raw) {
  if (!record(raw)) return null;
  const id = marketId(raw.market_id);
  if (!id) return null;
  const type = text(raw.type);
  const station = {
    id, name: text(raw.name) || `Market ${id}`,
    displayName: text(raw.carrier_name) || text(raw.real_name) || text(raw.name) || `Market ${id}`,
    carrierName: text(raw.carrier_name), realName: text(raw.real_name), type,
    isCarrier: isFleetCarrier(type), publicDocking: publicDocking(raw.carrier_docking_access),
    dockingAccess: text(raw.carrier_docking_access), systemName: text(raw.system_name),
    coordinates: coordinates([raw.system_x, raw.system_y, raw.system_z]),
    arrivalDistanceLs: finite(raw.distance_to_arrival),
    hasLargePad: bool(raw.has_large_pad), mediumPads: whole(raw.medium_pads), smallPads: whole(raw.small_pads),
    isPlanetary: bool(raw.is_planetary), needsPermit: bool(raw.system_needs_permit), government: text(raw.government),
    marketUpdatedAt: timestampMs(raw.market_updated_at) === null ? null : raw.market_updated_at,
    marketUpdatedMs: timestampMs(raw.market_updated_at),
    stationUpdatedAt: timestampMs(raw.updated_at) === null ? null : raw.updated_at,
    sourceUrl: `https://spansh.co.uk/station/${id}`,
    market: [], invalidMarketEntries: 0, duplicateCommodities: 0,
  };
  if (station.arrivalDistanceLs !== null && station.arrivalDistanceLs < 0) station.arrivalDistanceLs = null;
  const entries = new Map(), duplicates = new Set();
  for (const entry of Array.isArray(raw.market) ? raw.market : []) {
    const commodity = text(entry?.commodity);
    if (!commodity) { station.invalidMarketEntries++; continue; }
    const key = commodity.normalize('NFKC').toLowerCase();
    if (entries.has(key)) { duplicates.add(key); continue; }
    const item = { commodity, key, category: text(entry.category), buyPrice: whole(entry.buy_price),
      sellPrice: whole(entry.sell_price), supply: whole(entry.supply), demand: whole(entry.demand) };
    if (item.buyPrice === null && item.sellPrice === null) station.invalidMarketEntries++;
    entries.set(key, item);
  }
  for (const key of duplicates) entries.delete(key); // Conflicting duplicate quotes are not a usable market.
  station.duplicateCommodities = duplicates.size;
  station.market = [...entries.values()];
  return station;
}
function newerRecord(a, b) {
  const am = timestampMs(a.market_updated_at) ?? -Infinity, bm = timestampMs(b.market_updated_at) ?? -Infinity;
  if (bm !== am) return bm > am ? b : a;
  return (timestampMs(b.updated_at) ?? -Infinity) >= (timestampMs(a.updated_at) ?? -Infinity) ? b : a;
}
export async function prepareMarkets(records, { signal } = {}) {
  if (!Array.isArray(records)) throw new ValidationError('Stations must be an array.');
  const unique = new Map();
  const diagnostics = { inputStations: records.length, invalidStations: 0, duplicateStations: 0,
    invalidMarketEntries: 0, duplicateCommodities: 0, unknownMarketTimestamps: 0,
    unknownCoordinates: 0, inaccessibleCarriers: 0, unknownStationTypes: 0 };
  for (let i = 0; i < records.length; i++) {
    if (i % 256 === 0) { checkAbort(signal); await yieldImmediate(); }
    const raw = records[i], id = marketId(raw?.market_id);
    if (!id) { diagnostics.invalidStations++; continue; }
    if (unique.has(id)) { diagnostics.duplicateStations++; unique.set(id, newerRecord(unique.get(id), raw)); }
    else unique.set(id, raw);
  }
  const stations = [], sellers = [], buyers = new Map();
  for (const raw of unique.values()) {
    if (stations.length % 256 === 0) { checkAbort(signal); await yieldImmediate(); }
    const station = normalizeStation(raw);
    stations.push(station);
    diagnostics.invalidMarketEntries += station.invalidMarketEntries;
    diagnostics.duplicateCommodities += station.duplicateCommodities;
    if (station.marketUpdatedMs === null) diagnostics.unknownMarketTimestamps++;
    if (station.coordinates === null) diagnostics.unknownCoordinates++;
    if (!station.type) { diagnostics.unknownStationTypes++; continue; }
    if (station.isCarrier && !station.publicDocking) { diagnostics.inaccessibleCarriers++; continue; }
    for (const item of station.market) {
      if (item.buyPrice > 0 && item.supply > 0) sellers.push({ station, item });
      // NPC demand is an economic indicator, not a finite player buy order.
      // An explicitly reported zero is usable in normal-ship mode; unknown is not.
      if (item.sellPrice > 0 && item.demand !== null && (station.isCarrier ? item.demand > 0 : item.demand >= 0)) {
        if (!buyers.has(item.key)) buyers.set(item.key, []);
        buyers.get(item.key).push({ station, item });
      }
    }
  }
  for (const entries of buyers.values()) entries.sort((a, b) => b.item.sellPrice - a.item.sellPrice || a.station.id.localeCompare(b.station.id));
  checkAbort(signal);
  return { stations, sellers, buyers, diagnostics };
}
function padSupport(station, required) {
  if (required === 'any') return true;
  if (station.hasLargePad === true) return true;
  if (required === 'L') return station.hasLargePad;
  if (station.mediumPads > 0) return true;
  if (required === 'M') return station.hasLargePad === false && station.mediumPads === 0 ? false : null;
  if (station.smallPads > 0) return true;
  return station.hasLargePad === false && station.mediumPads === 0 && station.smallPads === 0 ? false : null;
}
function knownPad(station) {
  if (station.hasLargePad === true) return 'L';
  if (station.mediumPads > 0) return 'M';
  if (station.smallPads > 0) return 'S';
  return null;
}
function eligible(station, filters, nowMs) {
  if (!station.type || (station.isCarrier && !station.publicDocking)) return false;
  if (filters.excludeCarrierAccess && isKnownCarrierAccessSystem(station.systemName)) return false;
  if (filters.maxMarketAgeHours !== null) {
    if (station.marketUpdatedMs === null || station.marketUpdatedMs > nowMs || nowMs - station.marketUpdatedMs > filters.maxMarketAgeHours * HOUR) return false;
  }
  const pad = padSupport(station, filters.requiredPad);
  if (pad === false || (pad === null && !filters.allowUnknownPad)) return false;
  if (!filters.allowPermitSystems && station.needsPermit !== false) return false;
  if (!filters.allowPlanetary && station.isPlanetary !== false) return false;
  return true;
}
function matchesMarketType(station, requested) {
  return requested === 'all' || (requested === 'carriers' ? station.isCarrier : !station.isCarrier);
}
function safeProduct(a, b) { const n = a * b; return Number.isSafeInteger(n) ? n : null; }
function stationView(station, nowMs) {
  const { market, invalidMarketEntries, duplicateCommodities, marketUpdatedMs, ...view } = station;
  return { ...view, coordinates: station.coordinates ? [...station.coordinates] : null, knownPad: knownPad(station),
    marketAgeHours: marketUpdatedMs === null ? null : (nowMs - marketUpdatedMs) / HOUR,
    timestampState: marketUpdatedMs === null ? 'unknown' : marketUpdatedMs > nowMs ? 'future' : 'known' };
}
function stationFlags(station, side, filters, nowMs) {
  const flags = [];
  if (isKnownCarrierAccessSystem(station.systemName)) flags.push(`${side}:carrier-transport-required`);
  if (station.needsPermit === true) flags.push(`${side}:permit-required`);
  if (station.needsPermit === null) flags.push(`${side}:permit-unknown`);
  if (station.isPlanetary === true) flags.push(`${side}:surface-landing`);
  if (station.isPlanetary === null) flags.push(`${side}:surface-status-unknown`);
  if (station.hasLargePad === false) flags.push(`${side}:no-large-pad`);
  if (knownPad(station) === null || padSupport(station, filters.requiredPad) === null) flags.push(`${side}:pad-unknown`);
  if (station.marketUpdatedMs === null) flags.push(`${side}:market-time-unknown`);
  else if (station.marketUpdatedMs > nowMs) flags.push(`${side}:future-market-time`);
  if (station.coordinates === null) flags.push(`${side}:coordinates-unknown`);
  if (station.isCarrier) flags.push(`${side}:carrier-can-move-or-restrict-access`);
  return flags;
}
export const REPORT_WARNINGS = Object.freeze([
  'Total lot profit is conditional on unchanged stock, demand, prices, access and successful completion; it is not guaranteed. Carrier buy orders cap tradable quantity; NPC station demand is not an order limit and prices may change.',
  'Do not add rows together. Opportunities can share buyer demand, a cargo hold and the same credits. No portfolio total is calculated.',
  'Distances are straight-line light-years, not plotted jump routes, travel times or fuel feasibility. Same-system distance can be 0 ly despite a long supercruise trip.',
  'The carrier-access filter excludes known exceptions (currently HIP 58832). It is not a jump-route feasibility check or a guarantee that every other system is reachable.',
  'Quoted prices, including possible bulk/demand effects, are not guaranteed. No bulk-price threshold or adjustment is invented.',
  'Potentially corrosive cargo is detected by a conservative name/category heuristic, not a complete hazards database. Cargo legality and permits held are not verified.',
]);
function orderNullable(a, b, descending = false) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return descending ? b - a : a - b;
}
const SORT_FIELDS = { closestSeller: ['playerToSellerLy', false], shortestRoute: ['sellerToBuyerLy', false],
  margin: ['marginPerTonne', true], loadProfit: ['profitPerLoad', true], stockProfit: ['fullStockProfit', true] };

function spatialCell(position, radius) {
  // A minimum cell size keeps tiny nonzero user limits numerically stable.
  return radius === 0 ? position.join(',') : position.map(value => Math.floor(value / Math.max(radius, 1))).join(',');
}
function neighboringCells(position, radius) {
  if (radius === 0) return [spatialCell(position, radius)];
  const [x, y, z] = position.map(value => Math.floor(value / Math.max(radius, 1)));
  const cells = new Set();
  for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) for (const dz of [-1, 0, 1]) cells.add(`${x + dx},${y + dy},${z + dz}`);
  return cells;
}
/** Preserve the globally price-sorted order inside each cell. Nearby searches
 * can stop at a lower price in each cell instead of scanning every remote buyer
 * for every commodity sold by every station. Only references are indexed. */
async function indexNearbyBuyers(database, filters, qualifies, signal) {
  const index = new Map();
  let visited = 0;
  for (const [commodity, buyers] of database.buyers) {
    const cells = new Map();
    for (const buyer of buyers) {
      if (++visited % 2048 === 0) { checkAbort(signal); await yieldImmediate(); }
      if (!buyer.station.coordinates || ((filters.requireFullStockDemand || buyer.station.isCarrier) && buyer.item.demand < filters.minStock) ||
        !matchesMarketType(buyer.station, filters.buyerType) || !qualifies(buyer.station)) continue;
      const key = spatialCell(buyer.station.coordinates, filters.maxRouteDistanceLy);
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(buyer);
    }
    if (cells.size) index.set(commodity, cells);
  }
  checkAbort(signal);
  return index;
}

/** Re-matches against all eligible buyers AFTER filters; changes do not require another network refresh. */
export async function analyzeMarkets(input, { settings = DEFAULT_SETTINGS, query = {}, context = null,
  now = Date.now(), signal, prepared = false } = {}) {
  const validated = validateSettings(settings);
  const options = queryOptions(query, validated);
  const { filters, list, sort } = options;
  const current = normalizeContext(context);
  const nowMs = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(nowMs)) throw new ValidationError('Analysis time must be valid.');
  if (!current.positionAvailable && (sort === 'closestSeller' || filters.maxPlayerDistanceLy !== null)) {
    throw new MarketError('LOCATION_UNAVAILABLE', 'Current StarPos is unknown. Closest-seller ranking and distance-from-me filtering are disabled.');
  }
  const database = prepared ? input : await prepareMarkets(input, { signal });
  const rows = [], eligibleCache = new Map();
  const qualifies = station => {
    if (!eligibleCache.has(station.id)) eligibleCache.set(station.id, eligible(station, filters, nowMs));
    return eligibleCache.get(station.id);
  };
  const nearbyBuyers = filters.maxRouteDistanceLy === null ? null : await indexNearbyBuyers(database, filters, qualifies, signal);
  let previousSellerPosition = null, previousCellKeys = null;
  let comparisons = 0, sellerCandidates = 0;
  for (const seller of database.sellers) {
    if (++comparisons % 512 === 0) { checkAbort(signal); await yieldImmediate(); }
    const { station, item } = seller;
    if (item.supply < filters.minStock || !matchesMarketType(station, filters.sellerType) || !qualifies(station)) continue;
    const corrosive = /thargoid|caustic|corrosive|unknown (?:artefact|artifact|probe|link)/i.test(`${item.commodity} ${item.category || ''}`);
    if (filters.excludePotentiallyCorrosive && corrosive) continue;
    const playerDistance = distanceLy(current.StarPos, station.coordinates);
    if (filters.maxPlayerDistanceLy !== null && (playerDistance === null || playerDistance > filters.maxPlayerDistanceLy)) continue;
    sellerCandidates++;
    let buyerLists;
    if (nearbyBuyers) {
      if (!station.coordinates) continue;
      if (previousSellerPosition !== station.coordinates) {
        previousSellerPosition = station.coordinates;
        previousCellKeys = neighboringCells(station.coordinates, filters.maxRouteDistanceLy);
      }
      const commodityCells = nearbyBuyers.get(item.key);
      if (!commodityCells) continue;
      buyerLists = [];
      for (const key of previousCellKeys) {
        const entries = commodityCells.get(key);
        if (entries) buyerLists.push(entries);
      }
    } else buyerLists = [database.buyers.get(item.key) || []];
    let best = null, bestDistance = null;
    for (const buyerList of buyerLists) for (const buyer of buyerList) {
      if (++comparisons % 512 === 0) { checkAbort(signal); await yieldImmediate(); }
      if (buyer.item.sellPrice <= item.buyPrice) break;
      if (best && buyer.item.sellPrice < best.item.sellPrice) break;
      if (buyer.station.id === station.id || !matchesMarketType(buyer.station, filters.buyerType) || !qualifies(buyer.station)) continue;
      if (filters.requireFullStockDemand ? buyer.item.demand < item.supply :
        buyer.station.isCarrier && Math.min(item.supply, buyer.item.demand) < filters.minStock) continue;
      const routeDistance = distanceLy(station.coordinates, buyer.station.coordinates);
      if (filters.maxRouteDistanceLy !== null && (routeDistance === null || routeDistance > filters.maxRouteDistanceLy)) continue;
      const freshnessTie = (buyer.station.marketUpdatedMs ?? -Infinity) - (best?.station.marketUpdatedMs ?? -Infinity);
      if (!best || buyer.item.sellPrice > best.item.sellPrice || orderNullable(routeDistance, bestDistance) < 0 ||
        (orderNullable(routeDistance, bestDistance) === 0 && freshnessTie > 0) ||
        (orderNullable(routeDistance, bestDistance) === 0 && (freshnessTie === 0 || Number.isNaN(freshnessTie)) && buyer.station.id.localeCompare(best.station.id) < 0)) {
        best = buyer; bestDistance = routeDistance;
      }
    }
    if (!best) continue;
    const stock = best.station.isCarrier ? Math.min(item.supply, best.item.demand) : item.supply;
    const demandLimited = stock < item.supply;
    const margin = best.item.sellPrice - item.buyPrice;
    const spendable = filters.credits === null ? null : Math.max(0, filters.credits - filters.creditReserve);
    const load = filters.cargoCapacity === null || spendable === null ? null :
      Math.min(stock, filters.cargoCapacity, Math.floor(spendable / item.buyPrice));
    if (list === 'affordable' && !(load > 0)) continue;
    const fullStockCost = safeProduct(item.buyPrice, stock), fullStockProfit = safeProduct(margin, stock);
    const flags = [...stationFlags(station, 'seller', filters, nowMs), ...stationFlags(best.station, 'buyer', filters, nowMs), 'bulk-price-unmodeled'];
    if (demandLimited) flags.push('buyer-demand-limits-lot');
    if (!filters.requireFullStockDemand && !best.station.isCarrier) flags.push('station-demand-not-order-limit');
    if (corrosive) flags.push('potentially-corrosive-cargo');
    if (fullStockCost === null || fullStockProfit === null) flags.push('numeric-overflow');
    if (load === null) flags.push('budget-or-capacity-unknown');
    else if (load === 0) flags.push('no-affordable-load');
    if (filters.credits !== null && filters.creditReserve > filters.credits) flags.push('reserve-exceeds-credits');
    rows.push({
      id: `${station.id}:${encodeURIComponent(item.key)}`, commodity: item.commodity, commodityKey: item.key,
      category: item.category, seller: stationView(station, nowMs), buyer: stationView(best.station, nowMs),
      buyPrice: item.buyPrice, sellPrice: best.item.sellPrice, stock, sellerStock: item.supply, buyerDemand: best.item.demand, demandLimited,
      marginPerTonne: margin, fullStockCost, fullStockProfit, fullStockProfitConditional: true,
      availableCredits: spendable, affordableCargoPerTrip: load,
      costPerLoad: load === null ? null : safeProduct(item.buyPrice, load),
      profitPerLoad: load === null ? null : safeProduct(margin, load),
      tripsNeeded: load > 0 ? Math.ceil(stock / load) : null,
      playerToSellerLy: playerDistance, sellerToBuyerLy: bestDistance,
      sharedBuyerDemandKey: `${best.station.id}:${encodeURIComponent(item.key)}`,
      loadToDemandFraction: load === null || best.item.demand === 0 ? null : load / best.item.demand,
      stockToDemandFraction: best.item.demand === 0 ? null : stock / best.item.demand,
      potentiallyCorrosive: corrosive, bulkPriceRisk: true, flags,
    });
  }
  checkAbort(signal);
  const [field, descending] = SORT_FIELDS[sort];
  rows.sort((a, b) => orderNullable(a[field], b[field], descending) ||
    (sort === 'stockProfit' ? orderNullable(a.sellerToBuyerLy, b.sellerToBuyerLy) : 0) ||
    b.marginPerTonne - a.marginPerTonne || a.id.localeCompare(b.id));
  return { rows, total: rows.length, list, sort, limit: options.limit, offset: options.offset,
    context: current, filters: Object.fromEntries(FILTER_KEYS.map(key => [key, filters[key]])),
    diagnostics: { ...database.diagnostics, sellerCandidates, comparisons },
    availableSorts: current.positionAvailable ? [...SORTS] : SORTS.filter(s => s !== 'closestSeller'),
    evaluatedAt: iso(nowMs), warnings: [...REPORT_WARNINGS] };
}

/** Always quote textual cells; neutralize formulas even behind leading whitespace/control characters. */
export function csvCell(value) {
  let cell = value === null || value === undefined ? '' : String(value);
  if (typeof value === 'string') {
    const dangerous = /^[\s\p{Cc}\p{Cf}]*[=+\-@]/u.test(cell.normalize('NFKC')) || /^[\t\r\n]/.test(cell);
    cell = cell.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    if (dangerous) cell = `'${cell}`;
  }
  return `"${cell.replaceAll('"', '""')}"`;
}
export function buildCsv(rows) {
  const columns = [
    ['Commodity', r => r.commodity], ['Seller', r => r.seller.displayName], ['Seller reported name', r => r.seller.name],
    ['Seller market ID', r => r.seller.id], ['Seller system', r => r.seller.systemName],
    ['Buyer', r => r.buyer.displayName], ['Buyer reported name', r => r.buyer.name],
    ['Buyer market ID', r => r.buyer.id], ['Buyer system', r => r.buyer.systemName],
    ['Buy price (Cr/t)', r => r.buyPrice], ['Sell price (Cr/t)', r => r.sellPrice], ['Margin (Cr/t)', r => r.marginPerTonne],
    ['Seller stock (t)', r => r.sellerStock ?? r.stock], ['Buyer demand (t)', r => r.buyerDemand],
    ['Tradable lot (t)', r => r.stock], ['Demand-limited lot', r => r.demandLimited],
    ['Lot cost (Cr)', r => r.fullStockCost], ['Conditional lot profit (Cr)', r => r.fullStockProfit],
    ['Affordable load (t)', r => r.affordableCargoPerTrip], ['Load cost (Cr)', r => r.costPerLoad],
    ['Quoted load profit (Cr)', r => r.profitPerLoad], ['Trips at initial affordable load', r => r.tripsNeeded],
    ['Player to seller (ly)', r => r.playerToSellerLy], ['Seller to buyer (ly)', r => r.sellerToBuyerLy],
    ['Seller arrival distance (ls)', r => r.seller.arrivalDistanceLs], ['Buyer arrival distance (ls)', r => r.buyer.arrivalDistanceLs],
    ['Seller market timestamp', r => r.seller.marketUpdatedAt], ['Seller market age (h)', r => r.seller.marketAgeHours],
    ['Buyer market timestamp', r => r.buyer.marketUpdatedAt], ['Buyer market age (h)', r => r.buyer.marketAgeHours],
    ['Seller station timestamp (NOT market)', r => r.seller.stationUpdatedAt], ['Buyer station timestamp (NOT market)', r => r.buyer.stationUpdatedAt],
    ['Seller pad (confirmed at least)', r => r.seller.knownPad], ['Buyer pad (confirmed at least)', r => r.buyer.knownPad],
    ['Seller permit', r => r.seller.needsPermit], ['Buyer permit', r => r.buyer.needsPermit],
    ['Seller surface', r => r.seller.isPlanetary], ['Buyer surface', r => r.buyer.isPlanetary],
    ['Potential corrosion (heuristic)', r => r.potentiallyCorrosive], ['Bulk pricing unmodeled', r => r.bulkPriceRisk],
    ['Shared buyer demand key (NOT additive)', r => r.sharedBuyerDemandKey], ['Warnings', r => r.flags.join('; ')],
    ['Seller source', r => r.seller.sourceUrl], ['Buyer source', r => r.buyer.sourceUrl],
  ];
  return '\uFEFF' + [columns.map(([label]) => csvCell(label)).join(','),
    ...rows.map(row => columns.map(([, getter]) => csvCell(getter(row))).join(','))].join('\r\n') + '\r\n';
}

function abortable(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  const reason = () => signal.reason instanceof Error ? signal.reason : abortError();
  if (signal.aborted) { Promise.resolve(promise).catch(() => {}); return Promise.reject(reason()); }
  return new Promise((resolvePromise, reject) => {
    const abort = () => { cleanup(); reject(reason()); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolvePromise(value); }, error => { cleanup(); reject(error); });
  });
}
function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : abortError());
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => { cleanup(); resolvePromise(); }, Math.max(0, ms));
    const abort = () => { clearTimeout(timer); cleanup(); reject(signal.reason instanceof Error ? signal.reason : abortError()); };
    const cleanup = () => signal?.removeEventListener('abort', abort);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
async function mapBounded(items, concurrency, fn) {
  const result = new Array(items.length);
  let cursor = 0, failure;
  async function worker() {
    while (cursor < items.length && !failure) {
      const index = cursor++;
      try { result[index] = await fn(items[index], index); }
      catch (error) { failure ||= error; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, worker));
  if (failure) throw failure;
  return result;
}
function retryAfterMs(value, nowMs) {
  if (!value) return 0;
  const seconds = finite(value);
  if (seconds !== null && seconds >= 0) return Math.min(seconds * 1_000, 7 * DAY);
  const time = Date.parse(value);
  return Number.isFinite(time) ? Math.max(0, Math.min(time - nowMs, 7 * DAY)) : 0;
}
async function limitedText(response, maximum, signal) {
  const stated = finite(response.headers?.get?.('content-length'));
  if (stated !== null && stated > maximum) {
    await response.body?.cancel?.().catch(() => {});
    throw new MarketError('RESPONSE_TOO_LARGE', `Response exceeds ${maximum} bytes.`);
  }
  if (!response.body?.getReader) {
    const value = await response.text();
    if (Buffer.byteLength(value) > maximum) throw new MarketError('RESPONSE_TOO_LARGE', `Response exceeds ${maximum} bytes.`);
    return value;
  }
  const reader = response.body.getReader();
  let length = 0;
  const chunks = [];
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) throw new MarketError('RESPONSE_TOO_LARGE', `Response exceeds ${maximum} bytes.`);
      chunks.push(Buffer.from(value));
    }
    if (signal.aborted) throw signal.reason;
    return Buffer.concat(chunks, length).toString('utf8');
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

function requestClient({ fetchImpl, settings, signal, progress, emit, now }) {
  let active = 0, startGate = Promise.resolve(), nextStart = 0, cooldownUntil = 0;
  const waiters = [];
  async function acquire() {
    checkAbort(signal);
    if (active < settings.concurrency) { active++; return; }
    await new Promise((resolvePromise, reject) => {
      const waiter = { resolve: () => { cleanup(); resolvePromise(); } };
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      const onAbort = () => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        cleanup(); reject(abortError());
      };
      waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  function release() {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve();
    else active--;
  }
  async function pace() {
    let unlock;
    const previous = startGate;
    startGate = new Promise(resolvePromise => { unlock = resolvePromise; });
    try {
      await abortable(previous, signal);
      for (;;) {
        checkAbort(signal);
        const delay = Math.max(nextStart, cooldownUntil) - performance.now();
        if (delay <= 0) break;
        progress.rateLimitWaitMs = Math.ceil(delay); emit();
        await sleep(delay, signal);
      }
      nextStart = performance.now() + settings.minRequestIntervalMs;
      progress.rateLimitWaitMs = 0;
    } finally { unlock(); }
  }
  return async function request(url, body) {
    for (let attempt = 0; ; attempt++) {
      checkAbort(signal);
      let acquired = false, retryDelay = 0;
      try {
        await acquire(); acquired = true;
        await pace();
        if (progress.requests >= settings.maxRequests) throw new CoverageError('The configured request budget was exhausted.', { reasons: ['request-budget-exhausted'] });
        progress.requests++; progress.activeRequests++; emit();
        const controller = new AbortController();
        const externalAbort = () => controller.abort(abortError());
        if (signal?.aborted) externalAbort();
        else signal?.addEventListener('abort', externalAbort, { once: true });
        const timeout = setTimeout(() => controller.abort(new MarketError('TIMEOUT', `Request timed out after ${settings.timeoutMs} ms.`)), settings.timeoutMs);
        try {
          if (controller.signal.aborted) throw controller.signal.reason;
          const operation = (async () => {
            const response = await fetchImpl(url, {
              method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: controller.signal,
              headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            if (!response || typeof response.status !== 'number') throw new MarketError('SCHEMA', 'fetchImpl returned an invalid Response.');
            const raw = await limitedText(response, settings.maxResponseBytes, controller.signal);
            if (response.status < 200 || response.status >= 300) {
              const retryMs = retryAfterMs(response.headers?.get?.('retry-after'), clockMs(now));
              if (retryMs) cooldownUntil = Math.max(cooldownUntil, performance.now() + retryMs);
              throw new MarketError('HTTP', `Spansh returned HTTP ${response.status}: ${raw.replace(/\s+/g, ' ').slice(0, 300)}`, {
                status: response.status, retryAfterMs: retryMs,
              });
            }
            try { return JSON.parse(raw); }
            catch { throw new MarketError('SCHEMA', 'Spansh returned non-JSON data.'); }
          })();
          return await abortable(operation, controller.signal);
        } finally {
          clearTimeout(timeout); signal?.removeEventListener('abort', externalAbort);
          progress.activeRequests--; emit();
        }
      } catch (original) {
        checkAbort(signal);
        const error = original instanceof MarketError ? original : new MarketError('NETWORK', `Network request failed: ${original?.message || original}`);
        const status = error.details?.status;
        const transient = error.code === 'NETWORK' || error.code === 'TIMEOUT' ||
          (error.code === 'HTTP' && [408, 425, 429, 500, 502, 503, 504].includes(status));
        // Do not hold a refresh open for hours, or retry earlier than a long Retry-After.
        if (!transient || attempt >= settings.maxRetries || (error.details?.retryAfterMs || 0) > 300_000) throw error;
        retryDelay = Math.max(error.details?.retryAfterMs || 0,
          Math.min(settings.retryMaxMs, settings.retryBaseMs * 2 ** attempt * (0.8 + Math.random() * 0.4)));
        progress.retries++; emit();
      } finally { if (acquired) release(); }
      await sleep(retryDelay, signal);
    }
  };
}

/**
 * A fresh rolling query every call. Oversize or inconsistent slices are bisected
 * with an overlapping boundary; station IDs are deduplicated. "Complete" means
 * reconciled against API counts, NOT an atomic snapshot of the game universe.
 */
export async function collectMarkets({ fetchImpl = globalThis.fetch, settings = DEFAULT_SETTINGS,
  now = Date.now, signal, onProgress = () => {} } = {}) {
  settings = validateSettings(settings);
  if (typeof fetchImpl !== 'function') throw new ValidationError('fetchImpl must be a function.');
  const end = Math.floor(clockMs(now) / 1_000) * 1_000;
  const start = Math.floor((end - settings.windowHours * HOUR) / 1_000) * 1_000;
  const window = { start: iso(start), end: iso(end) };
  const progress = { phase: 'collecting', requests: 0, pages: 0, queries: 0, splits: 0, retries: 0,
    stations: 0, activeRequests: 0, detailsCompleted: 0, detailsTotal: 0, rateLimitWaitMs: 0, window };
  const emit = () => onProgress(clone(progress));
  const request = requestClient({ fetchImpl, settings, signal, progress, emit, now });
  const collected = new Map();
  const leaves = [];
  let boundaryDuplicates = 0;
  const coverage = (complete, reasons = []) => ({ complete, window,
    method: 'count-reconciled-overlapping-time-slices', consistency: 'best-effort-live-pagination',
    queryResultCapGuard: settings.queryResultCap, requests: progress.requests, pages: progress.pages,
    queries: progress.queries, splits: progress.splits, uniqueStations: collected.size,
    boundaryDuplicates, leafSlices: clone(leaves), reasons,
  });
  async function page(lo, hi, index) {
    const data = await request(SEARCH_URL, { size: settings.pageSize, page: index,
      filters: { market_updated_at: { comparison: '<=>', value: [iso(lo), iso(hi)] } },
      sort: [{ market_updated_at: { direction: 'desc' } }],
    });
    progress.pages++; emit();
    if (!record(data) || whole(data.count) === null || !Array.isArray(data.results)) throw new MarketError('SCHEMA', 'Expected a station search response with count and results.');
    if (data.results.some(item => !record(item) || !marketId(item.market_id))) throw new MarketError('SCHEMA', 'Search results contain a missing or invalid market_id.');
    return { count: whole(data.count), results: data.results.map(compactStation) };
  }
  async function visit(lo, hi, depth) {
    checkAbort(signal);
    progress.queries++; emit();
    const first = await page(lo, hi, 0);
    const effectiveSize = Math.min(settings.pageSize, first.results.length || settings.pageSize);
    const pages = Math.max(1, Math.ceil(first.count / effectiveSize));
    const middle = Math.floor((lo + hi) / 2 / 1_000) * 1_000;
    const canSplit = depth < settings.maxSplitDepth && hi - lo > settings.minSliceMs && middle > lo && middle < hi;
    async function splitOrFail(reasons) {
      if (!canSplit) throw new CoverageError('Coverage could not be reconciled within the configured slice limits.', coverage(false, [{ start: iso(lo), end: iso(hi), count: first.count, reasons }]));
      progress.splits++; emit();
      // Sequential branches avoid unbounded recursive concurrency; page/detail requests are bounded separately.
      await visit(lo, middle, depth + 1);
      await visit(middle, hi, depth + 1);
    }
    if (first.count >= settings.queryResultCap || pages > settings.maxPagesPerSlice) {
      return splitOrFail([first.count >= settings.queryResultCap ? 'count-at-or-above-cap-guard' : 'page-budget-per-slice']);
    }
    let rest;
    try {
      rest = await mapBounded(Array.from({ length: pages - 1 }, (_, i) => i + 1), settings.concurrency, index => page(lo, hi, index));
    } catch (error) {
      if (error.code === 'HTTP' && [400, 416, 422].includes(error.details?.status)) return splitOrFail(['pagination-rejected']);
      throw error;
    }
    const batch = [first, ...rest], local = new Map(), reasons = [];
    if (batch.some(result => result.count !== first.count)) reasons.push('count-changed-during-pagination');
    for (const result of batch) for (const raw of result.results) {
      const id = marketId(raw.market_id), ms = timestampMs(raw.market_updated_at);
      if (ms !== null && (ms < lo || ms > hi)) reasons.push('timestamp-outside-query-window');
      if (local.has(id)) reasons.push('duplicate-id-within-page-sequence');
      local.set(id, local.has(id) ? newerRecord(local.get(id), raw) : raw);
    }
    if (local.size !== first.count) reasons.push('unique-count-does-not-match-declared-count');
    if (reasons.length) return splitOrFail([...new Set(reasons)]);
    for (const [id, raw] of local) {
      if (collected.has(id)) { boundaryDuplicates++; collected.set(id, newerRecord(collected.get(id), raw)); }
      else collected.set(id, raw);
      if (collected.size > settings.maxStations) throw new CoverageError('The configured station budget was exceeded.', coverage(false, ['station-budget-exhausted']));
    }
    leaves.push({ start: iso(lo), end: iso(hi), count: first.count, pages });
    progress.stations = collected.size; emit();
  }
  try {
    await visit(start, end, 0);
    const missing = [...collected.values()].filter(station => !Array.isArray(station.market));
    if (missing.length && !settings.hydrateMissingMarkets) throw new CoverageError('Search records omitted market arrays and detail hydration is disabled.', coverage(false, ['missing-market-arrays']));
    if (missing.length > settings.maxDetailRequests) throw new CoverageError('Detail hydration exceeds the configured detail request budget.', coverage(false, ['detail-budget-exhausted']));
    progress.phase = 'hydrating'; progress.detailsTotal = missing.length; emit();
    await mapBounded(missing, settings.concurrency, async station => {
      const id = marketId(station.market_id);
      const data = await request(`${DETAIL_URL}${id}`);
      if (!record(data?.record) || marketId(data.record.market_id) !== id || !Array.isArray(data.record.market)) throw new MarketError('SCHEMA', `Station detail ${id} must contain record with matching market_id and a market array.`);
      // Do not stamp a newly fetched quote with an older search record's timestamp.
      collected.set(id, compactStation(data.record));
      progress.detailsCompleted++; emit();
    });
    checkAbort(signal);
    return { stations: [...collected.values()], window, coverage: coverage(true), progress: clone(progress) };
  } catch (error) {
    checkAbort(signal);
    if (error instanceof CoverageError && !error.details?.window) error.details = coverage(false, error.details?.reasons || [error.message]);
    throw error;
  }
}

/** Same-directory temp + fsync + atomic rename. Never unlink the old target first. */
export async function atomicWriteJson(file, value, { signal } = {}) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  let handle;
  try {
    checkAbort(signal);
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value), 'utf8');
    await handle.sync();
    await handle.close(); handle = null;
    checkAbort(signal);
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, file); break; }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
        await sleep(20 * 2 ** attempt, signal);
      }
      checkAbort(signal);
    }
    // Directory fsync is unavailable on some Windows filesystems. The rename is already committed.
    try { const directory = await open(dirname(file), 'r'); try { await directory.sync(); } finally { await directory.close(); } } catch {}
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') { /* A failed cleanup must not delete the previous report. */ } });
  }
}
async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new MarketError('STORAGE', `Cannot read ${file}: ${error.message}`); }
}

const STATION_SNAPSHOT_FORMAT = 'stations-ndjson-v1';
const MAX_STATION_LINE_BYTES = 32 * 1024 * 1024;
const SNAPSHOT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function stationSnapshotPath(report, directory) {
  const snapshot = report?.stationSnapshot;
  if (!snapshot) return null;
  if (!SNAPSHOT_UUID.test(report.id) || snapshot.format !== STATION_SNAPSHOT_FORMAT ||
    snapshot.file !== `stations-${report.id}.ndjson` ||
    !Number.isSafeInteger(snapshot.count) || snapshot.count < 0) {
    throw new MarketError('STORAGE', 'Invalid station snapshot reference in report.json.');
  }
  return join(directory, snapshot.file);
}

/** Stream stations individually, then atomically publish the small manifest.
 * Readers always see a complete old or new snapshot. No whole-report JSON
 * string is constructed, and failed candidates never replace the old report.
 */
export async function atomicWriteReport(file, report, stations, { signal, previousReport,
  onCommit = () => {}, writeManifest = atomicWriteJson } = {}) {
  if (!SNAPSHOT_UUID.test(report?.id) || !Array.isArray(stations) || previousReport?.id === report.id) {
    throw new MarketError('STORAGE', 'A new UUID and station array are required for a report snapshot.');
  }
  const { stations: ignoredStations, opportunities: ignoredOpportunities, ...metadata } = report;
  const manifest = { ...metadata, stationSnapshot: { format: STATION_SNAPSHOT_FORMAT,
    file: `stations-${report.id}.ndjson`, count: stations.length } };
  const target = stationSnapshotPath(manifest, dirname(file));
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  let handle, candidatePublished = false, committed = false;
  try {
    checkAbort(signal);
    await mkdir(dirname(file), { recursive: true });
    try {
      await lstat(target);
      throw new MarketError('STORAGE', 'The candidate station snapshot already exists; refusing to replace it.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    handle = await open(temporary, 'wx', 0o600);
    for (const station of stations) {
      checkAbort(signal);
      const line = JSON.stringify(compactStation(station));
      if (Buffer.byteLength(line, 'utf8') > MAX_STATION_LINE_BYTES) throw new MarketError('STORAGE', 'A station snapshot record exceeds the safe line size.');
      await handle.writeFile(`${line}\n`, 'utf8');
    }
    await handle.sync(); await handle.close(); handle = null;
    checkAbort(signal);
    await rename(temporary, target); candidatePublished = true;
    checkAbort(signal);
    // Only the tiny manifest commit is non-cancellable.
    onCommit();
    await writeManifest(file, manifest); committed = true;
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    if (candidatePublished && !committed) await unlink(target).catch(() => {});
  }
  // Delete only the exact previous file owned by this valid report reference.
  // A cleanup failure must not turn an already committed report into a failure.
  try {
    const previous = stationSnapshotPath(previousReport, dirname(file));
    if (previous && previous !== target) await unlink(previous);
  } catch {}
  return manifest;
}

async function readStationSnapshot(file, expectedCount) {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let inputError;
  stream.on('error', error => { inputError = error; lines.close(); });
  const stations = [];
  try {
    for await (const line of lines) {
      if (!line || Buffer.byteLength(line, 'utf8') > MAX_STATION_LINE_BYTES) throw new MarketError('STORAGE', 'Invalid station snapshot line.');
      const value = JSON.parse(line);
      if (!record(value) || !marketId(value.market_id) || !Array.isArray(value.market)) throw new MarketError('STORAGE', 'Malformed station snapshot record.');
      stations.push(value);
      if (stations.length > expectedCount) throw new MarketError('STORAGE', 'Station snapshot record count exceeds its manifest.');
    }
    if (inputError) throw inputError;
    if (stations.length !== expectedCount) throw new MarketError('STORAGE', 'Station snapshot record count does not match its manifest.');
    return stations;
  } finally { lines.close(); stream.destroy(); }
}

export async function readMarketReport(file) {
  let report = await readJson(file);
  for (let attempt = 0; report !== null; attempt++) {
    if (report.schemaVersion !== SCHEMA_VERSION || timestampMs(report.collectedAt) === null ||
      report.coverage?.complete !== true || !text(report.id)) throw new MarketError('STORAGE', 'Unsupported or malformed report.json.');
    if (!report.stationSnapshot) {
      if (!Array.isArray(report.stations)) throw new MarketError('STORAGE', 'Report has no station snapshot.');
      return report; // Compatibility with the original single JSON report.
    }
    const source = stationSnapshotPath(report, dirname(file));
    try { return { ...report, stations: await readStationSnapshot(source, report.stationSnapshot.count) }; }
    catch (error) {
      // A read-only process may have read the old manifest just before the
      // writer committed and removed its old station file. Retry the new one.
      if (error.code === 'ENOENT' && attempt === 0) {
        const latest = await readJson(file);
        if (latest && latest.id !== report.id) { report = latest; continue; }
      }
      throw new MarketError('STORAGE', `Cannot load station snapshot: ${error.message}`);
    }
  }
  return null;
}
const EMPTY_SCHEDULE = { lastAttemptAt: null, lastOutcome: null, failureCount: 0, nextRetryAt: null };

/** Latest elapsed UTC deadline. A manual success also satisfies the elapsed deadline. */
export function nextDailyRun({ nowMs, lastSuccessAt, settings, nextRetryAt = null }) {
  if (!settings.dailyRefresh) return null;
  const date = new Date(nowMs);
  const today = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), settings.dailyUtcHour);
  const lastDue = today <= nowMs ? today : today - DAY;
  const success = timestampMs(lastSuccessAt);
  const due = success === null || success < lastDue ? nowMs : today > nowMs ? today : today + DAY;
  return Math.max(due, timestampMs(nextRetryAt) ?? -Infinity);
}

export class MarketService {
  /** timers is an optional scheduler-only clock seam for deterministic tests. */
  constructor({ root, fetchImpl = globalThis.fetch, now = Date.now, getContext = () => null,
    readOnly = false, timers = { setTimeout, clearTimeout }, defaultSettings = DEFAULT_SETTINGS } = {}) {
    if (typeof root !== 'string' || !root.trim()) throw new ValidationError('A scanner-specific storage root is required.');
    if (typeof fetchImpl !== 'function' || typeof now !== 'function' || typeof getContext !== 'function') throw new ValidationError('fetchImpl, now and getContext must be functions.');
    if (typeof readOnly !== 'boolean') throw new ValidationError('readOnly must be a boolean.');
    this._defaultSettings = validateSettings(defaultSettings);
    this.root = resolve(root);
    this._fetch = fetchImpl; this._now = now; this._getContext = getContext;
    this._readOnly = readOnly; this._timers = timers;
    this._stateFile = join(this.root, 'state.json');
    this._reportFile = join(this.root, 'report.json');
    this._lockFile = join(this.root, '.routepilot-markets.lock');
    this._state = { schemaVersion: SCHEMA_VERSION, settings: clone(this._defaultSettings), schedule: clone(EMPTY_SCHEDULE), lastAttempt: null };
    this._stateQueue = Promise.resolve(); this._snapshot = null; this._database = null;
    this._run = null; this._closed = false; this._schedulerStarted = false;
    this._timer = null; this._keepSchedulerAlive = false; this._lockToken = null;
    this._warnings = []; this._lifetime = new AbortController();
    this.ready = this._initialize();
    // A caller may create the service and only call refresh/status later.
    this.ready.catch(() => {});
  }
  _ensureOpen() { if (this._closed) throw new MarketError('CLOSED', 'The market service is closed.'); }
  _ensureWriter() { if (this._readOnly) throw new MarketError('READ_ONLY', 'This service was opened read-only.'); }
  async _acquireLock() {
    for (let attempt = 0; attempt < 2; attempt++) {
      let handle;
      try {
        handle = await open(this._lockFile, 'wx', 0o600);
        this._lockToken = randomUUID();
        await handle.writeFile(JSON.stringify({ pid: process.pid, token: this._lockToken, createdAt: iso(clockMs(this._now)) }));
        await handle.sync();
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let owner;
        try { owner = await readJson(this._lockFile); } catch { /* Fail closed on an incomplete/invalid lock. */ }
        if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1 || !text(owner?.token)) throw new MarketError('STORAGE_BUSY', 'Storage has an invalid or incomplete lock. Stop all scanner processes before removing the lock manually.');
        let alive = true;
        try { process.kill(owner.pid, 0); } catch (killError) { if (killError.code === 'ESRCH') alive = false; }
        if (alive) throw new MarketError('STORAGE_BUSY', `Scanner storage is already owned by process ${owner.pid}. Use read-only commands, the app HTTP API, or a separate root.`);
        const again = await readJson(this._lockFile);
        if (again?.token !== owner.token) throw new MarketError('STORAGE_BUSY', 'Storage ownership changed while recovering a stale lock.');
        await unlink(this._lockFile);
      } finally { if (handle) await handle.close().catch(() => {}); }
    }
    throw new MarketError('STORAGE_BUSY', 'Could not acquire scanner storage.');
  }
  async _releaseLock() {
    if (!this._lockToken) return;
    try {
      const lock = await readJson(this._lockFile);
      if (lock?.token === this._lockToken) await unlink(this._lockFile);
    } catch (error) { if (error.code !== 'ENOENT') this._warnings.push(`Lock cleanup failed: ${error.message}`); }
    this._lockToken = null;
  }
  async _initialize() {
    try {
      if (!this._readOnly) { await mkdir(this.root, { recursive: true }); await this._acquireLock(); }
      const saved = await readJson(this._stateFile);
      if (saved !== null) {
        if (saved.schemaVersion !== SCHEMA_VERSION || !record(saved.settings) || !record(saved.schedule)) throw new MarketError('STORAGE', 'Unsupported or malformed state.json. No existing state was overwritten.');
        this._state = { schemaVersion: SCHEMA_VERSION, settings: validateSettings(saved.settings, this._defaultSettings),
          schedule: { ...EMPTY_SCHEDULE, ...saved.schedule }, lastAttempt: saved.lastAttempt || null };
        const schedule = this._state.schedule;
        if (!Number.isSafeInteger(schedule.failureCount) || schedule.failureCount < 0 ||
          ![null, 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(schedule.lastOutcome) ||
          [schedule.lastAttemptAt, schedule.nextRetryAt].some(t => t !== null && timestampMs(t) === null)) {
          throw new MarketError('STORAGE', 'Invalid saved scheduler state. No existing state was overwritten.');
        }
      }
      try {
        const savedReport = await readMarketReport(this._reportFile);
        if (savedReport !== null) {
          this._database = await prepareMarkets(savedReport.stations);
          this._snapshot = this._reportMetadata(savedReport);
        }
      } catch (error) {
        this._warnings.push(`Saved report could not be loaded: ${error.message}. It is not treated as valid data; a successful refresh can replace it.`);
      }
      if (!this._readOnly && this._state.schedule.lastOutcome === 'running') {
        await this._mutateState(next => {
          next.schedule.lastOutcome = 'interrupted';
          next.schedule.failureCount++;
          next.schedule.nextRetryAt = iso(clockMs(this._now) + next.settings.schedulerRetryBaseMs);
          next.lastAttempt = { ...(next.lastAttempt || {}), outcome: 'interrupted',
            error: { code: 'INTERRUPTED', message: 'The previous process stopped during a refresh. The last committed report was retained.' } };
        });
      }
    } catch (error) { await this._releaseLock(); throw error; }
  }
  _reportMetadata(report) {
    const { stations, opportunities, analysisAtRefresh, ...metadata } = report;
    return metadata;
  }
  _mutateState(mutator) {
    const action = this._stateQueue.then(async () => {
      const next = clone(this._state);
      mutator(next);
      try { await atomicWriteJson(this._stateFile, next); }
      catch (error) { throw new MarketError('STORAGE', `State could not be saved: ${error.message}`); }
      this._state = next;
      return clone(next);
    });
    this._stateQueue = action.catch(() => {});
    return action;
  }
  async _context() {
    let timer;
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => this._getContext()),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Context provider timed out.')), 2_000); }),
      ]);
      return normalizeContext(value);
    } catch (error) {
      return { ...normalizeContext(null), warning: `Current position is unavailable: ${error.message}` };
    } finally { clearTimeout(timer); }
  }
  async status() {
    await this.ready;
    const context = await this._context();
    const run = this._run;
    const due = nextDailyRun({ nowMs: clockMs(this._now), lastSuccessAt: this._snapshot?.collectedAt,
      settings: this._state.settings, nextRetryAt: this._state.schedule.nextRetryAt });
    return clone({ schemaVersion: SCHEMA_VERSION, closed: this._closed, settings: this._state.settings,
      hasReport: this._snapshot !== null, report: this._snapshot, lastAttempt: this._state.lastAttempt,
      refresh: run ? { running: true, id: run.id, startedAt: run.startedAt,
        canCancel: run.canCancel && !run.controller.signal.aborted, ...run.progress } : { running: false, canCancel: false, phase: 'idle' },
      scheduler: { enabled: this._state.settings.dailyRefresh, started: this._schedulerStarted,
        nextRunAt: due === null ? null : iso(due), failureCount: this._state.schedule.failureCount,
        nextRetryAt: this._state.schedule.nextRetryAt, utcHour: this._state.settings.dailyUtcHour },
      context, availableSorts: context.positionAvailable ? [...SORTS] : SORTS.filter(sort => sort !== 'closestSeller'),
      warnings: [...this._warnings], storage: { root: this.root, readOnly: this._readOnly },
    });
  }
  async _analysis(query = {}) {
    await this.ready; this._ensureOpen();
    const context = await this._context();
    const database = this._database || { stations: [], sellers: [], buyers: new Map(), diagnostics: {} };
    const snapshot = this._snapshot;
    const analysis = await analyzeMarkets(database, { prepared: true, settings: clone(this._state.settings),
      query, context, now: clockMs(this._now), signal: this._lifetime.signal });
    return { ...analysis, report: clone(snapshot), hasReport: snapshot !== null,
      context: { ...analysis.context, warning: context.warning }, storageWarnings: [...this._warnings] };
  }
  async results(query = {}) {
    const analysis = await this._analysis(query);
    return { ...analysis, rows: analysis.rows.slice(analysis.offset, analysis.offset + analysis.limit),
      hasMore: analysis.offset + analysis.limit < analysis.total };
  }
  /** csv('all'|'affordable') or csv({...resultFilters}); exports all matching rows, never just one UI page. */
  async csv(list = 'all') {
    const query = typeof list === 'string' ? { list } : list;
    const analysis = await this._analysis(query);
    return buildCsv(analysis.rows);
  }
  async configure(patch) {
    await this.ready; this._ensureOpen(); this._ensureWriter();
    await this._mutateState(next => { next.settings = validateSettings(patch, next.settings); });
    this._armScheduler();
    return clone(this._state.settings);
  }
  /** Duplicate calls return the identical promise and do not enqueue another refresh. Operational failures resolve with an outcome. */
  refresh() {
    if (this._run) return this._run.promise;
    if (this._closed) return Promise.reject(new MarketError('CLOSED', 'The market service is closed.'));
    if (this._readOnly) return Promise.reject(new MarketError('READ_ONLY', 'This service was opened read-only.'));
    this._clearTimer();
    const run = { id: randomUUID(), controller: new AbortController(), canCancel: true,
      startedAt: iso(clockMs(this._now)), progress: { phase: 'initializing', requests: 0, pages: 0, stations: 0 } };
    this._run = run;
    run.promise = Promise.resolve().then(() => this._executeRefresh(run));
    return run.promise;
  }
  cancel() {
    const run = this._run;
    if (!run || !run.canCancel || run.controller.signal.aborted) return false;
    run.controller.abort(abortError()); run.progress.phase = 'cancelling';
    return true;
  }
  async _executeRefresh(run) {
    let outcome, committed = false;
    try {
      await this.ready; this._ensureOpen(); this._ensureWriter();
      await this._stateQueue;
      checkAbort(run.controller.signal);
      const runSettings = clone(this._state.settings);
      await this._mutateState(next => {
        next.schedule.lastAttemptAt = run.startedAt; next.schedule.lastOutcome = 'running';
        next.lastAttempt = { id: run.id, startedAt: run.startedAt, outcome: 'running' };
      });
      const collected = await collectMarkets({ fetchImpl: this._fetch, settings: runSettings,
        now: this._now, signal: run.controller.signal,
        onProgress: progress => { run.progress = { ...progress, phase: run.controller.signal.aborted ? 'cancelling' : progress.phase }; },
      });
      run.progress.phase = 'analyzing';
      const database = await prepareMarkets(collected.stations, { signal: run.controller.signal });
      const context = await this._context();
      // Collection can succeed while the player is absent. Location-dependent result requests still reject explicitly.
      const reference = await analyzeMarkets(database, { prepared: true, settings: runSettings,
        query: { maxPlayerDistanceLy: context.positionAvailable ? runSettings.maxPlayerDistanceLy : null,
          sort: !context.positionAvailable && runSettings.defaultSort === 'closestSeller' ? 'margin' : runSettings.defaultSort },
        context, now: clockMs(this._now), signal: run.controller.signal });
      checkAbort(run.controller.signal);
      const report = { schemaVersion: SCHEMA_VERSION, id: run.id,
        scanStartedAt: run.startedAt, collectedAt: iso(clockMs(this._now)),
        source: 'Spansh station market search', window: collected.window, coverage: collected.coverage,
        referenceOpportunityCount: reference.total, diagnostics: database.diagnostics,
        analysisAtRefresh: { evaluatedAt: reference.evaluatedAt, filters: reference.filters,
          context: reference.context, note: 'Reference only. Public results always recompute current ages, context, filters and budget.' } };
      run.progress.phase = 'saving';
      const manifest = await atomicWriteReport(this._reportFile, report, collected.stations, {
        signal: run.controller.signal, previousReport: this._snapshot,
        onCommit: () => { run.canCancel = false; run.progress.phase = 'committing'; },
      });
      this._database = database; this._snapshot = this._reportMetadata(manifest); committed = true;
      outcome = { outcome: 'succeeded', id: run.id, report: clone(this._snapshot) };
      try {
        await this._mutateState(next => {
          next.schedule = { lastAttemptAt: run.startedAt, lastOutcome: 'succeeded', failureCount: 0, nextRetryAt: null };
          next.lastAttempt = { id: run.id, startedAt: run.startedAt, completedAt: report.collectedAt,
            outcome: 'succeeded', coverage: collected.coverage };
        });
      } catch (error) {
        // The report rename succeeded. Do not call this a failed refresh or roll back good market data.
        const warning = `Report committed, but scheduler bookkeeping failed: ${error.message}`;
        this._warnings.push(warning); outcome.warning = warning;
        this._state.schedule = { lastAttemptAt: run.startedAt, lastOutcome: 'succeeded', failureCount: 0, nextRetryAt: null };
        this._state.lastAttempt = { id: run.id, startedAt: run.startedAt, completedAt: report.collectedAt, outcome: 'succeeded', warning };
      }
    } catch (error) {
      const cancelled = run.controller.signal.aborted && !committed;
      const info = errorInfo(cancelled ? abortError() : error);
      outcome = { outcome: cancelled ? 'cancelled' : 'failed', id: run.id, error: info,
        retainedReportId: this._snapshot?.id || null };
      // Initialization/storage ownership errors must never write another process's state.
      if (this._lockToken && !this._readOnly) {
        try {
          await this._mutateState(next => {
            const failureCount = cancelled ? next.schedule.failureCount : next.schedule.failureCount + 1;
            const delay = cancelled ? next.settings.cancellationBackoffMs : Math.max(
              Math.min(next.settings.schedulerRetryMaxMs, next.settings.schedulerRetryBaseMs * 2 ** Math.min(failureCount - 1, 20)),
              error?.details?.retryAfterMs || 0);
            next.schedule = { lastAttemptAt: run.startedAt, lastOutcome: outcome.outcome,
              failureCount, nextRetryAt: iso(clockMs(this._now) + delay) };
            next.lastAttempt = { id: run.id, startedAt: run.startedAt, completedAt: iso(clockMs(this._now)),
              outcome: outcome.outcome, error: info, progress: clone(run.progress) };
          });
        } catch (saveError) {
          const warning = `Refresh outcome could not be persisted: ${saveError.message}`;
          this._warnings.push(warning); outcome.warning = warning;
          // Also suppress an in-memory retry storm when the disk is unavailable.
          this._state.schedule.nextRetryAt = iso(clockMs(this._now) + this._state.settings.schedulerRetryBaseMs);
          this._state.lastAttempt = { id: run.id, outcome: outcome.outcome, error: info, warning };
        }
      }
    } finally {
      if (this._run === run) this._run = null;
      this._armScheduler();
    }
    return outcome;
  }
  _clearTimer() {
    if (this._timer !== null) this._timers.clearTimeout(this._timer);
    this._timer = null;
  }
  _armScheduler() {
    this._clearTimer();
    if (this._closed || this._readOnly || !this._schedulerStarted || this._run || !this._state.settings.dailyRefresh) return;
    const nowMs = clockMs(this._now);
    const due = nextDailyRun({ nowMs, lastSuccessAt: this._snapshot?.collectedAt,
      settings: this._state.settings, nextRetryAt: this._state.schedule.nextRetryAt });
    this._timer = this._timers.setTimeout(() => {
      this._timer = null;
      if (this._closed || !this._state.settings.dailyRefresh) return;
      // Recalculate after suspend/resume or a wall-clock change instead of replaying missed days.
      const current = clockMs(this._now);
      const next = nextDailyRun({ nowMs: current, lastSuccessAt: this._snapshot?.collectedAt,
        settings: this._state.settings, nextRetryAt: this._state.schedule.nextRetryAt });
      if (next > current) { this._armScheduler(); return; }
      this.refresh().catch(error => { this._warnings.push(`Scheduler stopped: ${error.message}`); });
    }, Math.max(0, Math.min(2_147_483_647, due - nowMs)));
    if (!this._keepSchedulerAlive) this._timer?.unref?.();
  }
  async startScheduler({ keepAlive = false } = {}) {
    await this.ready; this._ensureOpen(); this._ensureWriter();
    this._schedulerStarted = true; this._keepSchedulerAlive = keepAlive;
    this._armScheduler();
    return this.status();
  }
  close() {
    if (this._closePromise) return this._closePromise;
    this._closed = true; this._schedulerStarted = false; this._clearTimer();
    this._lifetime.abort(new MarketError('CLOSED', 'The market service is closed.'));
    this.cancel();
    this._closePromise = (async () => {
      await this.ready.catch(() => {});
      if (this._run) await this._run.promise.catch(() => {});
      await this._stateQueue;
      await this._releaseLock();
    })();
    return this._closePromise;
  }
}
