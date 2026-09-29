# Service and source reference

## Public API

```js
import { MarketService } from './server/markets.mjs';
const service = new MarketService({
  root,                         // Required, dedicated local directory.
  fetchImpl: globalThis.fetch,   // Optional standard Fetch implementation.
  now: Date.now,                // Optional function: epoch ms or a Date.
  getContext: () => null,        // Optional read-only sync/async context provider.
});
await service.ready;
```

| Method | Contract |
| --- | --- |
| `await status()` | Detached snapshot of settings, current context, report metadata, lastAttempt, refresh progress, scheduler, storage warnings. Does not fetch Spansh. |
| `await results(query = {})` | Re-match committed source records using current context/time/settings. Returns paginated rows, total, hasMore, metadata, diagnostics, warnings. No network collection. |
| `await csv(list = 'all')` | List is `'all'`, `'affordable'`, or a result-query object. Exports every matching row, not just `limit`/`offset`. |
| `await configure(patch)` | Validates and atomically merges settings. Returns settings directly, not `{settings}` (the HTTP adapter wraps it). |
| `refresh()` | Starts one new rolling refresh. Duplicate concurrent calls return the **same Promise**; no queued second run. |
| `cancel()` | Synchronous boolean: cancellation accepted, or false if idle/already cancelled/in the commit boundary. |
| `await startScheduler({keepAlive:false})` | Explicitly starts in-process scheduling. No refresh unless persisted `dailyRefresh` is true. Host HTTP loop normally keeps Node alive. |
| `await close()` | Idempotent, stops scheduling, cancels cancellable work, waits for atomic work/state writes, releases storage lock. |

Read-only consumers can pass `readOnly:true` to the constructor. This allows reading a committed report while another process owns the root but rejects refresh/configure/startScheduler. Such readers load one committed snapshot when constructed; reopen to see another process's later commit. `timers:{setTimeout,clearTimeout}` is an optional scheduler-only test seam, not an app requirement.

`refresh()` resolves to one of:

```js
{ outcome: 'succeeded', id, report /* metadata */ }
{ outcome: 'failed', id, error: { code, message, details? }, retainedReportId }
{ outcome: 'cancelled', id, error: { code: 'CANCELLED', message }, retainedReportId }
```

Invalid lifecycle use (for example refresh on a closed/read-only service) rejects. `ready` rejects on invalid persisted settings/storage ownership. Normal network, schema, coverage and persistence refresh failures resolve to an outcome and are exposed through status. `configure` and `results` reject invalid input. Always await/catch these promises in host code.

`status.refresh` includes `running`, `canCancel`, `id`, `startedAt`, `phase` and available counters (`requests`, `pages`, `stations`, `splits`, `retries`, `detailsTotal`, `detailsCompleted`, `rateLimitWaitMs`). Progress is indeterminate because subdivisions/retries can change the work required; no invented completion percentage is reported.

## Result queries

`list`: `all` (includes zero/unknown affordable loads) or `affordable` (at least one calculable affordable tonne). `sort` defaults to `margin`:

| Sort | Meaning |
| --- | --- |
| `closestSeller` | Ascending current player → seller straight-line distance; requires valid current StarPos. |
| `shortestRoute` | Ascending seller → selected buyer distance, unknown last. |
| `margin` | Descending quoted profit per tonne. |
| `loadProfit` | Descending quoted profit at the initial affordable load; unknown last. |
| `stockProfit` | Descending conditional full-stock profit; overflow/unknown last. |

`limit` defaults to 100, range 1–1000. `offset` is a nonnegative safe integer. Matching happens **before pagination**, so there is no global 100-row cutoff. Ties use margin and stable row ID. Seller → buyer distances are not affected by a missing player location.

Any trading filter in the following table may override persisted settings for a single results/CSV request. Collection and scheduler settings cannot be changed through a GET query.

