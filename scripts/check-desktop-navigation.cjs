// Run with the installed Electron executable. No visible windows or game input.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
const testRoot = fs.mkdtempSync(path.join(root, 'work', 'navigation-check-'));
app.setPath('userData', path.join(testRoot, 'desktop'));
app.disableHardwareAcceleration();
let window, service, workers = 0;
const errors = [];
const timeout = setTimeout(() => { console.error('Navigation test timed out'); app.exit(1); }, 25000);
process.on('uncaughtException', error => { console.error(error.stack); app.exit(1); });
process.on('unhandledRejection', error => { console.error(error.stack); app.exit(1); });
async function until(expression) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (errors.length) throw new Error(errors.join('\n'));
    if (await window.webContents.executeJavaScript(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Renderer condition failed: ${expression}`);
}
async function run() {
  try {
    const { createRoutePilotServer } = await import(pathToFileURL(path.join(root, 'server/index.mjs')));
    const { station, buyer, mockApi, NOW, FAST } = await import(pathToFileURL(path.join(root, 'features/markets/test/fixtures/synthetic.mjs')));
    service = createRoutePilotServer({ root: testRoot, publicDir: path.join(root, 'public'),
      telemetry: { snapshot: () => ({ telemetry: { system: 'Synthetic origin', position: [0, 0, 0] }, route: {}, checks: [] }) },
      spawnWorker() { workers++; throw new Error('Navigation test must never start flight'); },
      marketFetch: mockApi([...Array.from({ length: 125 }, (_, i) => station(i + 1)), buyer(999)]), marketNow: () => NOW });
    await service.markets.ready;
    await service.markets.configure(FAST);
    assert.equal((await service.markets.refresh()).outcome, 'succeeded');
    const { port } = await service.listen(0);
    await app.whenReady();
    window = new BrowserWindow({ show: false, width: 1420, height: 980,
      webPreferences: { offscreen: true, sandbox: true, nodeIntegration: false, contextIsolation: true } });
    window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
    window.webContents.on('render-process-gone', (_event, details) => errors.push(JSON.stringify(details)));
    await window.loadURL(`http://127.0.0.1:${port}`);
    await until(`document.body.innerText.includes('Rotanı seç.')`);
    const scrollReturn = await window.webContents.executeJavaScript(`Object.prototype.toString.call(window.scrollTo({top:0,left:0}))`);
    for (const [label, content] of [
      ['Ticaret tarayıcısı', 'Synthetic 1'], ['İşlem geçmişi', 'Uçuşun işlem geçmişi'],
      ['Uçuş tercihleri', 'Uçuş tercihleri'], ['Rota takibi', 'Rotanı seç.'],
      ['Ticaret tarayıcısı', 'Synthetic 1'],
    ]) {
      await window.webContents.executeJavaScript(`document.querySelector('[aria-label=${JSON.stringify(label)}]').click()`);
      await until(`document.querySelector('main').innerText.includes(${JSON.stringify(content)})`);
    }
    assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('.rp-market tbody tr').length`), 100);
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Next 100').click()`);
    await until(`document.querySelectorAll('.rp-market tbody tr').length === 25`);
    assert.equal(window.isVisible(), false);
    assert.deepEqual(errors, []);
    assert.equal(workers, 0);
    console.log(JSON.stringify({ passed: true, tabChanges: 5, firstPageRows: 100, secondPageRows: 25,
      scrollReturn, visibleWindows: 0, flightWorkers: workers }));
  } finally {
    clearTimeout(timeout);
    if (window && !window.isDestroyed()) window.destroy();
    await service?.close();
  }
}
run().then(() => app.exit(0), error => { console.error(error.stack); app.exit(1); });
