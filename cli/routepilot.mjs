#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMarketCli } from './market-client.mjs';

export const DEFAULT_URL = 'http://127.0.0.1:47856';
export const REQUEST_TIMEOUT_MS = 5000;
export const EXIT = Object.freeze({ OK: 0, REJECTED: 1, USAGE: 2, CONNECTION: 3 });

const COMMANDS = new Map([
  ['status', 'status'], ['durum', 'status'], ['start', 'start'], ['baslat', 'start'],
  ['başlat', 'start'], ['stop', 'stop'], ['durdur', 'stop'], ['save', 'save'],
  ['kaydet', 'save'], ['shutdown', 'shutdown'], ['kapat', 'shutdown'],
  ['watch', 'watch'], ['izle', 'watch'],
]);
const STATUS = { offline: 'Motor kapalı', loading: 'Motor yükleniyor', ready: 'Motor hazır',
  running: 'Uçuş çalışıyor', stopped: 'Uçuş durdu', completed: 'Rota tamamlandı', error: 'Hata' };
const PHASE = { idle: 'Bekliyor', align: 'Hizalanıyor', jump: 'Atlıyor', refuel: 'Yakıt topluyor',
  clearance: 'Yıldızdan uzaklaşıyor', depart: 'Ayrılıyor', complete: 'Tamamlandı', paused: 'Durakladı', error: 'Hata' };
const LEVEL = { info: 'Bilgi', success: 'Başarılı', warning: 'Uyarı', error: 'Hata' };
const clean = (value) => String(value ?? '—').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
const number = (value, digits = 1) => typeof value === 'number' && Number.isFinite(value)
  ? value.toLocaleString('tr-TR', { maximumFractionDigits: digits }) : '—';
const stamp = (value = new Date()) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Zaman bilinmiyor' : date.toLocaleString('tr-TR');
};

export const HELP = `RoutePilot konsol istemcisi
Kullanım: RoutePilot-CLI.cmd [komut]
  status   / durum    Güncel durum (varsayılan; yalnızca okur)
  start    / baslat   Rotayı başlatma isteği gönderir
  stop     / durdur   Uçuşu veya bekleyen başlatmayı durdurur
  save     / kaydet   Öğrenilen gemi ayarlarını kaydetme isteği gönderir
  shutdown / kapat    Uçuşu durdurup RoutePilot sunucusunu kapatır
  watch    / izle     Yeni olayları ve aşama değişikliklerini izler
  markets            Ticaret tarayıcısı; markets --help ile seçenekleri görün
  --help   / yardim   Bu yardımı gösterir

Yerel adres: ${DEFAULT_URL}
Sunucu ayrıca açılmış olmalı; bu istemci sunucuyu kendiliğinden açmaz.
İzlemede Ctrl+C yalnızca izlemeyi kapatır; uçuşu durdurmaz.
Uçuşu durdurmak için ayrı bir komut kullanın: RoutePilot-CLI.cmd durdur
Komutlar otomatik yeniden denenmez; kabul yanıtı işlemin tamamlandığı anlamına gelmez.
Çıkış kodları: 0 başarılı, 1 sunucu reddi/geçersiz yanıt, 2 kullanım hatası,
3 bağlantı hatası veya zaman aşımı (istek sonucu doğrulanamamış olabilir).`;

class ClientError extends Error {
  constructor(message, exitCode, uncertain = false) {
    super(message);
    this.exitCode = exitCode;
    this.uncertain = uncertain;
  }
}

