# Validation — 2026-09-29

This checkpoint validates the new application without flying the user's ship.

- Node tests cover the local API, route/status journal reader, command readiness/cancellation, subprocess shutdown, and the CLI using fake workers and temporary journals.
- Python tests cover the input lease, late worker rearm rejection, final arrival after `NavRouteClear`, calibration preservation/backups/conflicts, nonblocking pipe input and bounded shutdown.
- The installed EDAP engine passed `bridge/worker.py --check` after the old idle GUI was closed normally. The shared instance lock correctly rejected a second engine beforehand.
- A real `--probe` process loaded the existing Mandalay settings, compass/target models and OCR model; it reached `ready` and exited with code 0 after a `shutdown` command. **No start command was sent and flight permission stayed off.** SHA-256 comparisons confirmed AP.json, ship_configs.json and ocr_calibration.json were unchanged.
- The first probe exposed an initialization stall. Isolated NumPy experiments traced it to a thread blocked waiting on pipe stdin. Polling available pipe bytes avoids the stall; production-reader import checks completed in 0.063–0.094 seconds. The engine now initializes and operates on one main thread, retaining capture thread affinity.
- Electron 44.4.5 passed the console-only `--check-runtime` check, exit 0: no renderer window and no flight engine were created. An ESM startup wait cycle found during this test was removed.
- The live local service and CLI returned the actual journal state, rejected flight eligibility while in SRV, and handled stop/shutdown/restart while no flight worker was active.
- Vite production build passed. The React dashboard, preferences, history and help were inspected before the user requested no further screen-based work. No visible Electron window has been opened or tested while the user is playing.

The underlying EDAP flight engine previously completed the user's plotted route. **The new RoutePilot integration has not completed a live flight.** Its first flight still requires an explicit user start and observation; unit tests and dormant model checks are not substitutes for it.

Local diagnostic evidence is in ignored `work/probe-result.json`, `work/probe-stderr.txt`, `work/electron-check.log`, and `work/numpy-isolation-results*.json`. No logs, game journals, models, caches or private calibration files are committed.

Run reproducible non-flight checks:

```powershell
npm.cmd test
& 'D:/GameDev/Projects/EDAPGui/venv/Scripts/python.exe' -m unittest discover -s test -p 'test_bridge*.py' -q
npm.cmd run build
```