| Trading setting | Default | Meaning |
| --- | --- | --- |
| `cargoCapacity` | null | Cargo space to use, whole tonnes; null unknown, 0 valid. |
| `credits` | null | Current available credits, whole Cr; null unknown, 0 valid. |
| `creditReserve` | 0 | Credits not available for purchase. |
| `minStock` | 1 | Minimum entire seller stock. |
| `maxMarketAgeHours` | 24 | Both endpoints; null disables age filtering and allows unknown/future timestamps with warnings. |
| `requiredPad` | `'any'` | `'any'`, `'S'`, `'M'`, `'L'`. |
| `maxPlayerDistanceLy` | null | Player → seller only. Null means no radius filter. |
| `maxRouteDistanceLy` | null | Seller → buyer only. Null means no route-radius filter. |
| `allowUnknownPad` | false | When requiring a pad size, admit unknown capability; never overrides known incompatibility. |
| `allowPermitSystems` | true | Include permit-required and unknown-permit systems, flagged. False requires explicitly no permit. |
| `allowPlanetary` | true | Include surface and unknown-surface markets, flagged. False requires explicitly not planetary. |
| `excludePotentiallyCorrosive` | false | Exclude heuristic corrosion matches when true. |

Configurable collection/scheduling defaults:

| Setting | Default | Purpose |
| --- | --- | --- |
| `windowHours` | 24 | Re-query `[refresh time - window, refresh time]`, bounded to whole seconds, every refresh. Maximum 720 hours. |
| `dailyRefresh` / `dailyUtcHour` | false / 3 | Opt-in daily deadline at 03:00 UTC, not the PC's local wall time. |
| `concurrency` | 2 | Shared maximum concurrent requests, valid 1–8. |
| `minRequestIntervalMs` | 500 | Shared minimum spacing of request starts, including retries. |
| `timeoutMs` | 20000 | Fetch and response-body timeout per attempt. |
| `maxRetries` | 3 | Retries after the first attempt. |
| `retryBaseMs` / `retryMaxMs` | 1000 / 30000 | Bounded exponential request retry delay with jitter. |
| `pageSize` | 100 | Requested page size; collector adapts to an observed smaller first page. |
| `queryResultCap` | 10000 | Conservative configurable split guard, **not a verified official Spansh cap**. |
| `maxPagesPerSlice` | 20 | Split larger time intervals rather than making deeper pages. |
| `minSliceMs` / `maxSplitDepth` | 1000 / 24 | Smallest partition and recursion bound. No millisecond-gap assumption. |
| `maxRequests` | 2000 | Per-refresh request-attempt budget, including retries/details. |
| `maxStations` | 100000 | Unique station safety budget. |
| `hydrateMissingMarkets` | true | Fetch `/api/station/{id}` for missing search-result market arrays. |
| `maxDetailRequests` | 2000 | Number of distinct detail hydrations allowed. |
| `maxResponseBytes` | 33554432 | Maximum response body per request, 32 MiB. |
| `schedulerRetryBaseMs` / `schedulerRetryMaxMs` | 300000 / 21600000 | Daily failure backoff: 5 minutes up to 6 hours. |
| `cancellationBackoffMs` | 1800000 | 30-minute daily-retry cooldown after cancellation. |

Settings reject unknown keys, wrong primitive types, non-finite numbers, unsafe integers, and out-of-range values. API JSON settings accept real numbers/booleans/null; URL/CLI conversion is explicit. Negative/empty inputs do not silently become usable coordinates, credits, prices, or dates. Exact limits are in `NUMERIC_RULES` in `server/markets.mjs`.

## Matching and arithmetic

For each explicitly public carrier's usable commodity quote, find the eligible buyer with the highest `sell_price`. Requirements: different market ID, positive spread, buyer `demand >= seller supply`, valid requested pad/access/age/radii/permit/surface filters. Equal buyer prices prefer shorter known distance, then more recent market timestamp, then stable ID. Changing filters re-matches all stored buyers; it does not just hide an already-selected unsuitable buyer.

Prices and counts must be nonnegative safe integers; seller buy price must be strictly positive, buyer sell price strictly positive. A zero source price is treated as unusable, **not a free cargo offer**. Numeric strings from source fields are accepted only when unambiguous; setting values are not implicitly coerced. Commodity identifiers are Unicode-normalized and case-folded. Multiple quotes for the same commodity at a station are discarded as ambiguous, not merged. Duplicate station IDs retain the newer complete record rather than mixing snapshots.

Let `B` be buy price, `S` sell price, `Q` entire advertised seller stock, `C` cargo capacity, `K` credits and `R` reserve:

