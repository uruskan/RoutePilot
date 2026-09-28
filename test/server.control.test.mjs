import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createRoutePilotServer } from '../server/index.mjs';
import { stopOwnedProcess } from '../server/engine.mjs';

function fakeWorker({ shutdownExits = true } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.commands = [];
  child.stdin = new Writable({ write(chunk, encoding, done) {
    const command = JSON.parse(chunk.toString());
    child.commands.push(command);
    if (command.action === 'shutdown' && shutdownExits) queueMicrotask(() => child.finish(0));
    done();
  } });
  child.message = (message) => child.stdout.write(JSON.stringify(message) + '\n');
  child.finish = (code) => { child.emit('exit', code); child.emit('close', code); };
  child.kill = () => child.finish(0);
  return child;
}
async function fixture(t, { eligible = true, shutdownExits = true, stopProcess } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routepilot-server-'));
  fs.mkdirSync(path.join(root, 'public'));
  fs.writeFileSync(path.join(root, 'public', 'index.html'), '<h1>RoutePilot</h1>');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'outside public');
  let currentEligibility = eligible;
  const telemetry = { snapshot: () => ({ telemetry: { inMainShip: currentEligibility }, route: { available: currentEligibility },
    checks: [{ id: 'ship', label: 'Ana gemi', ok: currentEligibility, detail: currentEligibility ? 'Hazır.' : 'Yaya durumundasınız.' }] }) };
  const workers = [];
  const app = createRoutePilotServer({ root, telemetry, stopProcess,
    spawnWorker: () => { const worker = fakeWorker({ shutdownExits }); workers.push(worker); return worker; } });
  const { port } = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const { token } = await (await fetch(`${base}/api/session`)).json();
  const command = (action, extra = {}) => fetch(`${base}/api/command`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-RoutePilot-Token': token, Origin: base, ...extra }, body: JSON.stringify({ action }) });
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { app, base, token, command, workers, setEligibility: (value) => { currentEligibility = value; } };
}

