import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';

// Run the real entry lifecycle with fake Electron/network dependencies. The
// test never imports Electron, starts a server, creates a window or game worker.
const entry = fs.readFileSync(new URL('../desktop/main.mjs', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/^const root = .*;$/m, "const root = 'test-root';")
  .replace('void launch();', 'return launch();');
const runEntry = new Function('app', 'BrowserWindow', 'dialog', 'Menu', 'fs', 'path',
  'createRoutePilotServer', 'process', 'fetch', 'AbortSignal', 'console', 'setInterval', 'clearInterval', entry);
const response = (body, ok = true) => ({ ok, json: async () => body });
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function fixture({ check = false, singleInstance = true, fetcher, closeBackend } = {}) {
  const app = new EventEmitter();
  const state = { windows: [], requests: [], backendCreated: 0, listens: 0, closes: 0,
    quits: 0, exits: [], errors: [], intervals: new Set(), logs: [] };
  Object.assign(app, { whenReady: async () => {}, setName() {}, setPath() {}, setAppUserModelId() {},
    requestSingleInstanceLock: () => singleInstance, exit: (code) => state.exits.push(code),
    quit() {
      let prevented = false;
      app.emit('before-quit', { preventDefault: () => { prevented = true; } });
      if (!prevented) state.quits += 1;
    } });
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.session = { setPermissionRequestHandler() {} };
      state.windows.push(this);
    }
    async loadURL() {}
    show() {}
    focus() {}
    isMinimized() { return false; }
  }
  const backend = { server: new EventEmitter(), listen: async () => { state.listens += 1; },
    close: async () => { state.closes += 1; await closeBackend?.(); } };
  await runEntry(app, BrowserWindow, { showErrorBox: (...args) => state.errors.push(args) },
    { setApplicationMenu() {} }, { mkdirSync() {} }, path,
    () => { state.backendCreated += 1; return backend; },
    { argv: check ? ['--check-runtime'] : [], env: {}, versions: { electron: 'test', node: 'test' } },
    async (url, options = {}) => { state.requests.push({ url, options }); return fetcher?.(url, options) ?? Promise.reject(new Error('offline')); },
    { timeout: () => ({}) }, { log: (...args) => state.logs.push(args), error: (...args) => state.errors.push(args) },
    (callback, delay) => { const timer = { callback, delay }; state.intervals.add(timer); return timer; },
    (timer) => state.intervals.delete(timer));
  await tick();
  return { app, backend, state, poll: async () => { for (const timer of [...state.intervals]) await timer.callback(); await tick(); } };
}

test('runtime probe creates no window, service, connection or quit hook', async () => {
  const { app, state } = await fixture({ check: true });
  assert.deepEqual(state.exits, [0]);
  assert.equal(state.windows.length, 0);
  assert.equal(state.backendCreated, 0);
  assert.equal(state.requests.length, 0);
  assert.equal(app.listenerCount('before-quit'), 0);
});

test('second desktop instance exits without touching the existing service', async () => {
  const { state } = await fixture({ singleInstance: false });
  assert.equal(state.quits, 1);
  assert.equal(state.requests.length, 0);
  assert.equal(state.backendCreated, 0);
  assert.equal(state.windows.length, 0);
});

test('closing an owned desktop waits for backend and worker shutdown', async () => {
  let release;
  const drain = new Promise((resolve) => { release = resolve; });
  const { app, state } = await fixture({ closeBackend: () => drain });
  assert.equal(state.backendCreated, 1);
  assert.equal(state.windows.length, 1);
  app.emit('window-all-closed');
  await tick();
  assert.equal(state.closes, 1);
  assert.equal(state.quits, 0);
  release(); await tick();
  assert.equal(state.quits, 1);
});

test('startup rejection never acquires a token or shuts down an unrelated service', async () => {
  const { state } = await fixture({ fetcher: async () => response({ app: 'SomethingElse' }) });
  assert.equal(state.requests.length, 1);
  assert.equal(state.windows.length, 0);
  assert.equal(state.backendCreated, 0);
  assert.equal(state.quits, 1);
});

