"""Read-only route/ship eligibility, independent of EDAP's visual target guesses."""
from __future__ import annotations

import json
from pathlib import Path


class EligibilityError(RuntimeError):
    pass


def read_json(path):
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        raise EligibilityError(f"Oyun verisi okunamıyor: {Path(path).name}") from exc
    if not isinstance(value, dict):
        raise EligibilityError("Oyun verisinin biçimi geçersiz.")
    return value


def latest_route_event(journal_path):
    return navigation_context(journal_path)["route"]


def navigation_context(journal_path):
    """Inspect complete journal records; ignore a currently incomplete final line."""
    latest = {"route": None, "plot": None, "arrival": None}
    if journal_path:
        try:
            with Path(journal_path).open(encoding="utf-8-sig") as stream:
                for line in stream:
                    try:
                        event = json.loads(line)
                    except ValueError:
                        continue
                    if event.get("event") in ("NavRoute", "NavRouteClear"):
                        latest["route"] = event
                    if event.get("event") == "NavRoute":
                        latest["plot"] = event
                    if event.get("event") == "FSDJump":
                        latest["arrival"] = event
        except OSError as exc:
            raise EligibilityError("Güncel uçuş günlüğü okunamıyor.") from exc
    return latest


def cleared_at_accepted_destination(accepted, ship, context):
    """A cleared file is success only after this run's verified final FSDJump."""
    if not accepted:
        return False
    arrival, clear, plot = context.get("arrival"), context.get("route"), context.get("plot")
    if not arrival or not clear or clear.get("event") != "NavRouteClear":
        return False
    address = accepted.get("address")
    if type(address) is not int or address <= 0:
        return False
    if (arrival.get("StarSystem") != accepted["name"] or arrival.get("SystemAddress") != address
            or ship.get("location") != accepted["name"]):
        return False
    # Elite can clear the route during the final hyperspace jump, several
    # seconds BEFORE FSDJump is written. Both must belong to this run.
    if (arrival.get("timestamp", "") < accepted["started_at"]
            or clear.get("timestamp", "") < accepted["started_at"]):
        return False
    # A later, unobserved replot might have a different destination.
    return not plot or plot.get("timestamp", "") <= accepted["route_timestamp"]


def require_no_old_workers(engine):
    for name in ("honk_thread", "_sc_sco_active_loop_thread"):
        worker = getattr(engine, name, None)
        if worker is not None and worker.is_alive():
            raise EligibilityError("Önceki uçuşun arka plan işlemi henüz bitmedi; giriş izni kapalı. Bekleyin veya motoru yeniden açın.")


def route_snapshot(route_data, ship, journal_event=None):
    """Never use stale FSDTarget as evidence of remaining route systems."""
    if journal_event and journal_event.get("timestamp", "") >= route_data.get("timestamp", ""):
        if journal_event.get("event") == "NavRouteClear":
            return {"remaining": 0, "complete": False, "cleared": True, "next": None}
    rows = route_data.get("Route")
    if route_data.get("event") != "NavRoute" or not isinstance(rows, list) or not rows:
        return {"remaining": 0, "complete": False, "cleared": True, "next": None}
    if journal_event and journal_event.get("timestamp", "") > route_data.get("timestamp", ""):
        raise EligibilityError("Yeni rota dosyasının güncellenmesi bekleniyor.")
    current = ship.get("location") or ship.get("cur_star_system")
    indices = [i for i, row in enumerate(rows) if isinstance(row, dict) and row.get("StarSystem") == current]
    if len(indices) != 1:
        raise EligibilityError("Bulunulan sistem etkin rotada doğrulanamadı.")
    remaining = rows[indices[0] + 1:]
    if any(not isinstance(row, dict) or not row.get("StarSystem") for row in remaining):
        raise EligibilityError("Rota dosyası eksik.")
    return {"remaining": len(remaining), "complete": not remaining, "cleared": False,
            "next": remaining[0]["StarSystem"] if remaining else None}


def require_start(status, ship, route):
    flags = status.get("Flags")
    flags2 = status.get("Flags2", 0)
    if type(flags) is not int or type(flags2) is not int:
        raise EligibilityError("Gemi durumu okunamıyor.")
    if not flags & (1 << 24) or flags & ((1 << 25) | (1 << 26)) or flags2 & 1:
        raise EligibilityError("Ana geminin kokpitinde olmalısınız; SRV ve yaya modu desteklenmiyor.")
    if flags & 3:
        raise EligibilityError("Önce gemiyi istasyondan/yüzeyden kaldırın.")
    if not flags & 16 or ship.get("status") != "in_supercruise":
        raise EligibilityError("Rota pilotu süperseyirde başlatılabilir.")
    if status.get("GuiFocus") != 0:
        raise EligibilityError("Galaksi haritasını ve panelleri kapatıp kokpite dönün.")
    if flags & ((1 << 17) | (1 << 20) | (1 << 23) | (1 << 30)):
        raise EligibilityError("Gemi atlama, aşırı ısınma veya müdahale durumunda; bekleyin.")
    if not route["remaining"]:
        raise EligibilityError("Devam edilecek etkin rota yok; oyunda bir rota çizin.")
    if ship.get("target") != route["next"]:
        raise EligibilityError("Oyunda etkin rotanın sıradaki sistemini hedefleyin.")
