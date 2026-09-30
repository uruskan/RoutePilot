// Queries from carrier-trades.xlsx (2026-09-29). Position always comes from the
// live journal; these presets contain no historical system or coordinates.
const common = {
  windowHours: 192, defaultSort: 'stockProfit', maxPlayerDistanceLy: null,
  requiredPad: 'any', allowUnknownPad: false, allowPermitSystems: true,
  allowPlanetary: true, excludePotentiallyCorrosive: false,
  sellerType: 'carriers', buyerType: 'all', requireFullStockDemand: true,
};

export const SPREADSHEET_PRESETS = Object.freeze({
  nearby: Object.freeze({
    label: 'Nearby trades (spreadsheet)',
    description: 'At least 100 t; both markets updated within 48 hours; buyer within 150 ly of the seller. Ranked by full-stock profit; buyer demand covers all stock.',
    settings: Object.freeze({ ...common, minStock: 100, maxMarketAgeHours: 48, maxRouteDistanceLy: 150 }),
  }),
  highestBuyers: Object.freeze({
    label: 'Highest buyers (spreadsheet)',
    description: 'Highest qualifying buyer for each carrier lot; markets up to 8 days old; unrestricted distance and stock from 1 t. Ranked by full-stock profit; buyer demand covers all stock.',
    settings: Object.freeze({ ...common, minStock: 1, maxMarketAgeHours: 192, maxRouteDistanceLy: null }),
  }),
});

// An ordinary ship's short trading runs, not the spreadsheet's whole-carrier lots.
export const NEAR_ME_PRESET = Object.freeze({
  label: 'Near me',
  description: 'Stations and public carriers within 200 ly of you; trade leg up to 50 ly; quotes up to 24 hours old; at least 100 t tradable. Ranked by profit per load.',
  settings: Object.freeze({ windowHours: 192, defaultSort: 'loadProfit',
    maxPlayerDistanceLy: 200, maxRouteDistanceLy: 50, maxMarketAgeHours: 24, minStock: 100,
    sellerType: 'all', buyerType: 'all', requireFullStockDemand: false, excludeCarrierAccess: true }),
});

// Original blue worksheet inputs: editable planning assumptions, not live
// journal balances or a cargo upgrade recommendation. Presets preserve edits.
export const SPREADSHEET_DEFAULT_SETTINGS = Object.freeze({
  ...SPREADSHEET_PRESETS.nearby.settings,
  cargoCapacity: 16, credits: 220_000_000, creditReserve: 20_000_000,
});