test('attached service shutdown uses the original session and stops its poll', async () => {
  const { app, state } = await fixture({ fetcher: async (url) => response(
    url.endsWith('/health') ? { app: 'RoutePilot' } : url.endsWith('/session') ? { token: 'original' } : { ok: true }) });
  assert.equal(state.backendCreated, 0);
  assert.equal(state.intervals.size, 1);
  app.emit('window-all-closed'); await tick();
  const posts = state.requests.filter(({ options }) => options.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].options.headers['X-RoutePilot-Token'], 'original');
  assert.equal(state.requests.filter(({ url }) => url.endsWith('/session')).length, 1);
  assert.equal(state.intervals.size, 0);
  assert.equal(state.quits, 1);
});

test('CLI shutdown of attached service closes desktop without another mutation', async () => {
  let offline = false;
  const { state, poll } = await fixture({ fetcher: async (url) => {
    if (offline) throw new Error('offline');
    return response(url.endsWith('/health') ? { app: 'RoutePilot' } : { token: 'original' });
  } });
  offline = true; await poll();
  assert.equal(state.quits, 1);
  assert.equal(state.intervals.size, 0);
  assert.equal(state.requests.filter(({ options }) => options.method === 'POST').length, 0);
});

test('replacement service on the same port is never shut down by the old window', async () => {
  let token = 'original';
  const { state, poll } = await fixture({ fetcher: async (url) => response(
    url.endsWith('/health') ? { app: 'RoutePilot' } : { token }) });
  token = 'replacement'; await poll();
  assert.equal(state.quits, 1);
  assert.equal(state.requests.filter(({ options }) => options.method === 'POST').length, 0);
});

test('failed external session validation does not authorize shutdown', async () => {
  const { state } = await fixture({ fetcher: async (url) => response(
    url.endsWith('/health') ? { app: 'RoutePilot' } : { token: '' }) });
  assert.equal(state.windows.length, 0);
  assert.equal(state.quits, 1);
  assert.equal(state.requests.filter(({ options }) => options.method === 'POST').length, 0);
});

test('launcher rebuilds changed market UI and dependency inputs without launching the app', { skip: process.platform !== 'win32' }, (t) => {
  const launcher = fs.readFileSync(new URL('../Start-RoutePilot.ps1', import.meta.url), 'utf8');
  // Execute only the real freshness decision; replace the build command with a
  // harmless function. No package install, Electron or service can run here.
  const start = launcher.indexOf("    $index = Get-Item 'public/index.html'");
  const end = launcher.indexOf("    New-Item -ItemType Directory", start);
  assert.ok(start >= 0 && end > start, 'launcher build decision is available');
  const decision = launcher.slice(start, end);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'routepilot-build-inputs-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const inputs = ['web/src/main.jsx', 'features/markets/ui/MarketPanel.jsx', 'features/markets/ui/MarketPanel.css',
    'features/markets/ui/market-client.mjs', 'vite.config.mjs', 'package.json', 'package-lock.json'];
  const older = new Date('2026-01-01T00:00:00Z'), built = new Date('2026-01-02T00:00:00Z'), newer = new Date('2026-01-03T00:00:00Z');
  for (const file of [...inputs, 'public/index.html']) {
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'fixture');
    fs.utimesSync(target, older, older);
  }
  const output = path.join(directory, 'public/index.html');
  fs.utimesSync(output, built, built);
  const script = `$ErrorActionPreference = 'Stop'\nfunction Invoke-TestBuild { $global:LASTEXITCODE = 0; Write-Output 'BUILD' }\n$node = 'Invoke-TestBuild'\n${decision}`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const needsBuild = () => {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout.trim() === 'BUILD';
  };
  assert.equal(needsBuild(), false, 'up-to-date bundle is retained');
  for (const file of inputs) {
    const target = path.join(directory, file); fs.utimesSync(target, newer, newer);
    assert.equal(needsBuild(), true, `${file} invalidates the bundle`);
    fs.utimesSync(target, older, older);
  }
  fs.rmSync(output);
  assert.equal(needsBuild(), true, 'missing bundle is built');
});
