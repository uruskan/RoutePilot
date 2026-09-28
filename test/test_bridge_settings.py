import copy
import json
from pathlib import Path
import tempfile
import unittest

from bridge.settings import SettingsStore, normalize_curves, valid_sample


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.data = {"Ship_Configs": {"mandalay": {"SCSpeed50": {"PitchRate": {
            "0.0": 0.0, "0.5": 0.0, "1.0": 9.73, "30.0": 41.8}},
            "SCSpeed0": {"RollRate": {"1.25": 348.48, "7.0": 348.48}}}}}

    def test_only_provably_invalid_points_removed(self):
        original = copy.deepcopy(self.data)
        result, removed = normalize_curves(self.data)
        self.assertEqual(len(removed), 2)
        self.assertEqual(result["Ship_Configs"]["mandalay"]["SCSpeed50"]["PitchRate"], {"1.0": 9.73, "30.0": 41.8})
        self.assertEqual(result["Ship_Configs"]["mandalay"]["SCSpeed0"], original["Ship_Configs"]["mandalay"]["SCSpeed0"])
        self.assertEqual(self.data, original)

    def test_nonfinite_negative_and_bool_samples_rejected(self):
        for angle, rate in [(0, 0), (1, -1), (1, float("nan")), (1, float("inf")), (-1, 10), (1, True)]:
            self.assertFalse(valid_sample(angle, rate))

    def test_empty_curve_fails_without_guessed_replacement(self):
        self.data["Ship_Configs"]["mandalay"]["SCSpeed50"]["PitchRate"] = {"1": 0}
        with self.assertRaises(ValueError):
            normalize_curves(self.data)

    def files(self, temp):
        root = Path(temp)
        (root / "configs").mkdir()
        (root / "configs/AP.json").write_text('{"FSDJumpLimit": 0, "RefuelThreshold": 100}')
        path = root / "configs/ship_configs.json"
        path.write_text(json.dumps(self.data))
        return root, path

    def test_read_does_not_write_save_backs_up_exact_original(self):
        with tempfile.TemporaryDirectory() as temp:
            root, path = self.files(temp)
            original = path.read_bytes()
            ap_original = (root / "configs/AP.json").read_bytes()
            store = SettingsStore(root)
            self.assertEqual(path.read_bytes(), original)
            backup = store.save(store.ships)
            self.assertEqual(backup.read_bytes(), original)
            self.assertNotIn("0.5", json.loads(path.read_bytes())["Ship_Configs"]["mandalay"]["SCSpeed50"]["PitchRate"])
            self.assertEqual((root / "configs/AP.json").read_bytes(), ap_original)
            self.assertIsNone(store.save(store.ships))

    def test_concurrent_external_edit_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            root, path = self.files(temp)
            store = SettingsStore(root)
            path.write_text('{"user": "edit"}')
            with self.assertRaises(RuntimeError):
                store.save(store.ships)
            self.assertEqual(path.read_text(), '{"user": "edit"}')


if __name__ == "__main__":
    unittest.main()
