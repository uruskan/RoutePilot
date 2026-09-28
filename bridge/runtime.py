"""Adapter over the installed MIT-licensed EDAP engine; no engine imports at module load."""
from __future__ import annotations

import copy
import importlib
import math
from pathlib import Path
import sys
import threading
from datetime import datetime, timezone

from bridge.safety import (EligibilityError, cleared_at_accepted_destination, navigation_context,
                           read_json, require_no_old_workers, require_start, route_snapshot)
from bridge.settings import SettingsStore, valid_sample


class RouteCompleted(BaseException):
    """Unwind past upstream's broad Exception handler without SC handoff."""


class RouteOnlyMixin:
    """The successful flight loop remains upstream; only route boundaries change."""

    def load_config(self):
        self.config = copy.deepcopy(self._routepilot_store.ap)
        self.config.update(FSDJumpLimit=0, AutomaticLogout=False, EnableEDMesg=False,
                           ActivateEliteEachKey=False, HotkeysEnable=False,
                           OverlayTextEnable=False, OverlayGraphicEnable=False,
                           Enable_CV_View=0, DebugOverlay=False, DebugOCR=False,
                           DebugImages=False, Debug_ShowCompassOverlay=False,
                           Debug_ShowTargetOverlay=False)

    def load_ship_configs(self):
        self.ship_configs = copy.deepcopy(self._routepilot_store.ships)

    def _routepilot_boundary(self):
        self._routepilot_cancel_check()
        route = self._routepilot_snapshot()
        if route["cleared"]:
            raise self._routepilot_safety_error("Etkin rota silindi; uçuş durduruldu.")
        if route["complete"]:
            self.set_throttle_0(repeat=3)
            self._star_departure_pending = False
            raise RouteCompleted()
        return route

    def position(self, *args, **kwargs):
        self._routepilot_boundary()
        result = super().position(*args, **kwargs)
        if not result:
            raise self._routepilot_safety_error("Sıradaki rota hedefi doğrulanamadı; sıfır gazda duruldu.")
        return result

    def mnvr_to_target(self, *args, **kwargs):
        self._routepilot_boundary()
        return super().mnvr_to_target(*args, **kwargs)

    def jump(self, *args, **kwargs):
        self._routepilot_boundary()
        return super().jump(*args, **kwargs)

    def have_destination(self, *args, **kwargs):
        # A compass/target image never authorizes a station/planet handoff.
        self._routepilot_boundary()
        raise self._routepilot_safety_error("Rota bitmedi fakat atlama hedefi kayboldu.")

    def _departure_status(self, *args, **kwargs):
        self._routepilot_cancel_check()
        return super()._departure_status(*args, **kwargs)


def guarded_keys_class(base, safety_error, permit):
    class RouteKeys(base):
        def _require_foreground(self):
            if not permit.is_set():
                raise safety_error("RoutePilot girişleri durdurdu; yeniden başlatmak gerekir.")
            return super()._require_foreground()

        def _prepare_input(self):
            if not permit.is_set():
                raise safety_error("RoutePilot giriş izni kapalı.")
            return super()._prepare_input()

        def _release_key(self, key):
            # Readiness/shutdown must not synthesize key-up for unowned keys.
            if key in self._pressed_keys:
                return super()._release_key(key)

        def send(self, key_binding, hold=None, **kwargs):
            if hold is not None and (not isinstance(hold, (int, float)) or not math.isfinite(hold) or hold < 0):
                raise safety_error("Geçersiz hareket süresi; giriş gönderilmedi.")
            return super().send(key_binding, hold=hold, **kwargs)
    return RouteKeys


