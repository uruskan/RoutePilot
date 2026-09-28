import threading
import time
import unittest

from bridge.controller import Controller
from bridge.runtime import guarded_keys_class


def eventually(predicate, timeout=2):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return
        time.sleep(0.005)
    raise AssertionError("Timed out waiting for isolated worker")


class FakeRuntime:
    def __init__(self, permit, emit, cancelled):
        self.permit = permit
        self.runs = self.saves = self.stops = self.hooks = 0
        self.entered = threading.Event()
        self.finish = threading.Event()
        self.validated = threading.Event()
        self.validation_block = None
        self.invalid = False

    def register_stop(self, callback):
        self.hooks += 1

    def validate_start(self):
        self.validated.set()
        if self.validation_block:
            self.validation_block.wait(2)
        if self.invalid:
            raise RuntimeError("No route")

    def run(self):
        self.runs += 1
        self.entered.set()
        self.finish.wait(2)
        return "completed", "done"

    def stop(self, reason):
        self.stops += 1
        self.permit.clear()

    def save(self):
        self.saves += 1

    def close(self):
        self.stop("close")


class ControllerTests(unittest.TestCase):
    def make_controller(self, loading=None, probe=False):
        self.messages = []
        self.runtime = None
        def factory(*args):
            if loading:
                loading.wait(2)
            self.runtime = FakeRuntime(*args)
            return self.runtime
        self.control = Controller(factory, self.messages.append, probe=probe)
        self.control.start()
        self.addCleanup(self.cleanup)
        return self.control

    def cleanup(self):
        self.control.disconnect()
        if self.runtime:
            self.runtime.finish.set()
        self.control.thread.join(3)

    def ready(self):
        self.assertTrue(self.control.ready.wait(2))

    def test_initialization_never_starts_a_route(self):
        control = self.make_controller()
        self.ready()
        self.assertFalse(control.permit.is_set())
        self.assertEqual(self.runtime.runs, 0)
        self.assertEqual(self.runtime.hooks, 1)

    def test_stop_during_loading_cancels_pending_start(self):
        loading = threading.Event()
        control = self.make_controller(loading)
        control.command({"id": "start", "action": "start"})
        control.command({"id": "stop", "action": "stop"})
        loading.set()
        self.ready()
        eventually(lambda: control.commands.empty())
        self.assertEqual(self.runtime.runs, 0)
        self.assertTrue(any(m.get("id") == "start" and not m["ok"] for m in self.messages))

    def test_stop_between_validation_and_arming_cannot_start(self):
        control = self.make_controller()
        self.ready()
        block = self.runtime.validation_block = threading.Event()
        control.command({"id": "start", "action": "start"})
        self.assertTrue(self.runtime.validated.wait(1))
        control.stop("cancel")
        block.set()
        eventually(lambda: not control.busy)
        self.assertEqual(self.runtime.runs, 0)
        self.assertFalse(control.permit.is_set())

    def test_stop_immediately_closes_input_lease_and_saves_after_drain(self):
        control = self.make_controller()
        self.ready()
        control.command({"id": "start", "action": "start"})
        self.assertTrue(self.runtime.entered.wait(1))
        control.command({"id": "stop", "action": "stop"})
        self.assertFalse(control.permit.is_set())
        self.assertEqual(self.runtime.saves, 0)
        control.command({"id": "second", "action": "start"})
        self.runtime.finish.set()
        eventually(lambda: not control.busy)
        self.assertEqual(self.runtime.runs, 1)
        self.assertEqual(self.runtime.saves, 1)
        self.assertEqual(control.state["status"], "stopped")

    def test_completed_route_saves_and_never_auto_restarts(self):
        control = self.make_controller()
        self.ready()
        self.runtime.finish.set()
        control.command({"id": "one", "action": "start"})
        eventually(lambda: control.state["status"] == "completed")
        self.assertEqual(self.runtime.runs, 1)
        self.assertEqual(self.runtime.saves, 1)
        self.assertFalse(control.permit.is_set())

    def test_disconnect_cancels_loading_and_never_arms(self):
        loading = threading.Event()
        control = self.make_controller(loading)
        control.command({"id": "start", "action": "start"})
        control.disconnect()
        loading.set()
        control.thread.join(2)
        self.assertEqual(self.runtime.runs, 0)
        self.assertFalse(control.permit.is_set())

    def test_probe_cannot_start_and_installs_no_hotkey(self):
        control = self.make_controller(probe=True)
        self.ready()
        control.command({"id": "start", "action": "start"})
        self.assertEqual(self.runtime.runs, 0)
        self.assertEqual(self.runtime.hooks, 0)
        self.assertFalse(self.messages[-1]["ok"])

    def test_failed_validation_never_arms(self):
        control = self.make_controller()
        self.ready()
        self.runtime.invalid = True
        control.command({"id": "start", "action": "start"})
        eventually(lambda: control.state["status"] == "error")
        self.assertFalse(control.permit.is_set())
        self.assertEqual(self.runtime.runs, 0)

    def test_malformed_command_does_not_kill_reader(self):
        control = self.make_controller()
        self.ready()
        for value in [[], None, {"id": {}, "action": "start"}, {"id": 1, "action": []}]:
            control.command(value)
        self.assertEqual(self.runtime.runs, 0)

    def test_failed_initialization_rejects_pending_start(self):
        barrier = threading.Event()
        messages = []
        def fail(*args):
            barrier.wait(1)
            raise RuntimeError("Initialization failed")
        control = Controller(fail, messages.append)
        control.start()
        control.command({"id": "pending", "action": "start"})
        barrier.set()
        control.thread.join(2)
        self.assertEqual(control.state["status"], "error")
        self.assertFalse(control.permit.is_set())
        self.assertEqual(control.pending, {})
        self.assertTrue(any(m.get("id") == "pending" and m.get("ok") is False for m in messages))
        control.disconnect()

    def test_heartbeat_reports_loading_without_arming(self):
        loading = threading.Event()
        control = self.make_controller(loading)
        eventually(lambda: len([m for m in self.messages if m.get("status") == "loading"]) >= 2, 1.5)
        self.assertFalse(control.permit.is_set())
        loading.set()
        self.ready()

    def test_main_thread_initialization_still_accepts_stop_during_loading(self):
        entered, release = threading.Event(), threading.Event()
        caller = threading.current_thread()
        runtimes = []
        def factory(*args):
            self.assertIs(threading.current_thread(), caller)
            entered.set()
            self.assertTrue(release.wait(1))
            runtime = FakeRuntime(*args)
            runtimes.append(runtime)
            return runtime
        control = Controller(factory, lambda _: None)
        def simulated_stdin():
            entered.wait(1)
            control.command({"id": "start", "action": "start"})
            control.command({"id": "stop", "action": "stop"})
            release.set()
            control.ready.wait(1)
            control.command({"id": "shutdown", "action": "shutdown"})
        reader = threading.Thread(target=simulated_stdin)
        reader.start()
        control.start(inline=True)
        reader.join(1)
        self.assertFalse(reader.is_alive())
        self.assertTrue(control.finished.is_set())
        self.assertFalse(control.permit.is_set())
        self.assertEqual(runtimes[0].runs, 0)


