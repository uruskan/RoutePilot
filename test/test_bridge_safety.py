import json
from pathlib import Path
import tempfile
import unittest

from bridge.safety import (EligibilityError, cleared_at_accepted_destination, latest_route_event,
                           require_no_old_workers, require_start, route_snapshot)
from types import SimpleNamespace
from bridge.runtime import RouteCompleted, RouteOnlyMixin


class EligibilityTests(unittest.TestCase):
    def setUp(self):
        self.route = {"event": "NavRoute", "timestamp": "2026-09-29T00:00:00Z",
                      "Route": [{"StarSystem": "A"}, {"StarSystem": "B"}]}
        self.ship = {"location": "A", "target": "B", "status": "in_supercruise"}
        self.status = {"Flags": (1 << 24) | 16, "Flags2": 0, "GuiFocus": 0}

    def check(self):
        require_start(self.status, self.ship, route_snapshot(self.route, self.ship))

    def test_valid_route_and_ship_can_start(self):
        self.check()

    def test_final_system_ignores_stale_fsd_target(self):
        self.ship["location"] = "B"
        route = route_snapshot(self.route, self.ship)
        self.assertTrue(route["complete"])
        self.assertEqual(route["remaining"], 0)
        with self.assertRaises(EligibilityError):
            self.check()

    def test_clear_in_journal_overrides_old_route_file(self):
        event = {"event": "NavRouteClear", "timestamp": "2026-09-29T00:00:01Z"}
        self.assertTrue(route_snapshot(self.route, self.ship, event)["cleared"])

    def test_new_route_journal_requires_matching_file(self):
        with self.assertRaises(EligibilityError):
            route_snapshot(self.route, self.ship, {"event": "NavRoute", "timestamp": "2026-09-29T00:00:01Z"})

    def test_off_route_and_wrong_next_target_rejected(self):
        self.ship["location"] = "C"
        with self.assertRaises(EligibilityError):
            self.check()
        self.ship.update(location="A", target="C")
        with self.assertRaises(EligibilityError):
            self.check()

    def test_unsafe_ship_states_rejected(self):
        original = dict(self.status)
        for flags, flags2, focus in [(1 | 16 | (1 << 24), 0, 0), (2 | 16 | (1 << 24), 0, 0),
                                     (16 | (1 << 26), 0, 0), (16 | (1 << 25), 0, 0),
                                     (16 | (1 << 24), 1, 0), (1 << 24, 0, 0),
                                     (16 | (1 << 24), 0, 1), (16 | (1 << 24) | (1 << 17), 0, 0)]:
            self.status.update(Flags=flags, Flags2=flags2, GuiFocus=focus)
            with self.subTest(flags=flags, flags2=flags2, focus=focus), self.assertRaises(EligibilityError):
                self.check()
        self.status = original

    def test_journal_ignores_partial_line(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "Journal.log"
            path.write_text(json.dumps({"event": "NavRouteClear"}) + '\n{"event":', encoding="utf-8")
            self.assertEqual(latest_route_event(path)["event"], "NavRouteClear")

    def test_clear_before_final_fsdjump_is_completed_only_at_accepted_destination(self):
        accepted = {"name": "B", "address": 123, "started_at": "2026-09-29T00:00:01Z",
                    "route_timestamp": "2026-09-29T00:00:00Z"}
        context = {"route": {"event": "NavRouteClear", "timestamp": "2026-09-29T00:00:10Z"},
                   "arrival": {"event": "FSDJump", "timestamp": "2026-09-29T00:00:20Z", "StarSystem": "B", "SystemAddress": 123},
                   "plot": {"event": "NavRoute", "timestamp": "2026-09-29T00:00:00Z"}}
        self.assertTrue(cleared_at_accepted_destination(accepted, {"location": "B"}, context))
        self.assertFalse(cleared_at_accepted_destination(accepted, {"location": "A"}, context))
        context["arrival"]["SystemAddress"] = 456
        self.assertFalse(cleared_at_accepted_destination(accepted, {"location": "B"}, context))

    def test_clear_after_unobserved_new_plot_or_old_jump_is_not_completion(self):
        accepted = {"name": "B", "address": 123, "started_at": "2026-09-29T00:00:01Z",
                    "route_timestamp": "2026-09-29T00:00:00Z"}
        context = {"route": {"event": "NavRouteClear", "timestamp": "2026-09-29T00:00:10Z"},
                   "arrival": {"event": "FSDJump", "timestamp": "2026-09-29T00:00:20Z", "StarSystem": "B", "SystemAddress": 123},
                   "plot": {"event": "NavRoute", "timestamp": "2026-09-29T00:00:05Z"}}
        self.assertFalse(cleared_at_accepted_destination(accepted, {"location": "B"}, context))
        context["plot"] = None
        context["arrival"]["timestamp"] = "2026-09-29T00:00:00Z"
        self.assertFalse(cleared_at_accepted_destination(accepted, {"location": "B"}, context))

    def test_stalled_old_worker_prevents_rearm(self):
        for name in ("honk_thread", "_sc_sco_active_loop_thread"):
            old = SimpleNamespace(is_alive=lambda: True)
            engine = SimpleNamespace(**{name: old})
            with self.assertRaises(EligibilityError):
                require_no_old_workers(engine)
            old.is_alive = lambda: False
            require_no_old_workers(engine)


class BaseFlight:
    def position(self, *args, **kwargs):
        self.inputs.append("full_throttle")
        return True


class FakeRoute(RouteOnlyMixin, BaseFlight):
    _routepilot_safety_error = RuntimeError

    def __init__(self, complete=False, cleared=False):
        self.inputs = []
        self.route = {"complete": complete, "cleared": cleared, "remaining": int(not complete)}

    def _routepilot_snapshot(self):
        return self.route

    def _routepilot_cancel_check(self):
        pass

    def set_throttle_0(self, **kwargs):
        self.inputs.append("zero")


class CompletionTests(unittest.TestCase):
    def test_final_arrival_unwinds_before_acceleration_or_visual_handoff(self):
        engine = FakeRoute(complete=True)
        with self.assertRaises(RouteCompleted):
            engine.position(None)
        self.assertEqual(engine.inputs, ["zero"])

    def test_visual_handoff_cannot_authorize_sc(self):
        engine = FakeRoute()
        with self.assertRaises(RuntimeError):
            engine.have_destination(None)
        self.assertEqual(engine.inputs, [])

    def test_route_clear_stops_instead_of_claiming_complete(self):
        engine = FakeRoute(cleared=True)
        with self.assertRaises(RuntimeError):
            engine.position(None)
        self.assertEqual(engine.inputs, [])

    def test_actual_departure_still_uses_upstream(self):
        engine = FakeRoute()
        self.assertTrue(engine.position(None))
        self.assertEqual(engine.inputs, ["full_throttle"])


if __name__ == "__main__":
    unittest.main()