class EngineRuntime:
    def __init__(self, engine_root, permit, emit, cancelled):
        self.root = Path(engine_root).resolve()
        self.permit = permit
        self.emit = emit
        self.cancelled = cancelled
        self.engine = None
        self.active = False
        self._last_phase_message = None
        self.run_lock = threading.RLock()
        self.initialization_step("Kayıtlı gemi ayarları denetleniyor", "reading existing settings")
        self.store = SettingsStore(self.root)
        self.stop_hotkey = None
        self.accepted_route = None
        self._observed_route = None
        sys.path.insert(0, str(self.root))
        launcher = importlib.import_module("aster_launch")
        launcher.configure_environment()
        self.initialization_step("Uçuş motoru bileşenleri yükleniyor", "importing guarded EDKeys and native image libraries")
        # Patch only the private bridge process, before engine construction.
        keys_module = importlib.import_module("EDKeys")
        keys_module.EDKeys = guarded_keys_class(keys_module.EDKeys, keys_module.InputSafetyError, permit)
        self.input_error = keys_module.InputSafetyError
        self.initialization_step("Uçuş motoru hazırlanıyor; girişler kapalı", "importing ED_AP")
        module = importlib.import_module("ED_AP")
        self.module = module
        adapter_type = type("RouteAutopilot", (RouteOnlyMixin, module.EDAutopilot), {})
        adapter_type._routepilot_store = self.store
        adapter_type._routepilot_safety_error = module.FSDRouteSafetyError
        self.initialization_step("Gemi, ekran ve metin tanıma hazırlanıyor", "constructing dormant route-only engine")
        engine = adapter_type(self.callback, do_thread=False)
        self.engine = engine
        engine.ap_thread = None
        engine.keys.block_inputs("RoutePilot hazır; uçuş henüz başlatılmadı.")
        engine._clear_assist_flags()
        engine._routepilot_snapshot = self.snapshot
        engine._routepilot_cancel_check = self.cancel_check
        self.load_ship()
        self.install_sample_filters()
        # Warm the lazy predictors on synthetic pixels before 'ready'. No screen
        # capture, focus change, keyboard event or route command is involved.
        self.initialization_step("Görüntü ve metin tanıma hazır olma denemesinden geçiyor", "warming models with synthetic pixels")
        self.warm_models()
        if self.store.removed:
            emit({"type": "event", "level": "warning", "title": "Geçersiz kalibrasyon noktaları elendi",
                  "detail": f"{len(self.store.removed)} sıfır/geçersiz nokta bellekte elendi; ilk kayıtta özgün dosya yedeklenecek."})

    def initialization_step(self, message, technical):
        print("RoutePilot init: " + technical, file=sys.stderr, flush=True)
        self.emit({"type": "state", "status": "loading", "phase": "idle", "message": message})
        self.emit({"type": "event", "level": "info", "title": message,
                   "detail": "Hazırlık sürüyor; hiçbir uçuş komutu gönderilmiyor.\nMotor: " + technical})

    def warm_models(self):
        import cv2
        import numpy as np
        if self.cancelled():
            return
        self.initialization_step("Pusula ve hedef tanıma denemesi yapılıyor", "warming compass and target predictors")
        blank = np.zeros((640, 640, 3), dtype=np.uint8)
        models = self.engine.mach_learn
        for model in (models.compass_ml_model, models.target_ml_model):
            if self.cancelled():
                return
            model.predict(blank, verbose=False)
        if self.cancelled():
            return
        self.initialization_step("Yazı tanıma denemesi yapılıyor", "warming OCR predictor")
        canvas = np.full((128, 700, 3), 255, dtype=np.uint8)
        cv2.putText(canvas, "SUPERCRUISE ASSIST", (20, 75), cv2.FONT_HERSHEY_SIMPLEX, 1.5, (0, 0, 0), 3)
        words = self.engine.ocr.image_simple_ocr(canvas, "routepilot-readiness")
        if not words or not any("SUPERCRUISE" in word.upper() for word in words):
            raise RuntimeError("OCR hazırlık denemesi başarısız; uçuş girişleri kapalı kaldı.")

    def cancel_check(self):
        if self.cancelled() or not self.permit.is_set():
            raise self.module.EDAP_Interrupt()

    def callback(self, action, message=None, *args):
        text = str(message or "")
        if action == "statusline" and self.active:
            lower = text.casefold()
            phase = ("clearance" if "verif" in lower or "interrupted star" in lower else
                     "refuel" if "refuel" in lower else "jump" if lower == "jump" else
                     "align" if "align" in lower else "depart" if "maneuver" in lower else
                     "error" if "stopped" in lower else "depart")
            labels = {"clearance": ("Yıldızdan güvenli çıkış doğrulanıyor", "Gaz sıfırda. Varış yıldızının kimliği ve geminin gerisinde kaldığı doğrulanıyor."),
                      "refuel": ("Yakıt toplanıyor", "Depo dolana kadar yakıt toplama ve zaman aşımı durumu izleniyor."),
                      "jump": ("Hipersıçrama başlatılıyor", "Sıradaki sisteme atlama için FSD kullanılıyor; varış kaydı bekleniyor."),
                      "align": ("Sıradaki sisteme hizalanıyor", "Pusula ve hedef göstergesiyle dönüş hatası düzeltiliyor."),
                      "depart": ("Yıldızdan ayrılmaya hazırlanıyor", "Yeni atlamadan önce güvenli çıkış yönü ve rota hedefi kontrol ediliyor."),
                      "error": ("Uçuş durduruldu", "Motor bir durma nedeni bildirdi; otomatik yeniden başlatma yapılmaz.")}
            if "preparing for refuel" in lower:
                labels[phase] = ("Yakıt toplama konumu hazırlanıyor", "Gemi, yakıt toplanabilecek konuma getiriliyor; ardından gaz sıfırlanacak.")
            elif "interrupted star" in lower:
                labels[phase] = ("Kesilen yıldız çıkışı tamamlanıyor", "Yeniden hizalanmadan önce yarım kalan çıkış gaz sıfırda yeniden doğrulanıyor.")
            elif "avoiding star" in lower:
                labels[phase] = ("Yıldızdan yakıt toplamadan geçiliyor", "Yakıt gereksinimi ve yıldız türü nedeniyle toplama atlandı; çıkış doğrulaması devam edecek.")
            title, why = labels[phase]
            self.emit({"type": "state", "status": "running", "phase": phase, "message": title})
            if text != self._last_phase_message:
                self._last_phase_message = text
                self.emit({"type": "event", "level": "warning" if phase == "error" else "info",
                           "title": title, "detail": why + "\nMotor: " + text})
        elif action in ("log", "log+vce") and text:
            # Keep raw high-frequency learning/control diagnostics in the process
            # log, not in the dashboard's finite activity history.
            print("EDAP: " + text, file=sys.stderr)
            known = {
                "Refueling complete": ("success", "Yakıt deposu doldu", "Yakıt toplama tamamlandı; sırada güvenli yıldız çıkışı var."),
                "Arrival star verified behind ship; original route target restored.": ("success", "Yıldız geride; rota hedefi geri alındı", "Yıldız yönü art arda doğrulandı. Gemi artık yıldızdan uzaklaşabilir."),
                "Skip refuel - not a fuel star": ("info", "Bu yıldızdan yakıt toplanmıyor", "Yıldız türü yakıt toplamaya uygun değil; mevcut yakıtla rota sürdürülüyor."),
                "Skip refuel - fuel level okay": ("info", "Yakıt seviyesi yeterli", "Depo ayarlanan eşiğin üzerinde; bu yıldızda yakıt toplama atlandı."),
                "Skip refuel - no fuel scoop fitted": ("warning", "Yakıt kepçesi bulunamadı", "Bu gemi yıldızdan yakıt toplayamıyor; yakıt rezervi kontrolleri geçerli."),
                "Compass Align complete": ("success", "Pusula hizalaması tamamlandı", "Sıradaki hedef geminin önünde; ince hedef hizalaması kontrol edilecek."),
                "Compass Align failed - exhausted all retries": ("warning", "Pusula hizalaması tamamlanamadı", "Hedef, izin verilen denemeler içinde hizalanamadı."),
                "Found neither Compass nor Target for destination offset.": ("warning", "Hedef göstergesi okunamadı", "Bu görüntüde pusula veya hedef tanınamadı; motor sonucu kontrol edecek."),
            }
            item = known.get(text)
            if text.startswith("FSD route stopped:"):
                item = ("warning", "Rota güvenlik denetimiyle durdu", "Durma nedeni motor ayrıntısında; yeniden başlatma otomatik değildir.")
            elif text.startswith("Input safety stop:"):
                item = ("warning", "Oyun odağı veya giriş güvenliği nedeniyle duruldu", "Oyun penceresini öne aldıktan sonra açıkça yeniden başlatmak gerekir.")
            elif text.startswith("Target Align failed"):
                item = ("warning", "Hedef hizalaması tamamlanamadı", "Hedef göstergesi kayboldu veya doğrulanamadı.")
            if item:
                level, title, why = item
                self.emit({"type": "event", "level": level, "title": title, "detail": why + "\nMotor: " + text})
        # Deliberately ignore sc_start, docking, calibration and other GUI actions.

    def load_ship(self):
        ship = self.engine.jn.ship_state().get("type")
        if ship not in self.module.ship_size_map:
            raise EligibilityError("Ana gemi bilgisi bulunamadı; oyunda geminin kokpitine girin.")
        if self.engine.current_ship_type != ship:
            self.engine.current_ship_type = ship
            self.engine.load_ship_configuration(ship)
            self.engine.current_ship_cfg = self.engine.ship_configs["Ship_Configs"][ship]
            self.engine.templ.reload_templates(self.engine.scr.scaleX, self.engine.scr.scaleY)

    def install_sample_filters(self):
        control = self.engine.ship_control
        for axis in ("roll", "pitch", "yaw"):
            name = f"add_to_{axis}_curve"
            original = getattr(control, name)
            def add(angle, rate, original=original):
                if valid_sample(angle, rate) and round(rate, 2) > 0:
                    return original(angle, rate)
            setattr(control, name, add)

    def snapshot(self):
        ship = self.engine.jn.ship_state()
        route = read_json(self.engine.nav_route.file_path)
        context = navigation_context(self.engine.jn.current_log)
        snapshot = route_snapshot(route, ship, context["route"])
        if snapshot["cleared"] and cleared_at_accepted_destination(self.accepted_route, ship, context):
            return {"remaining": 0, "complete": True, "cleared": False, "next": None}
        if not snapshot["cleared"]:
            final = route["Route"][-1]
            self._observed_route = {"name": final["StarSystem"], "address": final.get("SystemAddress"),
                                    "route_timestamp": route.get("timestamp", "")}
            if self.active and self.accepted_route:
                if any(self._observed_route[key] != self.accepted_route[key] for key in ("name", "address")):
                    raise self.module.FSDRouteSafetyError("Rota hedefi değişti; yeni rota için yeniden Başlat gerekir.")
                self.accepted_route.update(self._observed_route)
        return snapshot

    def validate_start(self):
        # An old OCR/honk thread must never inherit a new run's reusable key lease.
        require_no_old_workers(self.engine)
        self.load_ship()
        status = read_json(self.engine.status.file_path)
        ship = self.engine.jn.ship_state()
        require_start(status, ship, self.snapshot())
        self.engine.keys._validate_loaded_bindings()
        self.engine._require_fsd_fuel()
        self.accepted_route = dict(self._observed_route)
        self.accepted_route["started_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    def register_stop(self, callback):
        import keyboard
        self.stop_hotkey = keyboard.add_hotkey("ctrl+alt+end", callback)

    def run(self):
        with self.run_lock:
            engine = self.engine
            self.validate_start()
            self.cancel_check()
            engine.keys.allow_inputs()
            self.cancel_check()
            self.active = True
            self._last_phase_message = None
            engine.fsd_assist_enabled = True
            engine.jump_cnt = engine.refuel_cnt = engine.total_dist_jumped = engine.total_jumps = 0
            try:
                engine._prepare_assist_input()
                self.cancel_check()
                # Revalidate after explicit-start focus transfer, before flight controls.
                self.validate_start()
                result = engine.fsd_assist(engine.scrReg)
                if result == self.module.FSDAssistReturn.Complete:
                    return "completed", "Rota tamamlandı; gaz sıfırlandı."
                return "stopped", "Rota durduruldu; motor iletisini kontrol edin."
            except RouteCompleted:
                return "completed", "Rota tamamlandı; gaz sıfırlandı."
            except (self.module.EDAP_Interrupt, self.input_error) as exc:
                return "stopped", str(exc) or "Uçuş durduruldu."
            finally:
                self.active = False
                self.permit.clear()
                engine.keys.block_inputs("Uçuş sona erdi; açıkça yeniden başlatılması gerekir.")
                engine._clear_assist_flags()
                # Other EDAP workers can only release keys once the lease is cleared.
                for worker in (engine.honk_thread, engine._sc_sco_active_loop_thread):
                    if worker and worker is not threading.current_thread():
                        worker.join(timeout=1)

    def stop(self, reason):
        self.permit.clear()
        engine = self.engine
        if engine is not None:
            engine.keys.block_inputs(reason)
            engine._clear_assist_flags()

    def save(self):
        with self.run_lock:
            return self.store.save(self.engine.ship_configs)

    def close(self):
        self.stop("RoutePilot kapatılıyor.")
        if self.stop_hotkey is not None:
            import keyboard
            keyboard.remove_hotkey(self.stop_hotkey)
            self.stop_hotkey = None
        if self.engine:
            self.engine.quit()