// Dependency injection is for isolated tests; the executable always uses DEFAULT_URL.
export function createClient({ baseUrl = DEFAULT_URL, timeoutMs = REQUEST_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const address = new URL(baseUrl);
  if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || address.username || address.password) {
    throw new ClientError('Yalnızca 127.0.0.1 üzerindeki yerel sunucu desteklenir.', EXIT.USAGE);
  }
  async function request(endpoint, { action, token, signal } = {}) {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const response = await fetchImpl(new URL(endpoint, address), {
        method: action ? 'POST' : 'GET', signal: controller.signal, redirect: 'error',
        headers: action ? { 'Content-Type': 'application/json', 'X-RoutePilot-Token': token } : {},
        ...(action ? { body: JSON.stringify({ action }) } : {}),
      });
      let data;
      try { data = await response.json(); }
      catch (error) {
        if (controller.signal.aborted) throw error;
        throw new ClientError(`Sunucu geçerli JSON döndürmedi (HTTP ${response.status}).`, EXIT.REJECTED, Boolean(action));
      }
      if (!response.ok || data?.ok === false) {
        throw new ClientError(`İstek reddedildi (HTTP ${response.status}): ${clean(data?.message ?? 'Sunucu hatası')}`, EXIT.REJECTED);
      }
      return data;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof ClientError) throw error;
      throw new ClientError(timedOut
        ? `Sunucu ${timeoutMs / 1000} saniyede yanıt vermedi.`
        : `RoutePilot bağlantısı kurulamadı (${address.origin}). Önce RoutePilot uygulamasını açın.`,
      EXIT.CONNECTION, Boolean(action));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  return {
    async state(signal) {
      const state = await request('/api/state', { signal });
      if (state?.app?.name !== 'RoutePilot' || !state.engine || !state.controls || !Array.isArray(state.activity)) {
        throw new ClientError('RoutePilot durum yanıtı eksik veya geçersiz.', EXIT.REJECTED);
      }
      return state;
    },
    async command(action) {
      if (!['start', 'stop', 'save', 'shutdown'].includes(action)) {
        throw new ClientError('Geçersiz komut.', EXIT.USAGE);
      }
      const session = await request('/api/session');
      if (typeof session?.token !== 'string' || !session.token) {
        throw new ClientError('Oturum anahtarı alınamadı; komut gönderilmedi.', EXIT.REJECTED);
      }
      const result = await request('/api/command', { action, token: session.token });
      if (result?.ok !== true) throw new ClientError('Komut yanıtı doğrulanamadı.', EXIT.REJECTED, true);
      return result;
    },
  };
}

function eventLine(event) {
  return `[${stamp(event.time)}] ${LEVEL[event.level] ?? clean(event.level)}: ${clean(event.title)}${event.detail ? ` — ${clean(event.detail)}` : ''}`;
}
function phaseLine(state) {
  return `${STATUS[state.engine.status] ?? clean(state.engine.status)} | Aşama: ${PHASE[state.engine.phase] ?? clean(state.engine.phase)}${state.engine.message ? ` — ${clean(state.engine.message)}` : ''}`;
}
function readinessLine(state) {
  return `Başlatma: ${state.controls.canStart ? 'Hazır' : 'Uygun değil'} — ${clean(state.controls.startReason)}`;
}
export function formatStatus(state) {
  const t = state.telemetry ?? {};
  const r = state.route ?? {};
  const lines = [
    `RoutePilot | ${stamp()}`, phaseLine(state),
    `Sistem: ${clean(t.system)} | Gemi: ${clean(t.ship)}`,
    `Yakıt: ${number(t.fuel)} / ${number(t.fuelCapacity)} t | Gövde: %${number(t.hull)}`,
    r.available ? `Rota: ${clean(r.destination)} | ${number(r.completed, 0)} / ${number(r.total, 0)} atlama tamamlandı | Kalan: ${number(r.remaining, 0)}` : 'Rota: Etkin rota yok',
    `Sonraki sistem: ${clean(r.nextSystem)} | Kalan mesafe: ${number(r.distanceRemaining)} ly`,
    readinessLine(state),
  ];
  for (const check of state.checks ?? []) {
    lines.push(`  ${check.ok ? '[Tamam]' : '[Eksik]'} ${clean(check.label)}${check.detail ? `: ${clean(check.detail)}` : ''}`);
  }
  lines.push('Son olaylar:');
  const events = state.activity.slice(0, 5).reverse();
  lines.push(...(events.length ? events.map(eventLine) : ['  Henüz olay yok.']));
  return lines.join('\n');
}

