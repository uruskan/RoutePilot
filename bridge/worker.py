"""JSONL entry point. --check is static; --probe initializes with flight disabled."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import threading

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bridge.controller import Controller
from bridge.pipe_input import pipe_lines
from bridge.settings import SettingsStore


class InstanceLock:
    def __init__(self, engine_root):
        self.path = Path(engine_root) / ".aster/instance.lock"
        self.stream = None

    def __enter__(self):
        import msvcrt
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.stream = self.path.open("a+b")
        self.stream.seek(0)
        try:
            msvcrt.locking(self.stream.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as exc:
            self.stream.close()
            self.stream = None
            raise RuntimeError("EDAP zaten açık. Önce eski EDAP penceresini kapatın; ikinci uçuş motoru başlatılmadı.") from exc
        return self

    def __exit__(self, *args):
        if self.stream:
            import msvcrt
            self.stream.seek(0)
            msvcrt.locking(self.stream.fileno(), msvcrt.LK_UNLCK, 1)
            self.stream.close()


def static_check(root):
    root = Path(root).resolve()
    required = ("ED_AP.py", "aster_launch.py", "configs/AP.json", "configs/ship_configs.json",
                "configs/ocr_calibration.json", "venv/Scripts/python.exe",
                "Yolo26/compass-model/weights/best.pt", "Yolo26/target-model/weights/best.pt")
    missing = [name for name in required if not (root / name).is_file()]
    if missing:
        raise RuntimeError("Eksik motor dosyaları: " + ", ".join(missing))
    store = SettingsStore(root)
    return {"type": "event", "level": "success", "title": "Statik denetim tamamlandı",
            "detail": f"Dosyalar bulundu; {len(store.removed)} geçersiz kalibrasyon noktası filtrelenecek. Motor yüklenmedi; giriş gönderilmedi."}


def shutdown_watchdog(controller, disconnected, exit_now=os._exit, grace=5.0):
    """Remain responsive even if main-thread native initialization has stalled."""
    while not controller.closed.wait(0.1):
        if disconnected.is_set():
            controller.disconnect()
        if controller.failure:
            controller.closed.set()
        if controller.finished.is_set():
            return
    if not controller.finished.wait(grace):
        controller.emit({"type": "event", "level": "warning", "title": "Motor kapatılıyor",
                         "detail": "Girişler durdu; yerel model çağrısı bitmediği için son kayıt tamamlanamadı."})
        # The shared instance lock stays held until the whole process dies.
        exit_now(2)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine-root", required=True)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--probe", action="store_true")
    options = parser.parse_args(argv)
    # Keep a private protocol descriptor; C/Paddle/Torch prints to fd1 go to stderr.
    protocol = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", buffering=1)
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr
    output_lock = threading.Lock()
    disconnected = threading.Event()
    controller = None

    def emit(item):
        try:
            with output_lock:
                protocol.write(json.dumps(item, ensure_ascii=False, allow_nan=False) + "\n")
                protocol.flush()
        except (BrokenPipeError, OSError):
            disconnected.set()
            if controller:
                controller.permit.clear()

    try:
        checked = static_check(options.engine_root)
        if options.check:
            # Also verify the shared lock without loading any game-facing code.
            with InstanceLock(options.engine_root):
                emit(checked)
            return 0
        with InstanceLock(options.engine_root):
            from bridge.runtime import EngineRuntime
            controller = Controller(lambda permit, output, cancelled: EngineRuntime(
                options.engine_root, permit, output, cancelled), emit, probe=options.probe)

            def reader():
                try:
                    for raw_line in pipe_lines(sys.stdin, controller.closed):
                        try:
                            line = raw_line.decode("utf-8-sig")
                            command = json.loads(line)
                        except (ValueError, UnicodeError):
                            emit({"type": "result", "id": None, "ok": False, "message": "Geçersiz JSON komutu."})
                            continue
                        controller.command(command)
                        if controller.closed.is_set():
                            return
                except (OSError, ValueError) as exc:
                    emit({"type": "event", "level": "error", "title": "Komut bağlantısı kapandı", "detail": str(exc)})
                finally:
                    if not controller.closed.is_set():
                        controller.disconnect()
            threading.Thread(target=reader, name="RoutePilotStdin", daemon=True).start()
            threading.Thread(target=shutdown_watchdog, args=(controller, disconnected),
                             name="RoutePilotShutdown", daemon=True).start()
            # Import/construct/operate the engine on the process main thread.
            # Stdin, heartbeat, stop-latch and shutdown timeout remain independent.
            controller.start(inline=True)
            return 1 if controller.failure else 0
    except Exception as exc:
        emit({"type": "state", "status": "error", "phase": "error", "message": str(exc)})
        return 1


if __name__ == "__main__":
    exit_code = main()
    # Some upstream/native helpers outlive quit; no process may retain a game lease.
    sys.stderr.flush()
    os._exit(exit_code)
