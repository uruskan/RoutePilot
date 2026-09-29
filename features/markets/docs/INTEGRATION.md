# Integration contract — keep existing flight code untouched

## 1. Copy the feature, not a replacement app

Copy `server/markets.mjs`, optionally `server/market-http.mjs`, and all three files in `ui/` into RoutePilot. Keep the CLI and tests in their relative directory layout when retaining standalone/test support. The backend requires Node 22+; verify the actual runtime used by your Electron main/backend process. The UI expects an existing React 18+ JSX/CSS build.

Use a **dedicated subdirectory** such as `path.join(app.getPath('userData'), 'markets')`. Do not point the service at existing flight-state files. Do not replace RoutePilot's HTTP server, its port, app startup, or flight-command dispatcher.

## 2. Construct one service and mount the isolated router

The following names (`marketRoot`, `readJournalContext`, `authenticateExistingRequest`, `existingRequestHandler`) represent bindings to your app's existing facilities, not assumed exports from an inspected repository:

```js
import { MarketService } from './server/markets.mjs';
import { createMarketRouter } from './server/market-http.mjs';

const markets = new MarketService({
  root: marketRoot,
  getContext: async () => {
    const ctx = await readJournalContext(); // Existing READ-ONLY context snapshot.
    return {
      systemName: ctx?.systemName ?? ctx?.StarSystem ?? null,
      StarPos: Array.isArray(ctx?.StarPos) ? [...ctx.StarPos] : null,
    };
  },
});
await markets.ready;

const routeMarkets = createMarketRouter({
  service: markets,
  authenticate: authenticateExistingRequest, // Required; sync or async boolean.
  allowedOrigins: ['http://127.0.0.1:47856'], // Use the exact trusted renderer origin(s).
  // prefix: '/api/markets', authenticateReads: true are the defaults.
});
await markets.startScheduler(); // Arms only when the persisted preference is enabled.

// Inside the EXISTING server's request dispatch, before its fallback/not-found route:
async function dispatch(req, res) {
  if (await routeMarkets(req, res)) return;
  return existingRequestHandler(req, res); // Unchanged existing dispatch/flight behavior.
}

// In your existing graceful-shutdown path, await this exactly once:
await markets.close();
```

Keep your existing top-level request error handling. `routeMarkets` returns `false` without reading a body, authenticating, or changing a response for a non-market route. It creates no server and never listens on another port. Do not await a full refresh in any flight-command path: the HTTP adapter starts it and returns 202.

`getContext` may also be async and may return `null`. It is read on each results/status request, not persisted as the authoritative current location. A provider error or 2-second timeout yields explicit unknown location. Pass only `systemName`/`StarSystem` and `StarPos`; there is no need to grant this module access to journals, input drivers, or autopilot functions. The host should clear/update its own context on journal/session changes rather than passing a stale location forever.

## 3. Authentication and renderer transport

The adapter requires an authentication callback. Reuse RoutePilot's existing authentication. A standalone helper `bearerAuthenticator(token)` is available; generate a high-entropy token (for example with `randomBytes(32).toString('hex')`) in your host rather than committing one to code. All POSTs are authenticated; reads are authenticated by default as well.

Requests must come from loopback and use a loopback Host. Cross-origin browser requests require an exact `allowedOrigins` match, including scheme and port. No wildcard origin is accepted. POSTs require JSON, with a 64 KiB body limit. Tokens never go in URLs.

For a renderer served from `http://127.0.0.1:47856`, default networking works with the existing token bridge:

```jsx
import MarketPanel from './ui/MarketPanel.jsx';

<MarketPanel
  getToken={readExistingApiToken}
  onOpenExternal={openValidatedSpanshStationUrl}
/>
```

Keep these callbacks stable (module-level or `useCallback`) to avoid recreating the polling client on parent renders. `onOpenExternal` should use the existing trusted Electron bridge and validate `https:`, exact host `spansh.co.uk`, and path `/station/<digits>` before calling `shell.openExternal`.

**`file://` Electron renderers:** their `Origin: null` is intentionally not trusted by default. Do not disable Electron security, enable broad Node integration, or blindly add `null`/`*` to bypass CORS. Use your app's trusted served/custom renderer origin with the correct origin allowlist, or inject its existing narrowly scoped preload/main HTTP transport via the panel's `fetchImpl` prop. That transport must return a standard Fetch `Response` and enforce the allowed market endpoint URLs; it is a host integration binding, not an unrestricted network or game-input bridge. A custom `app://` origin additionally requires your existing Electron scheme registration/Fetch permissions. This package does not change BrowserWindow or protocol configuration.

Optional panel props: `baseUrl` (default `http://127.0.0.1:47856/api/markets`), `fetchImpl`, `getToken`, `pollMs` (default 3000), `onOpenExternal`. There are no required props tied to your app's state manager. All three UI files must remain together or have their relative imports adjusted.

## 4. Endpoints

| Method / endpoint | Request | Response |
| --- | --- | --- |
| GET `/api/markets/status` | No query | Settings, current context, last report, progress, last error, scheduler. |
| GET `/api/markets/results` | Validated result query | Paginated `{rows,total,hasMore,...}` with current ages/context. |
| GET `/api/markets/export` | Same query | UTF-8 protected CSV containing **all** matching rows. |
| POST `/api/markets/refresh` | `{}` | 202 status snapshot. Poll status for the eventual outcome. Duplicate starts coalesce. |
| POST `/api/markets/cancel` | `{}` | `{accepted,status}`. False when idle/already cancelling/committing. |
| POST `/api/markets/settings` | Settings patch | `{settings}` after atomic save. |

Example query: `?list=affordable&sort=loadProfit&limit=100&offset=0&maxRouteDistanceLy=50&requiredPad=L`. Nullable options use the literal `null`; booleans use `true`/`false`; blank numeric values are rejected. API values are credits, tonnes, hours, and light-years as named. Unknown fields are rejected rather than silently ignored.

`LOCATION_UNAVAILABLE` is HTTP 409. Invalid settings/query → 400; authentication → 401; untrusted origin/host → 403; wrong content type → 415; oversized body → 413. Response errors are `{error:{code,message}}`. Operational refresh failures appear in `status.lastAttempt`, not as a retroactive error on the already-returned 202 response.

The UI disables closest-seller ranking without `StarPos` and explicitly overrides a saved player-radius filter to `null` while the position is unknown. It warns that this filter is temporarily inactive. Other direct callers must explicitly remove that filter or receive 409; the backend never silently makes up a location.

## 5. Verification in RoutePilot

Run `npm test` before changing integration, then run the same tests after copying/adjusting import paths. Run the live probe from a working network. In the actual host, check authenticated panel loading, refresh/cancel, 100-row pagination, CSV, settings after restart, startup catch-up, source links, and loss/recovery of journal position. Verify your existing flight controls/routes still behave exactly as before. The package includes mocked/non-game tests, not a claim that your uninspected app or Windows GUI has already passed those checks.