```
marginPerTonne        = S - B
fullStockCost         = B * Q
fullStockProfit       = (S - B) * Q         // Conditional, not guaranteed or additive.
availableCredits      = max(0, K - R)
affordableCargoPerTrip = min(Q, C, floor(availableCredits / B))
costPerLoad           = B * affordableCargoPerTrip
profitPerLoad         = (S - B) * affordableCargoPerTrip
tripsNeeded           = ceil(Q / affordableCargoPerTrip)
```

A missing credit/cargo value makes load calculations unknown (`null`), not zero. A calculable zero load has zero cost/profit and unknown trips. A reserve above total credits produces a zero affordable load and warning. Products outside JavaScript's exact safe integer range become null with an overflow warning. Trips use the **initial** affordable load on every trip, with no speculative reinvestment of profits. `fullStockCost` is aggregate purchase spend, not necessarily the starting capital needed if cargo is sold between trips.

There is no portfolio allocation: two rows sharing `sharedBuyerDemandKey` may compete for the same stock/demand. No total-profit sum is provided. Carrier movement, docking permissions, prices, supply, demand, cargo legality, game fees and travel expenses can invalidate a quote. No bulk-price reduction formula, threshold, insurance assumption, or earnings-per-hour estimate is fabricated.

Station views include source IDs/URLs, names, coordinates, arrival distance (ls), pad/access/permit/surface fields, `marketUpdatedAt`, `marketAgeHours`, `stationUpdatedAt` and `timestampState`. Row flags carry seller/buyer restrictions plus `bulk-price-unmodeled`, potential corrosion and affordability warnings. `knownPad` means at least that size is explicitly supported by the given fields, not a complete inventory of every pad.

Potentially corrosive cargo is a **heuristic**, matching commodity/category text containing `thargoid`, `caustic`, `corrosive`, or `unknown artefact/artifact/probe/link`. It is neither exhaustive nor proof that a matching commodity is actually corrosive. Bulk-price risk is conservatively flagged on all opportunities, including carrier buyers, because exact source/game-specific pricing behavior was not verified. The panel says to verify the final in-game quote.

## Source contract, verified facts and explicit assumptions

The implementation uses the observed contract supplied in the task:

```json
{
  "size": 100,
  "page": 0,
  "filters": {
    "market_updated_at": {
      "comparison": "<=>",
      "value": ["<rolling-start-ISO>", "<rolling-end-ISO>"]
    }
  },
  "sort": [{"market_updated_at":{"direction":"desc"}}]
}
```

POST `https://spansh.co.uk/api/stations/search` → `{count,results}`. Missing market arrays can be hydrated with GET `https://spansh.co.uk/api/station/{market_id}` → `{record}`. Human links use `https://spansh.co.uk/station/{market_id}`. No invented bulk endpoint or private game API is used.

**Independent verification did not succeed.** The included real POST probe failed to resolve `spansh.co.uk` with `EAI_AGAIN` before receiving an API response. It does not establish an API outage or prove the contract invalid. A browser GET to the search endpoint is not a substitute for a successful POST. The tests exercise the user-supplied contract through synthetic responses; they do not turn assumptions into verified live behavior.

These adapter policies remain explicit rather than claimed as externally verified:

* Carrier type accepts `Fleet Carrier`, `FleetCarrier`, and equivalent whitespace/hyphen/underscore forms. Public docking accepts only case-insensitive trimmed `All` or `Public`. No numeric/private/unknown docking enum is interpreted as permission. Probe actual values before broadening this allowlist.
* Time parsing accepts a valid ISO timestamp with `T` and an explicit `Z` or `±HH:MM` zone. Missing, impossible, timezone-less or other-format dates stay unknown. **No UTC timezone is silently attached.** `updated_at` is not substituted for `market_updated_at`. The probe reports whether returned timestamps pass the parser; unexpected formats need an explicit, verified adapter change.
* Pad fields, booleans, commodity strings and coordinates follow the supplied field names. Booleans support true/false and explicit 1/0 representations; numeric fields support safe numeric strings. Unknowns remain unknown. A timestamped market record is not assumed to make every other station field known.
* The cap guard is configurable, not an assertion of an official cap. Inclusive midpoint overlap is deliberate; deduplication prevents double-counting and avoids assuming sub-second endpoint precision. API count reconciliation cannot guarantee a simultaneous snapshot while source markets are changing.