test('health/session/state/static reads do not launch a worker', async (t) => {
  const { base, workers } = await fixture(t);
  assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { app: 'RoutePilot', version: '0.1.0' });
  assert.equal((await (await fetch(`${base}/api/state`)).json()).controls.canStart, true);
  assert.equal((await fetch(base)).status, 200);
  assert.equal((await fetch(`${base}/secret.txt`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e%2fsecret.txt`)).status, 403);
  assert.equal(workers.length, 0);
});

test('command mutations require POST, same Origin and token; no start on rejection', async (t) => {
  const { base, command, workers } = await fixture(t);
  assert.equal((await fetch(`${base}/api/command?action=start`)).status, 405);
  assert.equal((await command('start', { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await command('start', { 'X-RoutePilot-Token': 'wrong' })).status, 403);
  assert.equal((await command('unknown')).status, 400);
  assert.equal(workers.length, 0);
});

test('start eligibility rejects on-foot state before worker creation', async (t) => {
  const { command, workers } = await fixture(t, { eligible: false });
  assert.equal((await command('start')).status, 409);
  assert.equal(workers.length, 0);
});

test('only one pending start, readiness gate and persistent worker across runs', async (t) => {
  const { command, workers, app } = await fixture(t);
  assert.equal((await command('start')).status, 202);
  assert.equal((await command('start')).status, 409);
  assert.equal(workers.length, 1);
  assert.deepEqual(workers[0].commands, []);
  workers[0].message({ type: 'state', status: 'ready', phase: 'idle', message: 'Hazır' });
  assert.equal(workers[0].commands.filter((item) => item.action === 'start').length, 1);
  workers[0].message({ type: 'state', status: 'running', phase: 'jump', message: 'Atlama' });
  assert.equal(app.snapshot().controls.canStop, true);
  workers[0].message({ type: 'state', status: 'completed', phase: 'complete', message: 'Tamamlandı' });
  assert.equal((await command('start')).status, 202);
  assert.equal(workers.length, 1);
});

test('Stop during loading cancels intent permanently; ready never auto-starts', async (t) => {
  const { command, workers, app } = await fixture(t);
  await command('start');
  await command('stop');
  // Python acknowledges stop immediately, before native model loading ends.
  workers[0].message({ type: 'state', status: 'stopped', phase: 'paused', message: 'Durduruldu' });
  assert.equal(app.snapshot().engine.connected, false);
  assert.equal(app.snapshot().controls.canStart, false);
  assert.equal((await command('start')).status, 409);
  workers[0].message({ type: 'state', status: 'ready', phase: 'idle', message: 'Hazır' });
  assert.deepEqual(workers[0].commands.map((item) => item.action), ['stop']);
  assert.equal(app.snapshot().engine.status, 'ready');
  assert.equal(app.engine.pendingStart, false);
  assert.equal(app.snapshot().controls.canStart, true);
});

test('worker stop during loading cancels pending intent without an HTTP stop', async (t) => {
  const { command, workers, app } = await fixture(t);
  await command('start');
  workers[0].message({ type: 'state', status: 'stopped', phase: 'paused', message: 'Acil durdurma' });
  workers[0].message({ type: 'state', status: 'ready', phase: 'idle', message: 'Hazır' });
  assert.equal(app.engine.pendingStart, false);
  assert.equal(workers[0].commands.length, 0);
});

test('flight error after readiness permits explicit retry on the same worker', async (t) => {
  const { command, workers, app } = await fixture(t);
  await command('start');
  workers[0].message({ type: 'state', status: 'ready', phase: 'idle', message: 'Hazır' });
  workers[0].message({ type: 'state', status: 'running', phase: 'align', message: 'Hizalanıyor' });
  workers[0].message({ type: 'state', status: 'error', phase: 'error', message: 'Odak kayboldu.' });
  assert.equal(app.snapshot().engine.connected, true);
  assert.equal(app.snapshot().controls.canStart, true);
  assert.equal((await command('start')).status, 202);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].commands.filter((item) => item.action === 'start').length, 2);
});

test('fatal initialization exit preserves its error and permits a fresh explicit retry', async (t) => {
  const { command, workers, app } = await fixture(t);
  await command('start');
  workers[0].message({ type: 'state', status: 'error', phase: 'error', message: 'EDAP zaten açık.' });
  assert.equal(app.snapshot().engine.connected, false);
  assert.equal((await command('start')).status, 409);
  workers[0].finish(1);
  assert.equal(app.snapshot().engine.message, 'EDAP zaten açık.');
  assert.equal(app.engine.workerReady, false);
  assert.equal((await command('start')).status, 202);
  assert.equal(workers.length, 2);
});

test('stdio is drained after exit before replacing the final worker error', async (t) => {
  const { command, workers, app } = await fixture(t);
  await command('start');
  workers[0].emit('exit', 1);
  assert.equal(app.engine.child, workers[0]);
  workers[0].message({ type: 'state', status: 'error', phase: 'error', message: 'Model yüklenemedi.' });
  workers[0].emit('close', 1);
  assert.equal(app.engine.child, null);
  assert.equal(app.snapshot().engine.message, 'Model yüklenemedi.');
  assert.equal(app.snapshot().engine.connected, false);
});

test('cockpit eligibility is rechecked after model loading before issuing start', async (t) => {
  const { command, workers, setEligibility, app } = await fixture(t);
  await command('start');
  setEligibility(false);
  workers[0].message({ type: 'state', status: 'ready', phase: 'idle', message: 'Hazır' });
  assert.equal(workers[0].commands.length, 0);
  assert.equal(app.snapshot().engine.status, 'stopped');
  assert.match(app.snapshot().engine.message, /Yaya/);
});

test('failed initialization cannot retain a pending start; close sends stop and shutdown', async (t) => {
  const { command, workers, app } = await fixture(t);
  await command('start');
  workers[0].message({ type: 'state', status: 'error', phase: 'error', message: 'EDAP zaten açık.' });
  workers[0].message({ type: 'state', status: 'ready', phase: 'idle', message: 'Hazır' });
  assert.equal(workers[0].commands.length, 0);
  await app.close();
  assert.deepEqual(workers[0].commands.map((item) => item.action), ['stop', 'shutdown']);
});

test('spawn error followed by close frees child slot for explicit retry', async (t) => {
  const { command, workers, app } = await fixture(t);
  await command('start');
  workers[0].emit('error', new Error('ENOENT'));
  workers[0].emit('close', -1);
  assert.equal(app.engine.child, null);
  assert.equal(app.engine.pendingStart, false);
  assert.equal((await command('start')).status, 202);
  assert.equal(workers.length, 2);
});

test('shutdown timeout terminates only the currently owned worker after protocol stop', async (t) => {
  const stopped = [];
  const { command, workers, app } = await fixture(t, { shutdownExits: false,
    stopProcess: async (child) => { stopped.push(child); child.finish(0); } });
  await command('start');
  await app.engine.close(5);
  assert.deepEqual(workers[0].commands.map((item) => item.action), ['stop', 'shutdown']);
  assert.deepEqual(stopped, [workers[0]]);
  assert.equal(app.engine.child, null);
});

test('normal shutdown never invokes process-tree termination', async (t) => {
  const stopped = [];
  const { command, app } = await fixture(t, { stopProcess: async (child) => stopped.push(child) });
  await command('start');
  await app.engine.close(10);
  assert.deepEqual(stopped, []);
});

test('Windows fallback scopes taskkill to the owned live PID and its descendants', async () => {
  const calls = [];
  const child = { pid: 54123, exitCode: null, signalCode: null };
  const spawnCommand = (...args) => {
    calls.push(args);
    const command = new EventEmitter();
    queueMicrotask(() => command.emit('close', 0));
    return command;
  };
  await stopOwnedProcess(child, { platform: 'win32', spawnCommand });
  assert.match(calls[0][0], /\\System32\\taskkill\.exe$/i);
  assert.deepEqual(calls[0][1], ['/PID', '54123', '/T', '/F']);
  assert.equal(calls[0][2].windowsHide, true);
  assert.equal(calls[0][2].shell, undefined);
  assert.equal(calls[0][2].timeout, 5000);
  child.exitCode = 0;
  await stopOwnedProcess(child, { platform: 'win32', spawnCommand });
  assert.equal(calls.length, 1);
  await assert.rejects(stopOwnedProcess({ pid: -1 }, { platform: 'win32', spawnCommand }), /kimliği/);
  assert.equal(calls.length, 1);
});
