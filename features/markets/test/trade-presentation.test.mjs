import test from 'node:test';
import assert from 'node:assert/strict';
import { sameSystem, routeDistanceLabel, tradeAccessWarnings } from '../ui/trade-presentation.mjs';

test('same-system labels identify both route and player contexts without claiming arrival', () => {
  assert.equal(sameSystem(' HIP  58832 ', 'hip 58832'), true);
  assert.equal(routeDistanceLabel(' HIP  58832 ', 'HIP 58832', 0), 'Same system');
  assert.equal(routeDistanceLabel('HIP 58832', 'HIP 58832', 0, { player: true }), 'In your system');
  assert.equal(routeDistanceLabel('HIP 58832', 'HIP 58832', null), 'Same system');
});

test('coincident coordinates do not falsely identify different or missing system names', () => {
  assert.equal(sameSystem('', ''), false);
  assert.equal(sameSystem(null, undefined), false);
  assert.equal(routeDistanceLabel('Sol', 'Achenar', 0), '0 ly · check system names');
  assert.equal(routeDistanceLabel(null, null, 0), '0 ly · check system names');
});

test('unknown or malformed distances are not rendered as zero', () => {
  for (const value of [null, undefined, NaN, Infinity, -1, '0']) {
    assert.equal(routeDistanceLabel('Sol', 'Achenar', value), 'Distance unknown');
  }
});

test('nonzero distances below displayed precision stay visibly nonzero', () => {
  assert.equal(routeDistanceLabel('Sol', 'Achenar', 0.001), '<0.01 ly');
  assert.equal(routeDistanceLabel('Sol', 'Achenar', 0.01), '0.01 ly');
  assert.equal(routeDistanceLabel('Sol', 'Achenar', 94.71234), '94.71 ly');
});

test('Rackhams access and medium pad restrictions remain prominent with any ship filter', () => {
  const row = {
    seller: { systemName: 'HIP 58832', knownPad: 'L', hasLargePad: true },
    buyer: { displayName: "Rackham's Peak", systemName: 'HIP 58832', knownPad: 'M', hasLargePad: false },
  };
  const warnings = tradeAccessWarnings(row);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0].detail, /requires a fleet carrier ride/);
  assert.equal(warnings[0].sourceUrl, 'https://pilotstradenetwork.com/booze-cruise/');
  assert.match(warnings[1].label, /medium ships or smaller/);
  assert.equal(tradeAccessWarnings(row, 'L')[1].severity, 'danger');
  assert.match(tradeAccessWarnings(row, 'L')[1].label, /cannot dock/);
});

test('small pad restriction blocks a medium ship, and no-large is still flagged without a known size', () => {
  assert.equal(tradeAccessWarnings({ seller: { knownPad: 'S', hasLargePad: false, mediumPads: 0 } }, 'M')[0].severity, 'danger');
  assert.match(tradeAccessWarnings({ buyer: { hasLargePad: false } })[0].label, /no large pad/);
  assert.deepEqual(tradeAccessWarnings({ buyer: { hasLargePad: true, knownPad: 'L' } }, 'L'), []);
  assert.deepEqual(tradeAccessWarnings({ buyer: {} }), []);
});

test('confirmed smaller pads do not imply that larger pads are unavailable', () => {
  for (const pad of ['S', 'M']) {
    const warning = tradeAccessWarnings({ buyer: { knownPad: pad, hasLargePad: null } }, 'L')[0];
    assert.equal(warning.severity, 'warning');
    assert.match(warning.label, /larger pads unknown/);
    assert.doesNotMatch(warning.label, /cannot dock|ships only|ships or smaller/);
    assert.doesNotMatch(warning.detail, /maximum|has no large/);
  }
  const uncertainMedium = tradeAccessWarnings({ buyer: { knownPad: 'S', hasLargePad: false, mediumPads: null } }, 'M')[0];
  assert.equal(uncertainMedium.severity, 'warning');
  assert.match(uncertainMedium.label, /no large pad/);
  assert.doesNotMatch(uncertainMedium.label, /cannot dock|small ships only/);
});

test('confirmed permit and surface requirements stay visible without inventing unknown restrictions', () => {
  const warnings = tradeAccessWarnings({
    seller: { displayName: 'Seller test', needsPermit: true, isPlanetary: false, hasLargePad: true },
    buyer: { displayName: 'Buyer test', needsPermit: false, isPlanetary: true, hasLargePad: true },
  });
  assert.deepEqual(warnings.map(warning => warning.code), ['seller:permit-required', 'buyer:surface-landing']);
  assert.match(warnings[0].detail, /cannot verify whether you hold that permit/);
  assert.match(warnings[1].detail, /requires a planetary surface landing/);
  assert.deepEqual(tradeAccessWarnings({ buyer: { needsPermit: null, isPlanetary: null } }), []);
});

test('unrelated systems do not inherit Rackhams access rules', () => {
  assert.deepEqual(tradeAccessWarnings({ seller: { systemName: 'HIP 588320' } }), []);
  assert.deepEqual(tradeAccessWarnings(null), []);
});
