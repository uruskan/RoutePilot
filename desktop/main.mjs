import { app, BrowserWindow, dialog, Menu } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRoutePilotServer } from '../server/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = 'http://127.0.0.1:47856';
const checkOnly = process.argv.includes('--check-runtime');
const cache = process.env.ROUTEPILOT_DATA || 'D:/GameDev/Cache/RoutePilot/desktop';
fs.mkdirSync(cache, { recursive: true });
app.setName('RoutePilot');
app.setPath('userData', cache);
app.setPath('sessionData', path.join(cache, 'session'));
app.setAppUserModelId('local.routepilot.desktop');

let backend, window, closing, externalSession, externalPoll, quitAllowed = false;
async function stopBackend() {
  if (closing) return closing;
  clearInterval(externalPoll);
  closing = (async () => {
    if (backend) return backend.close();
    // Never acquire a fresh token on exit: it could belong to a replacement
    // process, or to a service this window failed to attach to at startup.
    if (!externalSession) return;
    const response = await fetch(`${url}/api/command`, { method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json', 'X-RoutePilot-Token': externalSession },
      body: JSON.stringify({ action: 'shutdown' }) });
    const result = await response.json();
    if (!response.ok || result.ok !== true) throw new Error(result.message || 'Servis kapanış isteğini reddetti.');
  })().catch(error => console.error('RoutePilot kapanış:', error.message));
  return closing;
}

function watchExternalService() {
  let checking = false;
  externalPoll = setInterval(async () => {
    if (checking || closing || !externalSession) return;
    checking = true;
    try {
      // The session identifies the attached process; a health response alone
      // cannot distinguish a replacement RoutePilot on the same port.
      const response = await fetch(`${url}/api/session`, { signal: AbortSignal.timeout(2000) });
      const session = await response.json();
      if (!response.ok || session.token !== externalSession) throw new Error('Bağlı servis kapandı.');
    } catch {
      externalSession = undefined;
      app.quit();
    } finally { checking = false; }
  }, 2000);
}

async function launch() {
if (checkOnly) {
  // Console-only check: no window, focus, capture, hotkey, engine or input.
  await app.whenReady();
  console.log(JSON.stringify({ app: 'RoutePilot', electron: process.versions.electron,
    node: process.versions.node, rendererWindowCreated: false, engineStarted: false }));
  app.exit(0);
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.on('before-quit', event => {
    if (quitAllowed) return;
    event.preventDefault();
    void stopBackend().finally(() => { quitAllowed = true; app.quit(); });
  });
  app.on('window-all-closed', () => app.quit());
  try {
    await app.whenReady();
    if (closing) return;
    Menu.setApplicationMenu(null);
    let health;
    try { health = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) }).then(r => r.json()); } catch {}
    if (closing) return;
    if (health && health.app !== 'RoutePilot') throw new Error('47856 portunu başka bir uygulama kullanıyor.');
    if (!health) {
      backend = createRoutePilotServer({ root });
      await backend.listen();
      backend.server.on('close', () => { if (!closing) app.quit(); });
    } else {
      const response = await fetch(`${url}/api/session`, { signal: AbortSignal.timeout(2000) });
      const session = await response.json();
      if (closing) return;
      if (!response.ok || typeof session.token !== 'string' || !session.token) throw new Error('RoutePilot oturumu doğrulanamadı.');
      externalSession = session.token;
      watchExternalService();
    }
    if (closing) return;
    window = new BrowserWindow({ title: 'RoutePilot', width: 1420, height: 980,
      minWidth: 850, minHeight: 650, show: false, autoHideMenuBar: true,
      backgroundColor: '#10120f', webPreferences: { nodeIntegration: false,
        contextIsolation: true, sandbox: true, spellcheck: false } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, destination) => {
      try { if (new URL(destination).origin === url) return; } catch {}
      event.preventDefault();
    });
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.once('ready-to-show', () => window.show());
    window.on('closed', () => { window = null; });
    await window.loadURL(url);
  } catch (error) {
    dialog.showErrorBox('RoutePilot açılamadı', error.message);
    app.quit();
  }
}
}
// Finish evaluating the ESM entry before waiting for Electron's ready event.
void launch();
