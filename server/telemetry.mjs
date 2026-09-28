import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const FLAGS = { docked: 1, landed: 2, supercruise: 16, srv: 1 << 26, main: 1 << 24 };
const number = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const positive = (value) => number(value) !== null && value > 0 ? value : null;
const text = (value) => typeof value === 'string' && value.trim() ? value : null;
const stamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const sameName = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toUpperCase() === b.toUpperCase();
const validPosition = (value) => Array.isArray(value) && value.length === 3 && value.every((item) => number(item) !== null);
const shipNames = { mandalay: 'Mandalay', krait_mkii: 'Krait Mk II', krait_light: 'Krait Phantom',
  anaconda: 'Anaconda', asp: 'Asp Explorer', diamondbackxl: 'Diamondback Explorer', python: 'Python' };

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { return null; }
}

/** Independent journal observer. Never imports or starts the flight engine. */
export class TelemetryReader {
  constructor({ journalDir = path.join(os.homedir(), 'Saved Games', 'Frontier Developments', 'Elite Dangerous') } = {}) {
    this.journalDir = journalDir;
    this.file = null;
    this.offset = 0;
    this.tail = '';
    this.journalSeen = false;
    this.lastEvent = null;
    this.sessionActive = null;
    this.state = { system: null, systemAddress: null, ship: null, fuel: null, fuelCapacity: null, hull: null };
    this.routeEvent = { kind: null, time: null };
    this.routeData = null;
    this.lastStatus = null;
    this.statusValid = false;
  }

  processEvent(event) {
    if (!event || typeof event !== 'object' || !text(event.event)) return;
    this.journalSeen = true;
    this.lastEvent = text(event.timestamp) ?? this.lastEvent;
    if (event.event === 'LoadGame') this.sessionActive = true;
    if (event.event === 'Shutdown') this.sessionActive = false;
    if (['Location', 'FSDJump', 'CarrierJump'].includes(event.event)) {
      this.state.system = text(event.StarSystem) ?? this.state.system;
      this.state.systemAddress = number(event.SystemAddress);
    }
    if (event.event === 'Loadout' && text(event.Ship) && !['testbuggy', 'suit'].includes(event.Ship.toLowerCase())) {
      this.state.ship = shipNames[event.Ship.toLowerCase()] ?? event.Ship;
      this.state.fuelCapacity = positive(event.FuelCapacity?.Main);
      const health = number(event.HullHealth);
      if (health !== null && health >= 0 && health <= 1) this.state.hull = health * 100;
    }
    if (event.event === 'LoadGame' && text(event.Ship) && event.Ship.toLowerCase() !== 'testbuggy') {
      const ship = shipNames[event.Ship.toLowerCase()] ?? event.Ship;
      if (this.state.ship !== ship) { this.state.fuelCapacity = null; this.state.hull = null; this.state.fuel = null; }
      this.state.ship = ship;
      this.state.fuelCapacity = positive(event.FuelCapacity?.Main ?? event.FuelCapacity) ?? this.state.fuelCapacity;
    }
    if (!(event.event === 'LoadGame' && event.Ship?.toLowerCase() === 'testbuggy')
      && Object.hasOwn(event, 'FuelLevel') && number(event.FuelLevel) !== null && event.FuelLevel >= 0) {
      this.state.fuel = event.FuelLevel;
    }
    if (event.event === 'ReservoirReplenished' && number(event.FuelMain) !== null && event.FuelMain >= 0) this.state.fuel = event.FuelMain;
    if (event.event === 'FuelScoop' && number(event.Total) !== null && event.Total >= 0) this.state.fuel = event.Total;
    if (event.event === 'HullDamage' && event.PlayerPilot !== false && number(event.Health) !== null && event.Health >= 0 && event.Health <= 1) {
      this.state.hull = event.Health * 100;
    }
    if (event.event === 'NavRoute' || event.event === 'NavRouteClear') {
      this.routeEvent = { kind: event.event, time: stamp(event.timestamp) };
    }
    // FSDTarget can remain in the log after arrival or a clear; never activates a route.
  }