A search response with zero results/count is a legitimate empty scan and can replace a previous report. Missing required response structure, invalid IDs, hydration mismatches, size/budget limits or irreconcilable pages instead fail the refresh. A newer station detail replaces the search record wholesale; quotes do not inherit a stale search timestamp when detail lacks one.

## Collection reliability

The request client has a shared concurrency semaphore, monotonic pacing, global Retry-After cooldown, per-attempt timeout including streamed body, response-size limits and abort propagation. Network/timeouts and HTTP 408/425/429/500/502/503/504 can retry. It respects numeric and date Retry-After values. A Retry-After over 5 minutes fails promptly with the requested cooldown recorded for the scheduler rather than hanging or retrying too early.

Counts at/above `queryResultCap`, pages beyond `maxPagesPerSlice`, duplicated/missing pages, changing counts, out-of-window timestamps, and deep-page 400/416/422 cause time subdivision. When subdivision cannot safely continue, `INCOMPLETE_COVERAGE` includes the relevant intervals/reason and counters. **Partial source results are never installed as the new report.** A count that is silently too small below the guard and internally consistent is not detectable with this endpoint alone; no exhaustive-coverage claim is made.

Only the requested rolling window is collected, including buyers. Increasing `maxMarketAgeHours` without also collecting a wider window cannot recover older missing buyers. Sorting is descending market timestamp per the supplied contract. Markets may move/change while several pages are being fetched, so even a reconciled scan is advisory.

## Persistence, scheduling and lifecycle limitations

`state.json` stores settings, scheduler state and last attempt. `report.json` stores the last committed compact source station records, metadata and all reference opportunities calculated at refresh time. Public results always re-match the stored source with current settings, ages and injected context; persisted reference coordinates are never used as the new session's current position.

Each JSON write uses an exclusive same-directory temporary file, file fsync, close and rename; the previous destination is never unlinked first. Transient Windows rename-sharing errors are retried. Directory fsync is best effort on platforms/filesystems that support it. The two files are individually atomic, **not one cross-file transaction**. If the report commits but scheduler bookkeeping fails, that is a successful report with a warning, not a false “failed refresh” replacing old data. A corrupt state file fails closed; a corrupt report is surfaced and not treated as valid.

The root is single-writer via a PID/token lock. Read-only readers are permitted. Clearly dead PID locks are recovered with a token recheck, but this is a local-process safeguard, not a distributed/filesystem lease. Use a local per-app root, not network-shared storage; do not start multiple writers simultaneously to recover the same stale lock. A malformed/incomplete lock is not auto-deleted. Stop all relevant processes before manually removing a stale lock. Atomic rename semantics/power-loss durability on the actual Windows/filesystem configuration still need host acceptance testing.

The scheduler runs at a UTC hour, catches up once after missed deadlines, and counts a successful manual refresh after the due deadline as fulfilling that day's deadline. Several missed days cause one current rolling query, not one old query per missed day. Cancellation uses its separate cooldown without incrementing failures. Backoff state is persisted across restarts; manual refresh can bypass waiting. No OS task, background daemon installation or scheduling outside a running app/CLI is performed. The scheduler must explicitly be started by the host.

Matching/index preparation yields cooperatively to the event loop. JSON parse/stringify, sorts and some synchronous work are not worker-isolated; worst-case large snapshot latency is not a guarantee of zero impact on a shared host loop. Bound the collection window/budgets for your app and retain existing error handling. The package never edits or invokes flight logic, but no real-game latency benchmark was performed.

## Documentation consulted

The source API shape above comes from the task's observed contract, not an independently successful probe. Public Spansh station search was checked at https://spansh.co.uk/stations without establishing additional enum/cap semantics. Implementation conventions were checked against official Node test/filesystem and React effect documentation:

- https://nodejs.org/api/test.html
- https://nodejs.org/api/fs.html
- https://react.dev/reference/react/useEffect

The bundled test/runtime version is recorded separately in `docs/TESTING.md`; current online documentation versions are not claimed to be the tested runtime.
