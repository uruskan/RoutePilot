> Integrated into RoutePilot on 2026-09-29. The verification paragraph below describes the supplied package's original build environment. Local host verification is recorded in ../../VALIDATION.md: 51 host tests + 123 scanner tests passed, UI built, and a live 24-hour scan completed. Local fixes recognise Spansh's Drake-Class Carrier type and request 100 stations per page to stay within the 32 MiB response bound. Original build artifacts are retained for provenance.
# RoutePilot — refreshable carrier trading scanner

A finished, independently runnable scanner package for Node.js 22+, plus a React panel and an optional Node HTTP adapter. It was built and tested in an isolated container, **not on your PC or against your RoutePilot repository**. None of these modules sends game input, reads screenshots, changes focus, or imports an autopilot module.

**Verification:** 122 automated tests passed on Node v22.16.0. The UI source passed JSX transpilation/syntax checks. A real Spansh POST was attempted but failed at DNS resolution (`EAI_AGAIN`); no successful live API test is claimed. See `docs/TESTING.md` and the transcripts in `artifacts/`.

## Files

| File | Purpose |
| --- | --- |
| `server/markets.mjs` | `MarketService`: collection, matching, refresh/cancel, atomic persistence, scheduler, CSV. Node standard library only. |
| `server/market-http.mjs` | Isolated authenticated HTTP router; does not create a second server or take over other routes. |
| `cli/markets.mjs` | Standalone CLI using the same service, without Electron. |
| `ui/MarketPanel.jsx` | React panel: location, editable settings, refresh progress, cancellation, ranking, pagination, CSV. |
| `ui/market-client.mjs` | Browser transport and UI formatting/validation helpers. |
| `ui/MarketPanel.css` | Scoped `.rp-market` styles. |
| `test/` | Synthetic fixtures, mocked upstream networking, real loopback HTTP, scheduler and CLI tests. |
| `scripts/` | Cross-platform test runner, syntax checks, explicit live source probe. |
| `docs/INTEGRATION.md` | Copy/wire contract for your existing server, journal context, UI and lifecycle. |
| `docs/REFERENCE.md` | API, settings, formulas, source policies and operational details. |
| `docs/CODEX-HANDOFF.md` | Narrow integration brief; no scanner implementation left for Codex. |

## Run it independently

From this extracted directory, using Node 22 or newer:

```powershell
node --version
npm test
npm run check
node cli/markets.mjs help
```

**No `npm install` is needed for the backend, CLI, or test suite.** React is supplied by RoutePilot's existing frontend build. The optional JSX syntax script requires TypeScript in the development environment; it is not a runtime dependency.

Create a dedicated scanner root and set your actual ship/budget values. These commands use **illustrative inputs**, not default or detected player values:

```powershell
$MarketRoot = Join-Path $env:LOCALAPPDATA 'RoutePilot\markets'
node cli/markets.mjs settings --root "$MarketRoot" --cargo 400 --credits 200000000 --reserve 20000000 --pad L
node cli/markets.mjs refresh --root "$MarketRoot"
node cli/markets.mjs results --root "$MarketRoot" --sort loadProfit --list affordable --limit 100
node cli/markets.mjs export --root "$MarketRoot" --sort loadProfit --output .\routepilot-trades.csv
```

A plain refresh does **not** need a current location. With no injected `StarPos`, distances from the player are unknown and `closestSeller` is unavailable; station-to-station distance still works when both markets have coordinates. For the CLI, supply a read-only JSON context file produced by your existing journal reader:

```powershell
node cli/markets.mjs results --root "$MarketRoot" --context-file .\current-context.json --sort closestSeller --max-from-me 100 --max-route 50
```

Context shape: `{"systemName":"your actual current system","StarPos":[x,y,z]}`, where `x`, `y`, and `z` are your journal's actual numeric coordinates. The system name alone never implies a position. You can instead pass `--system "..." --position=x,y,z` with actual coordinates.

Opt into daily collection while the standalone process remains open:

```powershell
node cli/markets.mjs watch --root "$MarketRoot" --daily true --utc-hour 3
```

This persists the preference, performs startup catch-up when due, and uses failure backoff. Ctrl+C stops the process. No OS task or background ChatGPT task is created. The normal RoutePilot integration calls `startScheduler()` during app startup instead of launching `watch`.

**One writer per root:** do not run CLI `refresh`, `settings`, or `watch` against a root owned by a running app. Use the app's authenticated market API, close the app first, or choose a different root. Read-only `status`, `results`, and `export` can open the committed report while the app runs; they do not report another process's live refresh progress.

## Trading behavior

Only explicitly public fleet carriers can be sellers. Buyers are ordinary stations or explicitly accessible carriers. Buyer demand must cover **the entire advertised seller stock**, not merely the first affordable load. Filters are applied before choosing the highest-priced eligible buyer for each seller/commodity; equal prices prefer a shorter known route.

`closestSeller` measures **player → seller**. `shortestRoute` measures **seller → buyer** for the chosen best-price pair. A `maxRouteDistanceLy` filter can force selection of a closer, lower-priced eligible buyer. These are straight-line distances, not plotted jump counts or travel times.

Budget and cargo default to `null`, not invented values. Reserve is protected. Market age is recalculated on every results query, independently of the last successful collection time. Unknown coordinates/timestamps stay unknown. Pad, permit, surface, potential corrosion, and unmodeled bulk-price risks are explicit.

The scanner retains **all valid opportunities** within the collected data. API/UI pagination defaults to 100 rows; CSV exports all filtered rows. It never pads a short list with fabricated trades. Full-stock profit is conditional and **rows are not additive**: several sellers can consume the same buyer demand.

## Freshness and incomplete scans

Every refresh queries a new rolling time window. No “complete daily cache” skips future collection. Queries are paginated, paced, retried with timeouts, and subdivided into overlapping time intervals when a cap or inconsistent page count is detected.

A refresh that cannot establish coverage fails with `INCOMPLETE_COVERAGE`; its diagnostics are exposed, and the prior successful report remains intact. API errors and accepted cancellation likewise preserve the prior report, on disk and in memory. There is a short non-cancellable atomic commit boundary after which cancellation is reported as not accepted.

`coverage.complete` means the client's requested windows reconciled against **returned API counts**. It does not mean the galaxy is fully indexed, all source records were simultaneous, or the trade still exists in-game. Buyers outside the requested rolling window are not collected. A silently incorrect count below the configured guard cannot be disproved by this endpoint alone.

## Live source check and remaining acceptance checks

```powershell
node scripts/probe-spansh.mjs --detail
```

This explicitly makes one bounded search POST and optionally one detail GET for an ID actually returned by that page; it does not modify scanner state. The bundled result in `artifacts/live-probe.json` is a **failed network probe**, not proof of API compatibility.

The source adapter follows the task's observed contract. Docking allowlist, timestamp parsing, response caps and other unverified assumptions are disclosed in `docs/REFERENCE.md`. Run the probe from a network that can resolve Spansh before relying on live output. The finished code has not been run in a Windows/Electron GUI, nor visually/browser-render tested; those host-specific acceptance checks remain after integration. CSV is implemented; XLSX, a journal parser, jump routing, a bulk-price model and autopilot integration are deliberately outside this package.
