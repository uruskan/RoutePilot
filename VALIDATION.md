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

## Desktop tab crash fix — 2026-09-29

The production renderer reproduced a completely blank React root when selecting Markets. Stack trace reached React effect cleanup (`TypeError: l is not a function`). This Electron/Chromium version returns a Promise from `window.scrollTo`; the tab-change effect's expression body accidentally returned it to React. The effect now discards the result.

- Production Vite rebuild passed. Ten focused lifecycle, launcher and old-service compatibility tests passed.
- `scripts/check-desktop-navigation.cjs` ran in an invisible, isolated Electron renderer with synthetic market fixtures and a temporary loopback server. Five tab changes passed; 100 rows rendered on page one and 25 on page two. Reported scroll return: `[object Promise]`; visible windows: zero; flight workers: zero. Evidence: work/navigation-check.log.
- Launcher freshness checks now include features/markets/ui and dependency manifests. A running old backend produces an explicit restart instruction on the market panel.
- The older live background service was also detected (markets API 404), then replaced with the current headless service after it closed. Existing saved market data was retained. No flight was started.
- An initial sandboxed diagnostic Electron process failed to launch its renderer and caused a Windows crash dialog; that process was cleaned up. The successful check used an isolated unrestricted process with Windows error dialogs suppressed. No game inputs or screenshots were taken. Visible desktop acceptance is still user-side.

## Spreadsheet query defaults and large snapshots — 2026-09-29

Recovered the original workbook and builder/analyzer scripts from the conversation outputs/work directories. Inspected workbook cells Nearby trades!A3 and B8:D8 plus Highest buyers!A3. The primary query uses stock >=100t, both ages <=48h, route <=150ly and whole-stock profit descending with shorter-route ties; the secondary query uses stock >=1t, ages <=192h and unrestricted distance. Both require buyer demand to cover the entire lot. Host collection searches a rolling 192 hours, and player position always comes from the live journal. All filters and ranking remain editable and persisted. Preset switching preserves ship/budget inputs.

Validation: all 188 tests passed (53 host + 135 scanner), including filter boundaries, eligible-buyer recalculation, whole-stock ranking, persisted preferences, dynamic location and streamed snapshot storage. Production Vite build passed. The invisible Electron check passed five tab changes, 100/25-row pagination, two preset switches and ranking retention after reload; zero visible windows or flight workers. Logs: work/spreadsheet-defaults-tests.log and work/spreadsheet-defaults-renderer.log.

The first live eight-day scan reached 35,934 markets but failed at monolithic JSON.stringify with Invalid string length; the old report was preserved. Fixed this with a small atomic report manifest and individually streamed station records, keeping legacy report compatibility. Failure/cancellation/corrupt-source tests pass. Updated the user's saved filter settings through the authenticated local API and restarted only the confirmed idle companion service to load the fix. Live rerun evidence follows below.

Live rerun succeeded at 2026-09-29 11:41:02 UTC: 36,012 markets from a rolling eight-day window, 422 requests, 500 matching Nearby trades lots. The station snapshot is 726,131,645 bytes, exceeding the old JavaScript string limit. A separate read-only MarketService successfully reloaded that actual snapshot, re-applied the saved defaults and recomputed results without network access; reload took 19.3 seconds. Evidence: conversation work/spreadsheet-defaults/live-verification.json. Headless startup now allows 60 seconds for these larger saved reports instead of the previous 15-second deadline. Settings, ranking and current journal location were verified. No flight worker started.
