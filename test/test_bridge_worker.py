import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest

from bridge.worker import InstanceLock, shutdown_watchdog
from bridge.controller import Controller


class WatchdogTests(unittest.TestCase):
    def test_stalled_initialization_has_bounded_shutdown(self):
        output, exits = [], []
        control = Controller(None, output.append)
        control.permit.set()
        control.command({"id": "shutdown", "action": "shutdown"})
        shutdown_watchdog(control, threading.Event(), exit_now=exits.append, grace=0.01)
        self.assertEqual(exits, [2])
        self.assertFalse(control.permit.is_set())
        self.assertTrue(any(item.get("level") == "warning" for item in output))

    def test_clean_shutdown_does_not_force_exit(self):
        exits = []
        control = Controller(None, lambda _: None)
        control.closed.set()
        control.finished.set()
        shutdown_watchdog(control, threading.Event(), exit_now=exits.append, grace=0.01)
        self.assertEqual(exits, [])


@unittest.skipUnless(os.name == "nt", "Shared EDAP lock uses Windows msvcrt")
class WorkerTests(unittest.TestCase):
    def fixture(self, root):
        for name in ("ED_AP.py", "aster_launch.py", "configs/AP.json", "configs/ship_configs.json",
                     "configs/ocr_calibration.json", "venv/Scripts/python.exe",
                     "Yolo26/compass-model/weights/best.pt", "Yolo26/target-model/weights/best.pt"):
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("", encoding="utf-8")
        # A static check must never import this deliberately poisonous module.
        (root / "ED_AP.py").write_text("raise RuntimeError('ENGINE WAS IMPORTED')")
        (root / "configs/AP.json").write_text("{}")
        (root / "configs/ship_configs.json").write_text('{"Ship_Configs": {}}')

    def command(self, root):
        worker = Path(__file__).resolve().parents[1] / "bridge/worker.py"
        return [sys.executable, str(worker), "--engine-root", str(root), "--check"]

    def test_static_check_outputs_only_json_and_never_imports_engine(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.fixture(root)
            process = subprocess.run(self.command(root), capture_output=True, text=True, encoding="utf-8", timeout=5)
            self.assertEqual(process.returncode, 0, process.stderr)
            messages = [json.loads(line) for line in process.stdout.splitlines()]
            self.assertEqual(len(messages), 1)
            self.assertEqual(messages[0]["type"], "event")
            self.assertNotIn("ED_AP", sys.modules)

    def test_second_process_cannot_take_shared_instance_lock(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.fixture(root)
            with InstanceLock(root):
                process = subprocess.run(self.command(root), capture_output=True, text=True, encoding="utf-8", timeout=5)
            self.assertEqual(process.returncode, 1)
            state = json.loads(process.stdout.strip())
            self.assertEqual(state["status"], "error")
            self.assertIn("EDAP zaten açık", state["message"])


if __name__ == "__main__":
    unittest.main()