async function watch(client, { out, err, signal, pollMs }) {
  out('İzleme açık. Ctrl+C yalnızca izlemeyi kapatır; uçuşu durdurmaz. Durdurmak için: RoutePilot-CLI.cmd durdur');
  const seen = new Set();
  let lastPhase;
  let lastReadiness;
  let lastFailure;
  let initialized = false;
  const eventKey = (event) => JSON.stringify([event.id, event.time, event.title, event.detail]);
  async function poll() {
    const state = await client.state(signal);
    if (signal.aborted) return;
    if (lastFailure) out(`[${stamp()}] Bağlantı yeniden kuruldu.`);
    lastFailure = undefined;
    const phase = phaseLine(state);
    const readiness = readinessLine(state);
    if (!initialized) out(formatStatus(state));
    else {
      if (phase !== lastPhase) out(`[${stamp()}] ${phase}`);
      if (readiness !== lastReadiness) out(`[${stamp()}] ${readiness}`);
      for (const event of [...state.activity].reverse()) {
        if (!seen.has(eventKey(event))) out(eventLine(event));
      }
    }
    for (const event of state.activity) seen.add(eventKey(event));
    while (seen.size > 2000) seen.delete(seen.values().next().value);
    lastPhase = phase;
    lastReadiness = readiness;
    initialized = true;
  }
  try {
    if (signal.aborted) return EXIT.OK;
    await poll();
    if (signal.aborted) return EXIT.OK;
    await new Promise((resolve) => {
      let busy = false;
      const timer = setInterval(async () => {
        if (busy || signal.aborted) return;
        busy = true;
        try { await poll(); }
        catch (error) {
          if (!signal.aborted && error.message !== lastFailure) {
            err(`[${stamp()}] ${clean(error.message)} Yalnızca durum okuma yeniden denenecek.`);
            lastFailure = error.message;
          }
        } finally { busy = false; }
      }, pollMs);
      const finish = () => { clearInterval(timer); signal.removeEventListener('abort', finish); resolve(); };
      signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted) finish();
    });
    return EXIT.OK;
  } catch (error) {
    if (signal.aborted) return EXIT.OK;
    throw error;
  } finally {
    out('İzleme kapandı. Uçuşa durdurma komutu gönderilmedi.');
  }
}

export async function runCli(args = [], options = {}) {
  if (args[0] === 'markets') return runMarketCli(args.slice(1), options);
  const out = options.out ?? console.log;
  const err = options.err ?? console.error;
  if (args.length === 1 && ['--help', '-h', 'help', 'yardim', 'yardım'].includes(args[0])) {
    out(HELP);
    return EXIT.OK;
  }
  const command = COMMANDS.get((args[0] ?? 'status').toLocaleLowerCase('tr-TR'));
  if (!command || args.length > 1) {
    err('Kullanım hatası. Komutları görmek için: RoutePilot-CLI.cmd --help');
    return EXIT.USAGE;
  }
  try {
    const client = createClient(options);
    if (command === 'status') out(formatStatus(await client.state()));
    else if (command === 'watch') {
      const controller = new AbortController();
      const cancel = () => controller.abort();
      if (!options.signal) {
        process.on('SIGINT', cancel);
        process.on('SIGTERM', cancel);
      }
      try {
        return await watch(client, { out, err, signal: options.signal ?? controller.signal, pollMs: options.pollMs ?? 1000 });
      } finally {
        if (!options.signal) {
          process.removeListener('SIGINT', cancel);
          process.removeListener('SIGTERM', cancel);
        }
      }
    } else {
      const result = await client.command(command);
      out(`İstek kabul edildi: ${clean(result.message)}`);
      if (command !== 'shutdown') out('Sonucu görmek için: RoutePilot-CLI.cmd durum veya RoutePilot-CLI.cmd izle');
    }
    return EXIT.OK;
  } catch (error) {
    const code = error.exitCode ?? EXIT.REJECTED;
    err(`Hata (çıkış kodu ${code}): ${clean(error.message)}`);
    if (error.uncertain) err('Komutun sonucu doğrulanamadı; otomatik tekrar gönderilmedi. Yeniden denemeden önce durum komutuyla kontrol edin.');
    return code;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
