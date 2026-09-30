/** Known exceptions, not a galaxy-wide route or jump-range feasibility check.
 * HIP 58832 (Rackham's Peak) requires fleet-carrier transport to access.
 * Source: https://pilotstradenetwork.com/booze-cruise/
 */
export function normalizedSystem(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toUpperCase() : '';
}

const CARRIER_ACCESS_SYSTEMS = new Set(['HIP 58832']);

export function isKnownCarrierAccessSystem(systemName) {
  return CARRIER_ACCESS_SYSTEMS.has(normalizedSystem(systemName));
}
