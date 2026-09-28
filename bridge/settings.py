"""Conservative calibration cleanup and atomic, conflict-checked persistence."""
from __future__ import annotations

import copy
import hashlib
import json
import math
import os
from pathlib import Path
import tempfile
import threading
from datetime import datetime, timezone

MODES = ("Speed0", "Speed50", "Speed100", "SCSpeed0", "SCSpeed50", "SCSpeed100")
AXES = ("RollRate", "PitchRate", "YawRate")


def valid_sample(angle, rate):
    return (type(angle) in (int, float) and math.isfinite(angle) and angle >= 0
            and type(rate) in (int, float) and math.isfinite(rate) and rate > 0)


def normalize_curves(settings):
    result = copy.deepcopy(settings)
    removed = []
    for ship, config in result.get("Ship_Configs", {}).items():
        for axis in AXES:
            if axis in config and not valid_sample(0, config[axis]):
                raise ValueError(f"{ship}/{axis}: geçerli temel dönüş hızı gerekiyor.")
        for mode in MODES:
            for axis, points in config.get(mode, {}).items():
                if axis not in AXES:
                    continue
                if not isinstance(points, dict):
                    raise ValueError(f"{ship}/{mode}/{axis}: eğri biçimi geçersiz.")
                kept = {}
                for angle, rate in points.items():
                    try:
                        number = float(angle)
                    except (TypeError, ValueError) as exc:
                        raise ValueError(f"Geçersiz kalibrasyon açısı: {angle}") from exc
                    if valid_sample(number, rate):
                        kept[angle] = rate
                    else:
                        removed.append(f"{ship}/{mode}/{axis}/{angle}")
                if not kept:
                    raise ValueError(f"{ship}/{mode}/{axis}: kullanılabilir kalibrasyon noktası yok.")
                config[mode][axis] = dict(sorted(kept.items(), key=lambda item: float(item[0])))
    return result, removed


class SettingsStore:
    def __init__(self, root):
        self.root = Path(root)
        self.lock = threading.RLock()
        self.paths = {"ap": self.root / "configs/AP.json", "ships": self.root / "configs/ship_configs.json"}
        self.original = {key: path.read_bytes() for key, path in self.paths.items()}
        self.ap = json.loads(self.original["ap"].decode("utf-8-sig"))
        self.ships, self.removed = normalize_curves(json.loads(self.original["ships"].decode("utf-8-sig")))

    def save(self, ships):
        """Called only when the route writer is quiescent; preserve all AP preferences."""
        with self.lock:
            clean, removed = normalize_curves(ships)
            # Refuse overwriting a GUI/user edit, even when it happened during flight.
            for key, path in self.paths.items():
                if path.read_bytes() != self.original[key]:
                    raise RuntimeError(f"{path.name} başka bir işlemde değişti; üzerine yazılmadı.")
            payload = (json.dumps(clean, indent=4, ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8")
            if payload == self.original["ships"]:
                return None
            backup_dir = self.root / ".aster/routepilot-backups"
            backup_dir.mkdir(parents=True, exist_ok=True)
            digest = hashlib.sha256(self.original["ships"]).hexdigest()[:12]
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
            backup = backup_dir / f"ship_configs-{stamp}-{digest}.json"
            backup.write_bytes(self.original["ships"])
            descriptor, temp = tempfile.mkstemp(prefix=".routepilot-", suffix=".json", dir=self.paths["ships"].parent)
            try:
                with os.fdopen(descriptor, "wb") as stream:
                    stream.write(payload)
                    stream.flush()
                    os.fsync(stream.fileno())
                if self.paths["ships"].read_bytes() != self.original["ships"]:
                    raise RuntimeError("Kaydetme sırasında kalibrasyon değişti; üzerine yazılmadı.")
                os.replace(temp, self.paths["ships"])
                self.original["ships"] = payload
                self.ships = clean
                self.removed = removed
            finally:
                if os.path.exists(temp):
                    os.unlink(temp)
            return backup