  readJournal() {
    let entries;
    try {
      entries = fs.readdirSync(this.journalDir).filter((name) => /^Journal\..*\.log$/i.test(name))
        .map((name) => ({ name, stat: fs.statSync(path.join(this.journalDir, name)) }))
        .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs || a.name.localeCompare(b.name));
    } catch { return; }
    const latest = entries.at(-1);
    if (!latest) return;
    const file = path.join(this.journalDir, latest.name);
    if (file !== this.file) { this.file = file; this.offset = 0; this.tail = ''; }
    if (latest.stat.size < this.offset) { this.offset = 0; this.tail = ''; }
    if (latest.stat.size === this.offset) return;
    let descriptor;
    try {
      descriptor = fs.openSync(file, 'r');
      while (this.offset < latest.stat.size) {
        const buffer = Buffer.alloc(Math.min(256 * 1024, latest.stat.size - this.offset));
        const count = fs.readSync(descriptor, buffer, 0, buffer.length, this.offset);
        if (!count) break;
        this.offset += count;
        // Journals contain JSON escaped or ASCII names; preserve incomplete UTF-8 with a buffer tail.
        const joined = Buffer.concat([Buffer.from(this.tail, 'base64'), buffer.subarray(0, count)]);
        const lastNewline = joined.lastIndexOf(10);
        if (lastNewline < 0) { this.tail = joined.toString('base64'); continue; }
        for (const line of joined.subarray(0, lastNewline).toString('utf8').split('\n')) {
          if (!line.trim()) continue;
          try { this.processEvent(JSON.parse(line)); } catch { /* A malformed completed line cannot mutate state. */ }
        }
        this.tail = joined.subarray(lastNewline + 1).toString('base64');
      }
    } catch { /* Keep the last verified journal values across transient file locks. */ }
    finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  }

  readRoute() {
    const candidate = readJson(path.join(this.journalDir, 'NavRoute.json'));
    if (candidate?.event === 'NavRouteClear') {
      const time = stamp(candidate.timestamp);
      if (time !== null && (this.routeEvent.time === null || time >= this.routeEvent.time)) {
        this.routeEvent = { kind: 'NavRouteClear', time };
      }
      return;
    }
    if (!Array.isArray(candidate?.Route) || !candidate.Route.length) return;
    const time = stamp(candidate.timestamp);
    if (time === null) return;
    if (this.routeEvent.kind === 'NavRouteClear' && this.routeEvent.time !== null && time <= this.routeEvent.time) return;
    if (this.routeEvent.kind === 'NavRoute' && this.routeEvent.time !== null && time < this.routeEvent.time) return;
    const nodes = candidate.Route.map((item) => ({ name: text(item.StarSystem), address: number(item.SystemAddress),
      starClass: text(item.StarClass), position: validPosition(item.StarPos) ? item.StarPos : null }));
    if (nodes.some((item) => !item.name)) return;
    this.routeData = { time, nodes };
  }

  routeSnapshot() {
    const empty = { available: false, destination: null, nextSystem: null, remaining: null,
      total: null, completed: null, distanceRemaining: null, systems: [], source: 'journal' };
    if (!this.routeData) {
      if (this.routeEvent.kind === 'NavRouteClear') empty.remaining = 0;
      return empty;
    }
    const { nodes, time } = this.routeData;
    const cleared = this.routeEvent.kind === 'NavRouteClear' && (this.routeEvent.time === null || this.routeEvent.time >= time);
    const replaced = this.routeEvent.kind === 'NavRoute' && this.routeEvent.time !== null && this.routeEvent.time > time;
    const index = nodes.findIndex((node) => this.state.systemAddress !== null && node.address !== null
      ? node.address === this.state.systemAddress : sameName(node.name, this.state.system));
    const arrived = index === nodes.length - 1;
    if (replaced || (cleared && !arrived)) return { ...empty, remaining: cleared ? 0 : null };
    if (index < 0) return empty;
    const remaining = nodes.slice(index + 1);
    let distance = 0;
    for (let at = index; at < nodes.length - 1; at += 1) {
      if (!nodes[at].position || !nodes[at + 1].position) { distance = null; break; }
      distance += Math.hypot(...nodes[at].position.map((coordinate, axis) => coordinate - nodes[at + 1].position[axis]));
    }
    return { available: !cleared && remaining.length > 0, destination: nodes.at(-1).name,
      nextSystem: remaining[0]?.name ?? null, remaining: remaining.length, total: nodes.length - 1, completed: index,
      distanceRemaining: distance === null ? null : Math.round(distance * 10) / 10,
      systems: remaining.map(({ name, starClass }) => ({ name, starClass })), source: 'journal' };
  }

  snapshot() {
    this.readJournal();
    this.readRoute();
    const status = readJson(path.join(this.journalDir, 'Status.json'));
    this.statusValid = Number.isSafeInteger(status?.Flags) && status.Flags >= 0;
    if (this.statusValid) this.lastStatus = status;
    // An old timestamp alone is not stale: Elite can leave an unchanged stationary status file untouched.
    const flags = this.statusValid ? status.Flags : null;
    const flags2 = this.statusValid && Number.isSafeInteger(status.Flags2) ? status.Flags2 : null;
    const onFoot = flags2 !== null && (flags2 & 1) !== 0;
    const inSrv = flags !== null && (flags & FLAGS.srv) !== 0;
    const inMainShip = flags !== null && (flags & FLAGS.main) !== 0 && !onFoot && !inSrv;
    let fuel = inMainShip && number(status?.Fuel?.FuelMain) !== null ? status.Fuel.FuelMain : this.state.fuel;
    if (number(fuel) === null || fuel < 0 || (this.state.fuelCapacity !== null && fuel > this.state.fuelCapacity)) fuel = null;
    const telemetry = { system: this.state.system, ship: this.state.ship, fuel, fuelCapacity: this.state.fuelCapacity,
      hull: this.state.hull, supercruise: flags !== null && (flags & FLAGS.supercruise) !== 0,
      landed: flags !== null && (flags & FLAGS.landed) !== 0, docked: flags !== null && (flags & FLAGS.docked) !== 0,
      inMainShip, guiFocus: this.statusValid && Number.isInteger(status.GuiFocus) ? status.GuiFocus : null,
      observedAt: this.statusValid ? text(status.timestamp) : this.lastEvent };
    const route = this.routeSnapshot();
    const checks = [
      { id: 'journal', label: 'Oyun günlüğü', ok: this.journalSeen && this.sessionActive !== false,
        detail: !this.journalSeen ? 'Elite Dangerous günlük dosyası bulunamadı.' : this.sessionActive === false ? 'Son oyun oturumu kapalı.' : 'Yerel oyun günlüğü okunuyor.' },
      { id: 'status', label: 'Canlı durum dosyası', ok: this.statusValid,
        detail: this.statusValid ? 'Oyun durumu okunuyor.' : 'Status.json okunamıyor veya geçersiz.' },
      { id: 'ship', label: 'Ana gemi', ok: inMainShip,
        detail: onFoot ? 'Yaya durumundasınız; gemi kokpitine dönün.' : inSrv ? 'SRV içindesiniz; ana gemiye dönün.' : inMainShip ? 'Ana gemidesiniz.' : 'Ana gemi durumu doğrulanamadı.' },
      { id: 'flight', label: 'Uçuş durumu', ok: telemetry.supercruise && !telemetry.landed && !telemetry.docked,
        detail: telemetry.docked ? 'İstasyondan ayrılıp süper seyire geçin.' : telemetry.landed ? 'Yüzeyden kalkıp süper seyire geçin.' : !telemetry.supercruise ? 'Başlatmak için süper seyirde olun.' : 'Süper seyir etkin.' },
      { id: 'cockpit', label: 'Kokpit görünümü', ok: telemetry.guiFocus === 0,
        detail: telemetry.guiFocus === 0 ? 'Kokpit görünümü açık.' : 'Harita ve panelleri kapatıp kokpite dönün.' },
      { id: 'route', label: 'Etkin rota', ok: route.available,
        detail: route.available ? `${route.remaining} atlama kaldı.` : route.remaining === 0 ? 'Rota tamamlandı veya temizlendi; yeni rota çizin.' : 'Galaksi haritasında bulunduğunuz sistemden bir rota çizin.' },
    ];
    return { telemetry, route, checks };
  }
}
