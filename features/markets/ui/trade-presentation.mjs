/** Presentation only: distances remain system-centre straight-line distances. */
import { normalizedSystem, isKnownCarrierAccessSystem } from '../access-rules.mjs';

export function sameSystem(first, second) {
  const name = normalizedSystem(first);
  return Boolean(name && name === normalizedSystem(second));
}

export function routeDistanceLabel(fromSystem, toSystem, distanceLy, { player = false } = {}) {
  if (sameSystem(fromSystem, toSystem)) return player ? 'In your system' : 'Same system';
  if (typeof distanceLy !== 'number' || !Number.isFinite(distanceLy) || distanceLy < 0) return 'Distance unknown';
  // Coordinates can coincide without proving that station records share a system.
  if (distanceLy === 0) return '0 ly · check system names';
  if (distanceLy < 0.01) return '<0.01 ly';
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(distanceLy)} ly`;
}

export const RACKHAMS_ACCESS_SOURCE = Object.freeze({
  title: 'Pilots Trade Network: Booze Cruise guide',
  url: 'https://pilotstradenetwork.com/booze-cruise/',
  checkedAt: '2026-09-29',
});

/** Facts that materially change whether the user can carry out a displayed trade. */
export function tradeAccessWarnings(row, requiredPad = 'any') {
  const warnings = [];
  if ([row?.seller, row?.buyer].some(station => isKnownCarrierAccessSystem(station?.systemName))) {
    warnings.push({
      code: 'rackhams-carrier-access',
      label: 'Fleet carrier access',
      detail: 'Reaching HIP 58832 requires a fleet carrier ride. A short trade leg does not make this system reachable in a normal ship.',
      severity: 'warning',
      sourceUrl: RACKHAMS_ACCESS_SOURCE.url,
    });
  }
  for (const side of ['seller', 'buyer']) {
    const station = row?.[side];
    if (!station) continue;
    const subject = side === 'buyer' ? 'Buyer' : 'Seller';
    const stationName = station.displayName || station.name || subject;
    if (station.needsPermit === true) warnings.push({
      code: `${side}:permit-required`,
      label: `${subject}: permit required`,
      detail: `${stationName} is in a permit system. The scanner cannot verify whether you hold that permit.`,
      severity: 'warning',
    });
    if (station.isPlanetary === true) warnings.push({
      code: `${side}:surface-landing`,
      label: `${subject}: surface landing`,
      detail: `${stationName} requires a planetary surface landing.`,
      severity: 'warning',
    });
    const pad = station.knownPad;
    const noLarge = station.hasLargePad === false;
    const smallOnly = noLarge && station.mediumPads === 0 && pad === 'S';
    const mediumMaximum = noLarge && pad === 'M';
    const largeUnknown = station.hasLargePad !== true && station.hasLargePad !== false;
    if (!noLarge && !(largeUnknown && (pad === 'M' || pad === 'S'))) continue;
    const blocked = (requiredPad === 'L' && noLarge) || (requiredPad === 'M' && smallOnly);
    const capability = smallOnly ? 'small ships only' : mediumMaximum ? 'medium ships or smaller' : noLarge ? 'no large pad' : `${pad === 'M' ? 'medium' : 'small'} pad confirmed; larger pads unknown`;
    const detail = smallOnly ? 'has small pads only' : mediumMaximum ? 'has a maximum medium landing pad' : noLarge ? 'has no large landing pad; its maximum supported ship size is not confirmed' : `has a confirmed ${pad === 'M' ? 'medium' : 'small'} pad, but larger-pad availability is unknown`;
    warnings.push({
      code: `${side}:limited-pad`,
      label: blocked ? `${subject}: ship cannot dock` : `${subject}: ${capability}`,
      detail: `${stationName} ${detail}. ${blocked ? 'Change ship before taking this trade.' : 'Check your ship size before taking this trade.'}`,
      severity: blocked ? 'danger' : 'warning',
    });
  }
  return warnings;
}
