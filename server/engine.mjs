import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';

const statuses = new Set(['offline', 'loading', 'ready', 'running', 'stopped', 'completed', 'error']);
const phases = new Set(['idle', 'align', 'jump', 'refuel', 'clearance', 'depart', 'complete', 'paused', 'error']);

export async function stopOwnedProcess(child, { platform = process.platform, spawnCommand = spawn } = {}) {
  // A Windows venv launcher can own the native Python worker as a child. Kill
  // that exact owned tree, never all python.exe processes or a saved stale PID.
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) throw new Error('Motor işlem kimliği doğrulanamadı.');
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (platform !== 'win32') { child.kill('SIGKILL'); return; }
  const taskkill = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
  await new Promise((resolve, reject) => {
    const command = spawnCommand(taskkill, ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true, stdio: 'ignore', timeout: 5000 });
    command.once('error', reject);
    command.once('close', (code) => {
      if (code === 0 || child.exitCode !== null || child.signalCode !== null) resolve();
      else reject(new Error(`Motor işlem ağacı kapatılamadı (taskkill ${code}).`));
    });
  });
}

export class EngineController extends EventEmitter {
  constructor({ root, engineRoot = 'D:/GameDev/Projects/EDAPGui', spawnWorker, stopProcess = stopOwnedProcess,
    eligibility = () => ({ ok: false, reason: 'Başlatma koşulları doğrulanamadı.' }) } = {}) {
    super();
    this.root = root;
    this.engineRoot = engineRoot;
    this.eligibility = eligibility;
    this.stopProcess = stopProcess;
    this.spawnWorker = spawnWorker ?? (() => spawn(path.join(engineRoot, 'venv', 'Scripts', 'python.exe'),
      ['-u', path.join(root, 'bridge', 'worker.py'), '--engine-root', engineRoot],
      { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' } }));
    this.state = { status: 'offline', phase: 'idle', message: 'Uçuş motoru henüz başlatılmadı.', connected: false };
    this.child = null;
    this.workerReady = false;
    this.pendingStart = false;
    this.sentStart = false;
    this.sequence = 0;
    this.requests = new Map();
    this.activity = [];
    this.closing = false;
    this.addActivity('info', 'RoutePilot hazır', 'Oyun verileri okunuyor; uçuş motoru yalnızca Başlat ile açılır.');
  }

  addActivity(level, title, detail, time = new Date().toISOString()) {
    const item = { id: ++this.sequence, time, level: ['info', 'success', 'warning', 'error'].includes(level) ? level : 'info',
      title: String(title ?? ''), detail: String(detail ?? '') };
    this.activity.unshift(item);
    this.activity.length = Math.min(this.activity.length, 80);
    this.emit('activity', item);
  }

  launch() {
    if (this.child || this.closing) return;
    this.workerReady = false;
    this.state = { status: 'loading', phase: 'idle', message: 'Uçuş motoru yükleniyor; iptal etmek için Durdur.', connected: false };
    this.addActivity('info', 'Motor yükleniyor', 'Modeller ve kayıtlı gemi ayarları hazırlanıyor.');
    fs.mkdirSync(path.join(this.root, 'work'), { recursive: true });
    const log = fs.createWriteStream(path.join(this.root, 'work', `worker-${new Date().toISOString().replace(/[:.]/g, '-')}.log`), { flags: 'a' });
    log.on('error', () => {});
    let child;
    try { child = this.spawnWorker(); }
    catch (error) { log.end(); this.fail(`Motor başlatılamadı: ${error.message}`); return; }
    this.child = child;
    child.stderr?.on('data', (data) => log.write(data));
    child.stdin?.on('error', (error) => this.fail(`Motor bağlantısı kesildi: ${error.message}`));
    const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    reader.on('line', (line) => {
      if (line.length > 1024 * 1024) { log.write('Oversized worker protocol line ignored.\n'); return; }
      try { this.receive(JSON.parse(line)); }
      catch { log.write(`Invalid worker protocol: ${line.slice(0, 2000)}\n`); }
    });
    child.once('error', (error) => this.fail(`Motor başlatılamadı: ${error.message}`));
    let finished = false;
    const finish = (code, signal) => {
      if (finished) return;
      finished = true;
      reader.close();
      log.end();
      if (this.child !== child) return;
      this.child = null;
      this.workerReady = false;
      this.pendingStart = false;
      this.sentStart = false;
      this.requests.clear();
      if (this.closing) this.state = { status: 'offline', phase: 'idle', message: 'Motor kapatıldı.', connected: false };
      else if (this.state.status !== 'error') this.fail(`Uçuş motoru kapandı (${signal ?? code ?? 'bilinmiyor'}). Yeniden başlatmak için Başlat düğmesini kullanın.`);
      else this.state.connected = false;
      this.emit('exit');
    };
    // close follows drained stdio. An exit event alone can precede the final
    // error JSON and stderr diagnostics. Failed spawn also emits error+close.
    child.once('close', finish);
  }

  fail(message) {
    this.workerReady = false;
    this.pendingStart = false;
    this.sentStart = false;
    this.state = { status: 'error', phase: 'error', message, connected: false };
    this.addActivity('error', 'Motor durdu', message);
  }

  receive(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'event') {
      this.addActivity(message.level, message.title, message.detail, message.time);
      return;
    }
    if (message.type === 'result') {
      const action = this.requests.get(message.id);
      this.requests.delete(message.id);
      if (action === 'start') this.sentStart = false;
      if (message.ok === false) {
        this.addActivity('error', 'İşlem tamamlanamadı', message.message ?? 'Motor komutu reddetti.');
        if (action === 'start') this.state = { ...this.state, status: 'stopped', phase: 'paused', message: message.message ?? 'Başlatılamadı.' };
      }
      if (action === 'save' && message.ok === true) this.addActivity('success', 'Ayarlar kaydedildi', message.message ?? 'Öğrenilen gemi ayarları korundu.');
      return;
    }
    if (message.type !== 'state' || !statuses.has(message.status)) return;
    // Stop can arrive while Python is still loading; only its explicit ready
    // handshake proves initialization. A later flight error is recoverable.
    if (message.status === 'ready') this.workerReady = true;
    if (message.status === 'offline') this.workerReady = false;
    this.state = { status: message.status, phase: phases.has(message.phase) ? message.phase : 'idle',
      message: typeof message.message === 'string' ? message.message : this.state.message,
      connected: this.workerReady };
    if (['error', 'offline', 'completed', 'stopped'].includes(message.status)) {
      this.pendingStart = false;
      this.sentStart = false;
    }
    if (message.status === 'running') this.sentStart = false;
    if (message.status === 'ready' && this.pendingStart && !this.closing) {
      this.pendingStart = false;
      const eligibility = this.eligibility();
      if (!eligibility.ok) {
        this.state = { ...this.state, status: 'stopped', phase: 'paused', message: eligibility.reason };
        this.addActivity('warning', 'Başlatma iptal edildi', eligibility.reason);
      } else this.sendStart();
    }
  }

  send(action) {
    if (!this.child || this.child.stdin.destroyed || !this.child.stdin.writable) throw new Error('Uçuş motoruna bağlantı yok.');
    const id = `command-${++this.sequence}`;
    this.requests.set(id, action);
    this.child.stdin.write(`${JSON.stringify({ id, action })}\n`);
    return id;
  }

  sendStart() {
    this.sentStart = true;
    try { this.send('start'); }
    catch (error) { this.fail(error.message); return false; }
    this.state.message = 'Başlatma komutu gönderildi; kokpit koşulları doğrulanıyor.';
    this.addActivity('info', 'Uçuş istendi', 'Rota motoru son kontrolleri yapıyor.');
    return true;
  }

  command(action) {
    if (this.closing) return { status: 409, ok: false, message: 'RoutePilot kapanıyor.' };
    if (action === 'start') {
      if (this.pendingStart || this.sentStart || ['loading', 'running'].includes(this.state.status)) {
        return { status: 409, ok: false, message: 'Uçuş zaten çalışıyor veya hazırlanıyor.' };
      }
      const eligibility = this.eligibility();
      if (!eligibility.ok) return { status: 409, ok: false, message: eligibility.reason };
      if (!this.child) {
        this.pendingStart = true;
        this.launch();
        if (this.state.status === 'error') return { status: 503, ok: false, message: this.state.message };
      }
      else if (this.workerReady && this.state.connected) {
        if (!this.sendStart()) return { status: 503, ok: false, message: this.state.message };
      }
      else return { status: 409, ok: false, message: 'Motor hazır değil. Motor hatasını giderip yeniden başlatın.' };
      return { status: 202, ok: true, message: 'Başlatma isteği alındı. Elite Dangerous görünür ve önde kalmalı.' };
    }
    if (action === 'stop') {
      this.pendingStart = false;
      this.sentStart = false;
      if (this.child) {
        try { this.send('stop'); } catch (error) { this.fail(error.message); }
      }
      if (this.state.status === 'loading') this.state.message = 'Başlatma iptal edildi; motor uçuşa geçmeyecek.';
      else if (this.state.status !== 'error') this.state = { ...this.state, status: 'stopped', phase: 'paused', message: 'Durdurma istendi. Gerekirse oyunda X ile gazı sıfırlayın.' };
      this.addActivity('warning', 'Durdurma istendi', 'Bekleyen başlatma iptal edildi; motorun giriş durdurucusu çağrıldı.');
      return { status: 200, ok: true, message: 'Durdurma komutu gönderildi.' };
    }
    if (action === 'save') {
      if (!this.child || !this.state.connected) return { status: 409, ok: false, message: 'Ayarları kaydetmek için motorun hazır olması gerekir.' };
      try { this.send('save'); return { status: 202, ok: true, message: 'Kaydetme isteği gönderildi.' }; }
      catch (error) { return { status: 503, ok: false, message: error.message }; }
    }
    return { status: 400, ok: false, message: 'Geçersiz komut.' };
  }

  async close(timeoutMs = 8000) {
    if (this.closing) return;
    this.closing = true;
    this.pendingStart = false;
    const child = this.child;
    if (!child) return;
    try { this.send('stop'); this.send('shutdown'); } catch { /* Exit still enforces process cleanup. */ }
    await new Promise((resolve) => {
      let timer;
      const done = () => { clearTimeout(timer); child.removeListener('close', done); resolve(); };
      child.once('close', done);
      timer = setTimeout(async () => {
        if (this.child === child) {
          this.addActivity('warning', 'Motor zorunlu kapatılıyor', 'Normal kapanış tamamlanmadı; yalnızca bu motorun işlem ağacı sonlandırılıyor.');
          try { await this.stopProcess(child); }
          catch (error) { this.fail(error.message); }
        }
        done();
      }, timeoutMs);
    });
  }
}
