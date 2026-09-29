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

## Market scanner integration — 2026-09-29

Integrated supplied RoutePilot-Market-Scanner-1.0.0 source under features/markets, with a narrow host adapter, market CLI commands and a sidebar panel. Existing engine/bridge/flight commands are unchanged. Read-only telemetry adds StarPos for distance calculations.

- Actual runtime Node v24.21.0; installed Vite build succeeded (no dependency installs).
- `npm test`: **51 host tests + 123 scanner tests, all passed**. Host tests verify shared session auth and Origin restrictions, real-journal-context movement/unknown status, 100-row pagination, full CSV, persisted report/settings after restart, source URL restrictions and zero flight workers.
- Bounded live Spansh POST + detail GET confirmed ISO timestamps and real market fields. It exposed `Drake-Class Carrier` being misclassified by the supplied module; exact type support and a restricted-access regression were added.
- First full request at the supplied default of 500 records exceeded its 32 MiB response bound. Default page size is now 100; the live run used that limit. Pagination splits queries when needed rather than claiming truncated data is complete.
- Successful full refresh **2026-09-29 10:50:37–10:52:40 UTC**: 24-hour window; **8,376 unique markets, 91 requests/pages, 808 matching trade lots** under the saved default filters. Live API pagination returned 100 rows for each of the first two pages; full CSV export succeeded. Underlying quotes are observations, not guaranteed stock/prices, and count reconciliation is best-effort for a moving public database.
- Saved report/settings/CSV: ignored work/markets/. Evidence: work/market-live-acceptance.json and work/market-live-acceptance.log. The validation server listened on an ephemeral loopback port and shut down afterward. No production server was restarted.
- No visible windows, desktop screenshots, browser rendering tests, game controls, or flight-engine starts. Desktop visual acceptance remains unperformed; existing fake Electron lifecycle tests passed.
- Daily refresh remains opt-in and off initially; its scheduling, catch-up, cancellation and failure retention are covered by the supplied fixture tests. It runs only while RoutePilot/headless service is running.
