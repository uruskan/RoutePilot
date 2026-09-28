import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelemetryReader } from '../server/telemetry.mjs';

const at = '2026-09-28T20:00:00Z';
const nodes = [
  { StarSystem: 'A', SystemAddress: 1, StarClass: 'K', StarPos: [0, 0, 0] },
  { StarSystem: 'B', SystemAddress: 2, StarClass: 'M', StarPos: [3, 4, 0] },
  { StarSystem: 'C', SystemAddress: 3, StarClass: 'F', StarPos: [3, 4, 12] },
];
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'routepilot-telemetry-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const journal = path.join(directory, 'Journal.fixture.log');
  const write = (name, value) => fs.writeFileSync(path.join(directory, name), JSON.stringify(value));
  const append = (event) => fs.appendFileSync(journal, JSON.stringify({ timestamp: at, ...event }) + '\n');
  append({ event: 'LoadGame', Ship: 'Mandalay', FuelLevel: 20, FuelCapacity: 16 });
  append({ event: 'Loadout', Ship: 'mandalay', FuelCapacity: { Main: 32, Reserve: 0.5 }, HullHealth: 0.99 });
  append({ event: 'Location', StarSystem: 'A', SystemAddress: 1 });
  append({ event: 'NavRoute' });
  write('Status.json', { timestamp: at, Flags: (1 << 24) | 16, GuiFocus: 0, Fuel: { FuelMain: 25 } });
  write('NavRoute.json', { timestamp: at, event: 'NavRoute', Route: nodes });
  return { directory, journal, append, write, reader: new TelemetryReader({ journalDir: directory }) };
}

test('real route math, actual Loadout tank and old stationary status stay eligible', (t) => {
  const { reader } = fixture(t);
  const snapshot = reader.snapshot();
  assert.equal(snapshot.telemetry.fuelCapacity, 32);
  assert.equal(snapshot.telemetry.fuel, 25);
  assert.equal(snapshot.telemetry.hull, 99);
  assert.equal(snapshot.telemetry.ship, 'Mandalay');
  assert.equal(snapshot.route.remaining, 2);
  assert.equal(snapshot.route.distanceRemaining, 17);
  assert.equal(snapshot.route.destination, 'C');
  assert.ok(snapshot.checks.every((check) => check.ok));
});

test('incremental FSDJump updates progress; stale FSDTarget cannot revive final arrival', (t) => {
  const { reader, append } = fixture(t);
  reader.snapshot();
  append({ event: 'FSDJump', StarSystem: 'B', SystemAddress: 2 });
  assert.equal(reader.snapshot().route.completed, 1);
  append({ event: 'FSDTarget', Name: 'C', RemainingJumpsInRoute: 1 });
  append({ event: 'FSDJump', StarSystem: 'C', SystemAddress: 3 });
  append({ event: 'FSDTarget', Name: 'C', RemainingJumpsInRoute: 1 });
  const route = reader.snapshot().route;
  assert.equal(route.available, false);
  assert.equal(route.remaining, 0);
  assert.equal(route.completed, 2);
});

test('NavRouteClear supersedes stale file and FSDTarget; newer route reactivates', (t) => {
  const { reader, append, write } = fixture(t);
  reader.snapshot();
  append({ event: 'NavRouteClear', timestamp: '2026-09-28T20:01:00Z' });
  append({ event: 'FSDTarget', Name: 'B', RemainingJumpsInRoute: 2 });
  assert.equal(reader.snapshot().route.available, false);
  assert.equal(reader.snapshot().route.remaining, 0);
  write('NavRoute.json', { timestamp: '2026-09-28T20:02:00Z', event: 'NavRoute', Route: nodes });
  assert.equal(reader.snapshot().route.available, true);
});

test('route replacement event cannot accidentally reuse old route while file updates', (t) => {
  const { reader, append } = fixture(t);
  reader.snapshot();
  append({ event: 'NavRoute', timestamp: '2026-09-28T20:05:00Z' });
  assert.equal(reader.snapshot().route.available, false);
});

test('on-foot and SRV override a stray main-ship bit; docked/landed/panels block', (t) => {
  const { reader, write } = fixture(t);
  for (const [Flags, Flags2, GuiFocus, blocked] of [
    [(1 << 24) | 16, 1, 0, 'ship'], [(1 << 24) | (1 << 26) | 16, 0, 0, 'ship'],
    [(1 << 24) | 16 | 1, 0, 0, 'flight'], [(1 << 24) | 16 | 2, 0, 0, 'flight'],
    [(1 << 24) | 16, 0, 6, 'cockpit'],
  ]) {
    write('Status.json', { timestamp: at, Flags, Flags2, GuiFocus });
    assert.equal(reader.snapshot().checks.find((check) => check.id === blocked).ok, false);
  }
});

test('partial UTF-8 line is buffered exactly once and missing data stays null', (t) => {
  const { reader, journal } = fixture(t);
  reader.snapshot();
  const event = Buffer.from(JSON.stringify({ event: 'FSDJump', StarSystem: 'Örnek', SystemAddress: 9 }) + '\n');
  const split = event.indexOf(Buffer.from('Ö')) + 1;
  fs.appendFileSync(journal, event.subarray(0, split));
  assert.equal(reader.snapshot().telemetry.system, 'A');
  fs.appendFileSync(journal, event.subarray(split));
  assert.equal(reader.snapshot().telemetry.system, 'Örnek');
  const empty = new TelemetryReader({ journalDir: path.join(path.dirname(journal), 'missing') }).snapshot();
  assert.equal(empty.telemetry.fuel, null);
  assert.equal(empty.telemetry.fuelCapacity, null);
  assert.equal(empty.telemetry.guiFocus, null);
  assert.equal(empty.route.remaining, null);
});

test('shutdown blocks old intact cockpit state, malformed status fails closed', (t) => {
  const { reader, append, directory } = fixture(t);
  append({ event: 'Shutdown' });
  assert.equal(reader.snapshot().checks.find((check) => check.id === 'journal').ok, false);
  fs.writeFileSync(path.join(directory, 'Status.json'), '{');
  assert.equal(reader.snapshot().checks.find((check) => check.id === 'status').ok, false);
});

test('a ship change cannot carry the old tank capacity; SRV load cannot replace ship fuel', (t) => {
  const { reader, append, write } = fixture(t);
  reader.snapshot();
  write('Status.json', { timestamp: at, Flags: 1 << 26, GuiFocus: 0 });
  append({ event: 'LoadGame', Ship: 'TestBuggy', FuelLevel: 0.5 });
  assert.equal(reader.snapshot().telemetry.fuel, 20);
  append({ event: 'LoadGame', Ship: 'Anaconda' });
  const state = reader.snapshot().telemetry;
  assert.equal(state.ship, 'Anaconda');
  assert.equal(state.fuelCapacity, null);
  assert.equal(state.fuel, null);
  assert.equal(state.hull, null);
});