class BaseKeys:
    def __init__(self):
        self._pressed_keys = set()
        self.events = []

    def _require_foreground(self):
        self.events.append("foreground_checked")

    def _prepare_input(self):
        self._require_foreground()

    def _release_key(self, key):
        self.events.append(("release", key))
        self._pressed_keys.discard(key)

    def send(self, binding, **kwargs):
        self._prepare_input()
        self.events.append((binding, kwargs))


class LeaseTests(unittest.TestCase):
    def setUp(self):
        self.permit = threading.Event()
        self.keys = guarded_keys_class(BaseKeys, RuntimeError, self.permit)()

    def test_readiness_or_cancelled_start_cannot_send(self):
        with self.assertRaises(RuntimeError):
            self.keys.send("SetSpeed100")
        self.assertEqual(self.keys.events, [])

    def test_no_keyup_in_probe_unless_key_is_actually_owned(self):
        self.keys._release_key(1)
        self.assertEqual(self.keys.events, [])
        self.keys._pressed_keys.add(1)
        self.keys._release_key(1)
        self.assertEqual(self.keys.events, [("release", 1)])

    def test_active_lease_keeps_original_foreground_check(self):
        self.permit.set()
        self.keys.send("PitchUpButton", hold=0.25)
        self.assertEqual(self.keys.events[0], "foreground_checked")
        self.permit.clear()
        with self.assertRaises(RuntimeError):
            self.keys.send("PitchUpButton")

    def test_invalid_hold_never_reaches_injection(self):
        self.permit.set()
        for value in [-1, float("nan"), float("inf")]:
            with self.assertRaises(RuntimeError):
                self.keys.send("PitchUpButton", hold=value)
        self.assertEqual(self.keys.events, [])


if __name__ == "__main__":
    unittest.main()
