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
app.on('window-all-closed', () => {}); // Report assertions before explicitly exiting.
let window, service, workers = 0;
let gamePosition = [0, 0, 0];
const errors = [];
const layoutChecks = [];
const timeout = setTimeout(() => { console.error('Navigation test timed out'); app.exit(1); }, 40000);
process.on('uncaughtException', error => { console.error(error.stack); app.exit(1); });
process.on('unhandledRejection', error => { console.error(error.stack); app.exit(1); });
async function until(expression) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (errors.length) throw new Error(errors.join('\n'));
    if (await window.webContents.executeJavaScript(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Renderer condition failed: ${expression}`);
}
async function checkLayout(width, expanded) {
  window.setSize(width, 980);
  await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const result = await window.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector('.rp-market');
    const cards = [...document.querySelectorAll('.rp-trade-card')];
    const first = cards[0];
    const details = first.querySelector('.rp-trade-details');
    const shell = document.querySelector('.rp-market-settings-shell');
    const panelBounds = panel.getBoundingClientRect();
    const overflow = [panel, ...cards, shell, ...first.querySelectorAll('*')].filter(element => {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      return rect.left < panelBounds.left - 2 || rect.right > panelBounds.right + 2 ||
        (element.scrollWidth > element.clientWidth + 2 && getComputedStyle(element).display !== 'inline');
    }).map(element => ({ tag: element.tagName, className: element.className, text: element.textContent.slice(0, 100),
      client: element.clientWidth, scroll: element.scrollWidth }));
    return { viewport: document.documentElement.clientWidth, documentWidth: document.documentElement.scrollWidth,
      cardCount: cards.length, detailsOpen: details.open, filtersOpen: shell.open, overflow };
  })()`);
  assert.equal(window.isVisible(), false, 'Layout checks must keep the window invisible');
  assert.equal(result.cardCount, 100);
  assert.equal(result.detailsOpen, expanded);
  assert.equal(result.filtersOpen, expanded);
  assert.ok(result.documentWidth <= result.viewport + 2, `Document overflows at ${width}px: ${JSON.stringify(result)}`);
  assert.deepEqual(result.overflow, [], `Market content overflows at ${width}px, expanded=${expanded}`);
  layoutChecks.push({ width, expanded });
}
async function run() {
  try {
    const { createRoutePilotServer } = await import(pathToFileURL(path.join(root, 'server/index.mjs')));
    const { station, buyer, quote, at, mockApi, NOW, FAST } = await import(pathToFileURL(path.join(root, 'features/markets/test/fixtures/synthetic.mjs')));
    service = createRoutePilotServer({ root: testRoot, publicDir: path.join(root, 'public'),
      telemetry: { snapshot: () => ({ telemetry: { system: 'Synthetic origin', position: gamePosition }, route: {}, checks: [] }) },
      spawnWorker() { workers++; throw new Error('Navigation test must never start flight'); },
      marketFetch: mockApi([
        ...Array.from({ length: 125 }, (_, i) => station(i + 1, {
          system_x: i === 124 ? 125 : i,
          ...(i === 124 ? { system_name: 'Test system 999',
            name: 'Synthetic same-system carrier with a deliberately long name to exercise narrow desktop layouts and wrapping' } : {}),
          market: [quote({ supply: 200 })],
        })),
        station(1001, { system_x: 20_000, market_updated_at: at(-72), market: [quote({ supply: 1 })] }),
        station(7001, { system_name: 'HIP 58832', system_x: 125,
          name: 'Synthetic carrier requiring a fleet carrier ride', market: [quote({ supply: 200 })] }),
        station(7002, { type: 'Outpost', system_x: 100,
          name: 'Synthetic NPC market 7002', market: [quote({ supply: 1_000 })] }),
        buyer(999, { type: 'Fleet Carrier', system_x: 125,
          name: 'Synthetic buyer station with a deliberately long name to test readable destination labels at small window widths' }),
      ]), marketNow: () => NOW });
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
      ['Ticaret tarayıcısı', 'Find your next trade'], ['İşlem geçmişi', 'Uçuşun işlem geçmişi'],
      ['Uçuş tercihleri', 'Uçuş tercihleri'], ['Rota takibi', 'Rotanı seç.'],
      ['Ticaret tarayıcısı', 'Find your next trade'],
    ]) {
      await window.webContents.executeJavaScript(`document.querySelector('[aria-label=${JSON.stringify(label)}]').click()`);
      await until(`document.querySelector('main').innerText.includes(${JSON.stringify(content)})`);
    }
    await until(`document.querySelectorAll('.rp-trade-card').length === 100`);
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('.rp-market-settings-shell').open`), false);
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('.rp-trade-details').open`), false);
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('.rp-trade-card').innerText.includes('Same system')`), true);
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('.rp-trade-card').innerText.includes('Supercruise required')`), true);
    for (const width of [850, 1420, 1920]) {
      await checkLayout(width, false);
      await window.webContents.executeJavaScript(`document.querySelector('.rp-trade-details > summary').click(); document.querySelector('.rp-market-settings-shell > summary').click()`);
      await checkLayout(width, true);
      await window.webContents.executeJavaScript(`document.querySelector('.rp-trade-details > summary').click(); document.querySelector('.rp-market-settings-shell > summary').click()`);
    }
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('input[id$="-minStock"]').value`), '100');
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('select[id$="-sort"]').value`), 'stockProfit');
    assert.equal(await window.webContents.executeJavaScript(`document.querySelector('input[id$="-excludeCarrierAccess"]').checked`), true);
    assert.equal((await service.markets.results()).total, 125);
    await window.webContents.executeJavaScript(`document.querySelector('input[id$="-excludeCarrierAccess"]').click()`);
    await until(`document.querySelector('.rp-market-pagination').innerText.includes('of 126') && !document.querySelector('input[id$="-excludeCarrierAccess"]').disabled`);
    assert.equal((await service.markets.status()).settings.excludeCarrierAccess, false);
    assert.equal((await service.markets.results()).rows.some(row => row.seller.id === '7001'), true);
    await window.webContents.executeJavaScript(`document.querySelector('input[id$="-excludeCarrierAccess"]').click()`);
    await until(`document.querySelector('.rp-market-pagination').innerText.includes('of 125') && !document.querySelector('input[id$="-excludeCarrierAccess"]').disabled`);
    assert.equal((await service.markets.status()).settings.excludeCarrierAccess, true);
    await window.webContents.executeJavaScript(`document.querySelector('[data-preset="nearMe"]').click()`);
    await until(`document.querySelector('select[id$="-sort"]').value === 'loadProfit' && [...document.querySelectorAll('.rp-trade-card')].some(card => card.querySelector('.rp-trade-seller a')?.textContent === 'Synthetic NPC market 7002')`);
    const nearMeSettings = (await service.markets.status()).settings;
    assert.deepEqual(Object.fromEntries(['sellerType', 'buyerType', 'requireFullStockDemand', 'maxPlayerDistanceLy',
      'maxRouteDistanceLy', 'maxMarketAgeHours', 'defaultSort', 'excludeCarrierAccess', 'cargoCapacity'].map(key => [key, nearMeSettings[key]])), {
      sellerType: 'all', buyerType: 'all', requireFullStockDemand: false, maxPlayerDistanceLy: 200,
      maxRouteDistanceLy: 50, maxMarketAgeHours: 24, defaultSort: 'loadProfit', excludeCarrierAccess: true, cargoCapacity: 16,
    });
    const npcTrade = (await service.markets.results()).rows.find(row => row.seller.id === '7002');
    assert.equal(npcTrade.sellerStock, 1_000); assert.equal(npcTrade.stock, 200); assert.equal(npcTrade.demandLimited, true);
    assert.equal(await window.webContents.executeJavaScript(`(() => {
      const card = [...document.querySelectorAll('.rp-trade-card')].find(card => card.querySelector('.rp-trade-seller a')?.textContent === 'Synthetic NPC market 7002');
      return card.querySelector('.rp-trade-seller').innerText.includes('Station market') &&
        card.querySelector('.rp-trade-facts').innerText.includes('200 t tradable') && card.innerText.includes('capped by demand');
    })()`), true);
    await window.webContents.executeJavaScript(`document.querySelector('[data-preset="nearby"]').click()`);
    await until(`document.querySelector('.rp-market-pagination').innerText.includes('of 125') && document.querySelector('select[id$="-sort"]').value === 'stockProfit'`);
    await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Next 100').click()`);
    await until(`document.querySelectorAll('.rp-trade-card').length === 25`);
    await window.webContents.executeJavaScript(`document.querySelector('[data-preset="highestBuyers"]').click()`);
    await until(`document.querySelector('.rp-market-pagination').innerText.includes('of 126')`);
    assert.equal((await service.markets.status()).settings.minStock, 1);
    assert.equal((await service.markets.status()).settings.cargoCapacity, 16);
    await window.webContents.executeJavaScript(`document.querySelector('[data-preset="nearby"]').click()`);
    await until(`document.querySelector('.rp-market-pagination').innerText.includes('of 125')`);
    await window.webContents.executeJavaScript(`(() => { const select = document.querySelector('select[id$="-sort"]'); select.value = 'closestSeller'; select.dispatchEvent(new Event('change', {bubbles:true})); })()`);
    await until(`document.querySelector('.rp-trade-card .rp-trade-seller a').textContent === 'Synthetic 1'`);
    assert.equal((await service.markets.status()).settings.defaultSort, 'closestSeller');
    await window.webContents.reload();
    await until(`document.body.innerText.includes('Rotanı seç.')`);
    await window.webContents.executeJavaScript(`document.querySelector('[aria-label="Ticaret tarayıcısı"]').click()`);
    await until(`document.querySelector('select[id$="-sort"]')?.value === 'closestSeller' && document.querySelectorAll('.rp-trade-card').length === 100`);
    await window.webContents.executeJavaScript(`document.querySelector('[data-preset="nearMe"]').click()`);
    await until(`document.querySelector('select[id$="-sort"]')?.value === 'loadProfit'`);
    gamePosition = null;
    await until(`document.querySelector('.rp-market-empty')?.textContent.includes('Waiting for your current game position') && document.querySelectorAll('.rp-trade-card').length === 0`);
    assert.equal((await service.markets.status()).settings.maxPlayerDistanceLy, 200);
    assert.equal(window.isVisible(), false);
    assert.deepEqual(errors, []);
    assert.equal(workers, 0);
    console.log(JSON.stringify({ passed: true, tabChanges: 5, firstPageRows: 100, secondPageRows: 25,
      presetSwitches: 4, rankingSurvivesReload: true, sameSystemExplained: true,
      carrierAccessFilterApplied: true, nearMeIncludesStationSellers: true, demandLimitedQuantityShown: true, positionLostPausesNearbySearch: true,
      layoutChecks, scrollReturn, visibleWindows: 0, flightWorkers: workers }));
  } finally {
    clearTimeout(timeout);
    if (window && !window.isDestroyed()) window.destroy();
    await service?.close();
  }
}
run().then(() => app.exit(0), error => { console.error(error.stack); app.exit(1); });
