import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runCli, DEFAULT_URL, REQUEST_TIMEOUT_MS, EXIT } from '../cli/routepilot.mjs';

const state = () => ({
  app: { name: 'RoutePilot', version: '0.1.0' },
  engine: { status: 'offline', phase: 'idle', message: 'Motor kapalı', connected: false },
  telemetry: { system: 'Sol', ship: 'Mandalay', fuel: 27.5, fuelCapacity: 32, hull: 100 },
  route: { available: true, destination: 'Achenar', nextSystem: 'Alpha Centauri', completed: 2, total: 5, remaining: 3, distanceRemaining: 70 },
  controls: { canStart: false, canStop: false, startReason: 'Kokpite dönün.' },
  checks: [{ id: 'cockpit', label: 'Kokpit', ok: false, detail: 'Panel açık.' }],
  activity: [{ id: 1, time: '2026-09-29T00:00:00Z', level: 'info', title: 'Sahte olay', detail: 'Test verisi' }],
});
const json = (response, data, code = 200) => {
  response.writeHead(code, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(data));
};
async function fixture(t, handler) {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const call = { method: request.method, path: request.url, headers: request.headers, body: text ? JSON.parse(text) : undefined };
    calls.push(call);
    if (handler) return handler(call, response, calls);
    if (call.path === '/api/state') return json(response, state());
    if (call.path === '/api/session') return json(response, { token: 'test-secret' });
    if (call.path === '/api/command') return json(response, { ok: true, message: 'İstek alındı.' }, 202);
    json(response, { ok: false }, 404);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const out = [];
  const err = [];
  return { calls, out, err, options: { baseUrl: `http://127.0.0.1:${server.address().port}`, out: (line) => out.push(line), err: (line) => err.push(line) } };
}

test('default status only reads state and shows readiness, telemetry and events in Turkish', async (t) => {
  const f = await fixture(t);
  assert.equal(await runCli([], f.options), EXIT.OK);
  assert.deepEqual(f.calls.map(({ method, path }) => [method, path]), [['GET', '/api/state']]);
  const output = f.out.join('\n');
  for (const text of ['Motor kapalı', 'Başlatma: Uygun değil', 'Kokpite dönün.', '[Eksik] Kokpit', 'Mandalay', '27,5 / 32 t', 'Kalan: 3', 'Sahte olay']) assert.ok(output.includes(text), text);
  assert.deepEqual(f.err, []);
  assert.equal(DEFAULT_URL, 'http://127.0.0.1:47856');
  assert.equal(REQUEST_TIMEOUT_MS, 5000);
});

test('status aliases remain GET-only even when start is ready', async (t) => {
  const f = await fixture(t, (_, response) => { const snapshot = state(); snapshot.controls.canStart = true; json(response, snapshot); });
  for (const command of ['status', 'durum']) assert.equal(await runCli([command], f.options), EXIT.OK);
  assert.ok(f.calls.every((call) => call.method === 'GET' && call.path === '/api/state'));
});

for (const [action, aliases] of Object.entries({ start: ['start', 'baslat', 'başlat'], stop: ['stop', 'durdur'], save: ['save', 'kaydet'], shutdown: ['shutdown', 'kapat'] })) {
  test(`${action} and Turkish aliases fetch token then POST exactly once`, async (t) => {
    const f = await fixture(t);
    for (const alias of aliases) {
      const before = f.calls.length;
      assert.equal(await runCli([alias], f.options), EXIT.OK);
      const calls = f.calls.slice(before);
      assert.equal(calls.length, 2);
      assert.equal(calls[0].method, 'GET');
      assert.equal(calls[0].path, '/api/session');
      assert.equal(calls[1].method, 'POST');
      assert.equal(calls[1].path, '/api/command');
      assert.deepEqual(calls[1].body, { action });
      assert.equal(calls[1].headers['x-routepilot-token'], 'test-secret');
      assert.equal(calls[1].headers['content-type'], 'application/json');
      assert.equal(calls[1].headers.origin, undefined);
    }
    assert.ok(f.out.every((line) => !line.includes('test-secret')));
    assert.match(f.out[0], /İstek kabul edildi/);
  });
}

test('server rejection is reported with exit 1 and never retries mutation', async (t) => {
  const f = await fixture(t, (call, response) => call.path === '/api/session'
    ? json(response, { token: 'test-secret' }) : json(response, { ok: false, message: 'Oyun ön planda değil.' }, 409));
  assert.equal(await runCli(['baslat'], f.options), EXIT.REJECTED);
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 1);
  assert.match(f.err.join('\n'), /409.*Oyun ön planda değil/);
});

test('missing session token prevents all mutations', async (t) => {
  const f = await fixture(t, (_, response) => json(response, {}));
  assert.equal(await runCli(['start'], f.options), EXIT.REJECTED);
  assert.deepEqual(f.calls.map((call) => call.path), ['/api/session']);
  assert.match(f.err.join('\n'), /komut gönderilmedi/);
});

