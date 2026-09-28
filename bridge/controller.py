"""Responsive command lifecycle; unit tests use an injected, input-free engine."""
from __future__ import annotations

import queue
import threading


class Controller:
    def __init__(self, factory, emit, probe=False):
        self.output = emit
        self.factory = factory
        self.probe = probe
        self.permit = threading.Event()
        self.closed = threading.Event()
        self.ready = threading.Event()
        self.finished = threading.Event()
        self.lock = threading.RLock()
        self.commands = queue.Queue()
        self.runtime = None
        self.generation = 0
        self.pending = {}
        self.busy = False
        self.failure = None
        self.state = {"type": "state", "status": "loading", "phase": "idle", "message": "Uçuş motoru hazırlanıyor; girişler kapalı."}
        self.thread = threading.Thread(target=self._work, name="RoutePilotControl", daemon=True)
        self.heartbeat = threading.Thread(target=self._heartbeat, name="RoutePilotHeartbeat", daemon=True)

    def emit(self, item):
        with self.lock:
            if item.get("type") == "state":
                if item.get("status") == "running" and not self.permit.is_set():
                    return
                self.state = dict(item)
            self.output(item)

    def set_state(self, status, message, phase="idle"):
        self.emit({"type": "state", "status": status, "phase": phase, "message": message})

    def result(self, command_id, ok, message):
        self.emit({"type": "result", "id": command_id, "ok": ok, "message": message})

    def start(self, inline=False):
        self.emit(self.state)
        self.heartbeat.start()
        if inline:
            # Native DLL initialization (notably NumPy on this Windows host)
            # and MSS capture must live on the same process main thread.
            self.thread = threading.current_thread()
            self._work()
        else:
            self.thread.start()

    def _heartbeat(self):
        while not self.closed.wait(1):
            with self.lock:
                self.output(dict(self.state))

    def command(self, command):
        command_id = command.get("id") if isinstance(command, dict) else None
        action = command.get("action") if isinstance(command, dict) else None
        if (not isinstance(action, str) or action not in {"start", "stop", "save", "shutdown"}
                or type(command_id) not in (str, int) or len(str(command_id)) > 128):
            self.result(command_id, False, "Desteklenmeyen komut.")
            return
        if action in {"stop", "shutdown"}:
            self.stop("Uçuş durduruldu; yeniden başlatma otomatik değildir.")
            if action == "shutdown":
                self.closed.set()
                self.commands.put(None)
            self.result(command_id, True, "Girişler durduruldu." if action == "stop" else "Motor kapatılıyor.")
            return
        with self.lock:
            if self.closed.is_set() or self.failure:
                self.result(command_id, False, self.failure or "Motor kapanıyor.")
            elif self.probe and action == "start":
                self.result(command_id, False, "Hazırlık denemesinde uçuş başlatılamaz.")
            elif self.busy or self.pending:
                self.result(command_id, False, "Motor meşgul; uçuş bittiğinde kalibrasyon otomatik kaydedilir.")
            else:
                self.pending[command_id] = (action, self.generation)
                self.commands.put((command_id, action, self.generation))

    def stop(self, reason):
        # Clear this before any lock acquisition or potentially blocked engine call.
        self.permit.clear()
        with self.lock:
            self.generation += 1
            for command_id in list(self.pending):
                self.result(command_id, False, "Bekleyen komut durdurma isteğiyle iptal edildi.")
            self.pending.clear()
            runtime = self.runtime
            self.set_state("stopped", reason, "paused")
        if runtime:
            runtime.stop(reason)

    def disconnect(self):
        self.stop("Arayüz bağlantısı kapandı; girişler durduruldu.")
        self.closed.set()
        self.commands.put(None)

    def _save(self):
        backup = self.runtime.save()
        self.emit({"type": "event", "level": "success", "title": "Kalibrasyon kaydedildi",
                   "detail": "Öğrenilen değerler korundu." + (f" Yedek: {backup}" if backup else "")})

    def _work(self):
        try:
            if self.closed.is_set():
                return
            runtime = self.factory(self.permit, self.emit, lambda: self.closed.is_set())
            with self.lock:
                self.runtime = runtime
            if self.closed.is_set():
                return
            if not self.probe:
                runtime.register_stop(lambda: self.stop("Fiziksel Ctrl+Alt+End ile durduruldu."))
            self.ready.set()
            self.set_state("ready", "Motor hazır. Uçuş yalnızca Başlat ile çalışır.")
            while not self.closed.is_set():
                entry = self.commands.get()
                if entry is None:
                    break
                command_id, action, generation = entry
                with self.lock:
                    if command_id not in self.pending or generation != self.generation:
                        continue
                    self.pending.pop(command_id)
                    self.busy = True
                try:
                    acknowledged = False
                    if action == "save":
                        self._save()
                        self.result(command_id, True, "Kalibrasyon kaydedildi.")
                        continue
                    runtime.validate_start()
                    with self.lock:
                        if generation != self.generation or self.closed.is_set():
                            self.result(command_id, False, "Başlatma iptal edildi.")
                            continue
                        self.permit.set()
                        self.set_state("running", "Rota uçuşu başlatılıyor; Elite penceresini önde tutun.", "align")
                        self.result(command_id, True, "Rota uçuşu başlatılıyor.")
                        acknowledged = True
                    try:
                        status, message = runtime.run()
                    finally:
                        self.permit.clear()
                        runtime.stop("Uçuş döngüsü sona erdi.")
                        self._save()
                    with self.lock:
                        if generation != self.generation:
                            status, message = "stopped", "Uçuş durduruldu; öğrenilen kalibrasyon kaydedildi."
                        self.set_state(status, message, "complete" if status == "completed" else "paused")
                except Exception as exc:
                    self.permit.clear()
                    runtime.stop(str(exc))
                    self.set_state("error", str(exc), "error")
                    if not acknowledged:
                        self.result(command_id, False, str(exc))
                finally:
                    with self.lock:
                        self.busy = False
        except Exception as exc:
            self.failure = str(exc)
            self.set_state("error", self.failure, "error")
            with self.lock:
                for command_id in list(self.pending):
                    self.result(command_id, False, self.failure)
                self.pending.clear()
        finally:
            self.permit.clear()
            if self.runtime:
                try:
                    self.runtime.close()
                except Exception as exc:
                    self.emit({"type": "event", "level": "warning", "title": "Kapanış", "detail": str(exc)})
            self.finished.set()
