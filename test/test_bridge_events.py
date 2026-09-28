from contextlib import redirect_stderr
from io import StringIO
import unittest

from bridge.runtime import EngineRuntime


class EventTests(unittest.TestCase):
    def setUp(self):
        self.runtime = EngineRuntime.__new__(EngineRuntime)
        self.runtime.active = True
        self.runtime._last_phase_message = None
        self.messages = []
        self.runtime.emit = self.messages.append

    def test_phase_event_explains_action_once_per_change(self):
        self.runtime.callback("statusline", "Verifying outward star heading")
        self.runtime.callback("statusline", "Verifying outward star heading")
        events = [m for m in self.messages if m["type"] == "event"]
        self.assertEqual(len(events), 1)
        self.assertIn("Gaz sıfırda", events[0]["detail"])
        self.assertIn("Motor:", events[0]["detail"])
        self.assertEqual(self.messages[0]["phase"], "clearance")

    def test_steering_samples_only_reach_diagnostics(self):
        stream = StringIO()
        with redirect_stderr(stream):
            for _ in range(100):
                self.runtime.callback("log", "Added a point to the SCSpeed50 Pitch curve at 1 deg, 9.73 deg/s.")
                self.runtime.callback("log", "Pitch demand: 1.0. Interp value: 9.73 deg/s")
        self.assertEqual(self.messages, [])
        self.assertIn("Interp value", stream.getvalue())

    def test_refuel_success_has_turkish_title_and_raw_diagnostic(self):
        with redirect_stderr(StringIO()):
            self.runtime.callback("log", "Refueling complete")
        self.assertEqual(self.messages[0]["title"], "Yakıt deposu doldu")
        self.assertIn("Refueling complete", self.messages[0]["detail"])

    def test_sc_callback_never_starts_or_claims_another_assist(self):
        self.runtime.callback("sc_start")
        self.assertEqual(self.messages, [])