test('POST timeout has bounded wait, uncertain result and no automatic retry', async (t) => {
  const f = await fixture(t, (call, response) => {
    if (call.path === '/api/session') json(response, { token: 'test-secret' });
    // Deliberately leave the fake POST pending to exercise timeout after send.
  });
  assert.equal(await runCli(['stop'], { ...f.options, timeoutMs: 80 }), EXIT.CONNECTION);
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 1);
  assert.match(f.err.join('\n'), /sonucu doğrulanamadı/);
  assert.match(f.err.join('\n'), /otomatik tekrar gönderilmedi/);
});

test('status timeout sends no session request or mutation', async (t) => {
  const f = await fixture(t, () => {});
  assert.equal(await runCli([], { ...f.options, timeoutMs: 80 }), EXIT.CONNECTION);
  assert.deepEqual(f.calls.map((call) => call.path), ['/api/state']);
});

test('unreachable service reports exit 3 without launching a server', async (t) => {
  const listener = http.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const errors = [];
  assert.equal(await runCli([], { baseUrl: `http://127.0.0.1:${port}`, out() {}, err: (message) => errors.push(message) }), EXIT.CONNECTION);
  assert.match(errors.join('\n'), /Önce RoutePilot uygulamasını açın/);
});

test('malformed state and ambiguous command response fail clearly', async (t) => {
  const f = await fixture(t, (call, response) => {
    if (call.path === '/api/session') json(response, { token: 'test-secret' });
    else json(response, {});
  });
  assert.equal(await runCli([], f.options), EXIT.REJECTED);
  assert.equal(await runCli(['save'], f.options), EXIT.REJECTED);
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 1);
  assert.match(f.err.join('\n'), /sonucu doğrulanamadı/);
});

test('invalid arguments and help do not make any HTTP request', async (t) => {
  const f = await fixture(t);
  for (const args of [['landing'], ['start', '--yes']]) assert.equal(await runCli(args, f.options), EXIT.USAGE);
  for (const command of ['--help', '-h', 'help', 'yardim', 'yardım']) assert.equal(await runCli([command], f.options), EXIT.OK);
  assert.equal(f.calls.length, 0);
  assert.match(f.out[0], /Ctrl\+C yalnızca izlemeyi kapatır/);
});

test('executable help works without the service', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../cli/routepilot.mjs', import.meta.url)), '--help'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, EXIT.OK);
  assert.match(result.stdout, /RoutePilot konsol istemcisi/);
});

for (const alias of ['watch', 'izle']) {
  test(`${alias} prints each new event and phase once; cancelling never stops flight`, async (t) => {
    const controller = new AbortController();
    const fallback = setTimeout(() => controller.abort(), 1500);
    t.after(() => clearTimeout(fallback));
    const f = await fixture(t, (_, response, calls) => {
      const snapshot = state();
      if (calls.length >= 2) {
        snapshot.engine = { ...snapshot.engine, status: 'running', phase: 'jump', message: 'Atlama hazırlanıyor' };
        snapshot.activity.unshift({ id: 2, time: '2026-09-29T00:01:00Z', level: 'success', title: 'Yeni olay', detail: 'Bir kez göster' });
      }
      // A restarted service may reuse IDs; differing event data is still new.
      if (calls.length >= 4) snapshot.activity.unshift({ id: 1, time: '2026-09-29T00:02:00Z', level: 'info', title: 'Yeni oturum', detail: '' });
      json(response, snapshot);
    });
    const out = (line) => {
      f.out.push(line);
      if (line.includes('Yeni oturum')) controller.abort();
    };
    assert.equal(await runCli([alias], { ...f.options, out, signal: controller.signal, pollMs: 5 }), EXIT.OK);
    const output = f.out.join('\n');
    assert.equal(output.split('Yeni olay').length - 1, 1);
    assert.equal(output.split('Aşama: Atlıyor').length - 1, 1);
    assert.match(output, /\[[^\]]+\] Başarılı: Yeni olay/);
    assert.match(output, /Uçuşa durdurma komutu gönderilmedi/);
    assert.ok(f.calls.length >= 4);
    assert.ok(f.calls.every((call) => call.path === '/api/state' && call.method === 'GET'));
  });
}

test('watch read recovery is bounded per request and never duplicates events', async (t) => {
  const controller = new AbortController();
  const fallback = setTimeout(() => controller.abort(), 1500);
  t.after(() => clearTimeout(fallback));
  const f = await fixture(t, (_, response, calls) => calls.length === 2
    ? json(response, { ok: false, message: 'Geçici hata' }, 503) : json(response, state()));
  const out = (line) => { f.out.push(line); if (line.includes('Bağlantı yeniden kuruldu')) controller.abort(); };
  assert.equal(await runCli(['watch'], { ...f.options, out, signal: controller.signal, pollMs: 5 }), EXIT.OK);
  assert.equal(f.out.join('\n').split('Sahte olay').length - 1, 1);
  assert.match(f.err.join('\n'), /Yalnızca durum okuma yeniden denenecek/);
  assert.ok(f.calls.every((call) => call.method === 'GET'));
});
