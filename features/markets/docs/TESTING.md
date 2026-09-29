# Test results and honest verification scope

## Executed in the build container

Environment: Linux container, **Node.js v22.16.0**, npm 10.9.2. No access to or changes on the user's PC. No game process, screenshot, focus API or input controller was involved.

These commands were actually run successfully against the packaged source:

```text
npm test
npm run test:coverage
npm run check
npm run check:ui
```

**122 tests passed; 0 failed, 0 cancelled, 0 skipped, 0 todo.** The same `node:test` runner is invoked by `npm test` through explicit file enumeration so that shell glob expansion is not needed on Windows. There are no runtime or test npm dependencies for these `.mjs` tests.

| Test area | Tests | Important assertions |
| --- | ---: | --- |
| Matching | 30 | Price direction, full-stock demand, private carriers, pads/access, best eligible buyer after filters, all five sorts, both radii, missing/stale/future data, reserve/cargo/budget, >100 rows, overflow, duplicate records, CSV formula protection, randomized exhaustive oracle. |
| Collection | 29 | Exact POST shape, pagination, server page-size clamping, count drift, caps and overlapping splits, unpartitionable intervals, deep-page errors, missing-market details, schema/ID validation, request/size budgets, retries, Retry-After, timeouts including body, rate spacing, cancellation. |
| Service/persistence | 20 | Successful commit, byte-for-byte prior-report retention on failure/cancel, identical duplicate-run promise, rolling re-query, fresh context/age re-ranking without network, 170-row pagination/export, restart, settings writes, lock/read-only behavior, corrupt/interrupted data, caller-mutation isolation. |
| Scheduler | 12 | Opt-in, UTC deadlines, startup catch-up, manual success satisfying a due deadline, exponential failure backoff, Retry-After, cancellation cooldown, preference/restart, missed-day coalescing, manual bypass, shutdown. |
| HTTP adapter | 10 | Actual loopback sockets, protected routes, JSON/auth/origin/Host checks, preflight, duplicate refresh/cancel, missing-position 409, CSV and route boundaries. |
| CLI | 9 | Actual CLI child-process help, mocked refresh, JSON results, settings/filters, CSV file, context input, validation, watch opt-in/stop, failed refresh. |
| UI transport/helpers | 11 | Request serialization, token transport, isolated endpoints, server errors, Blob/BOM, timeout, cancellation, already-aborted request, unsafe URL rejection, draft values and unknown/zero formatting. |
| Cross-layer end-to-end | 1 | UI transport → real authenticated container-loopback HTTP → service → mocked Spansh → 130-row persisted report → complete CSV; simulated later outage preserves file/report; unrelated existing handler still receives its request. |

The matching oracle uses 25 seeded synthetic trials against an independent exhaustive buyer selection, not live trades. Tests labelled source/network use mocked upstream data. The HTTP and end-to-end tests open **real ephemeral loopback ports in this container**, not `127.0.0.1:47856` on the user's machine. “Existing handler unchanged” in a test means a test handler; it is not a claim about the uninspected RoutePilot repository.

Two cancellation races found during review were fixed and regression-tested: a progress callback cancelling just before the request's abort listener was attached, and a pre-aborted UI request leaking a later token-provider rejection. Accepted cancellation now stops that network attempt, and pre-aborted UI requests do not invoke networking.

## Coverage

`artifacts/coverage.tap` contains the actual Node experimental coverage report. The summary below is for the implementation modules, **not a misleading combined percentage including fixtures**. Small percentage changes are expected after any further edits; the included transcript is authoritative.

| Module | Line coverage | Branch coverage |
| --- | ---: | ---: |
| `server/markets.mjs` | 96.45% | 88.38% |
| `server/market-http.mjs` | 100.00% | 84.52% |
| `cli/markets.mjs` | 92.86% | 72.41% |
| `ui/market-client.mjs` | 97.92% | 93.07% |

Coverage does not prove correctness. Some filesystem/Windows sharing errors and post-report-commit bookkeeping failures are defensively handled but not fault-injected here. The actual React component is **not** counted as tested by the transport module's percentage.

## Syntax versus rendering

`npm run check` successfully checked all 17 `.mjs` files with Node's syntax checker.

`npm run check:ui` used **TypeScript 5.8.3** already available in this container to transpile `MarketPanel.jsx`, then syntax-checked the emitted ES-module JavaScript with Node. It did not install or run a browser, mount React, assess visual layout, or execute an Electron renderer. CSS is supplied and scoped, but it has not been visually rendered in a GUI here.

The optional UI check is intentionally separate from the dependency-free test suite. From a development environment without TypeScript:

```powershell
npm install --no-save --package-lock=false typescript@5.8.3
npm run check:ui
```

This is optional development tooling, not a backend runtime dependency. Your actual RoutePilot frontend bundler/build and React runtime must also be tested during integration.

## Actual live probe: failed before an API response

`node scripts/probe-spansh.mjs` was actually invoked on September 29, 2026. It prepared a fresh last-24-hours request and attempted a POST to the supplied search endpoint. `artifacts/live-probe.json` records the request and result:

```text
success: false
TypeError: fetch failed
cause.code: EAI_AGAIN
cause.message: getaddrinfo EAI_AGAIN spansh.co.uk
```

Therefore no API count, station details, docking enum, timestamp format, source cap, or real trade was verified live. This is a container DNS failure, **not evidence that Spansh itself is down**. A probe failure is not quietly replaced with a mock “success.” `npm test` never needs this live endpoint.

To probe from a working network:

```powershell
node scripts/probe-spansh.mjs --detail
```

The optional detail request uses a station ID actually returned by the first search page. The probe changes no scanner files. Even a successful one-page probe would not prove complete market coverage or current in-game execution prices.

## Checks that remain in the real host

Windows filesystem locking/rename behavior, Electron's actual embedded Node version, React mounting/visual layout, the app's trusted origin/token transport, the actual journal adapter and source-link opening all require host acceptance. The scanner has not been tested against RoutePilot's absent source repository or a live Elite Dangerous session. Source dialect discrepancies found by the probe should be addressed explicitly, with a regression fixture; do not weaken missing-value/access rules to make an empty screen appear populated.

## Evidence files

`artifacts/tests.tap`: passing test run. `artifacts/coverage.tap`: passing run plus implementation coverage. `artifacts/node-syntax.txt`: Node syntax output. `artifacts/ui-syntax.txt`: JSX transpilation/syntax output. `artifacts/live-probe.json`: real failed network probe. These are generated evidence, not sample expected output.
