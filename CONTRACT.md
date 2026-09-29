# Interface contract

HTTP localhost:47856. GET /api/state returns the snapshot below. GET /api/session returns {token}. POST /api/command with JSON {action:"start"|"stop"|"save"|"shutdown"}, X-RoutePilot-Token header and same Origin (or absent Origin for local test clients). Response {ok,message}; errors have non-2xx HTTP status. No mutations through GET. Static public/ only. Route commands never auto-retry.

Snapshot shape (null for unknown numbers/strings):
```
{
 app:{name:"RoutePilot",version:"0.1.0"},
 engine:{status:"offline|loading|ready|running|stopped|completed|error",phase:"idle|align|jump|refuel|clearance|depart|complete|paused|error",message:string,connected:boolean},
 telemetry:{system,ship,fuel,fuelCapacity,hull,supercruise:boolean,landed:boolean,docked:boolean,inMainShip:boolean,guiFocus:number,observedAt},
 route:{available:boolean,destination,nextSystem,remaining,total,completed,distanceRemaining,systems:[{name,starClass}],source:"journal"},
 checks:[{id,label,ok:boolean,detail}],
 activity:[{id,time,level:"info|success|warning|error",title,detail}],
 controls:{canStart:boolean,canStop:boolean,startReason:string},
 settings:{autoSave:true,unlimitedJumps:true,stopAtDestination:true}
}
```

Bridge launched by Node with existing EDAP venv Python, absolute bridge/worker.py path and --engine-root PATH. Line-delimited JSON stdin commands {id,action}; stdout protocol only: {type:"state",status,phase,message}, {type:"event",level,title,detail,time?}, {type:"result",id,ok,message}. All native/model diagnostics redirect stderr. Worker starts with assists OFF and sends ready once initialization completes. Reads stop/shutdown during loading and cancels pending start. No pending start after failed initialization. Parent disconnect/shutdown stops engine. Explicit start only; no auto-resume. Bridge enforces independent cockpit/ship/route eligibility and foreground/binding guards. Existing GUI lock conflict is a clear error, never a second engine. Run commands on a serialized control path, but stop is immediate and not queued behind heavy model work.

Node starts bridge lazily on explicit start (or internal developer readiness probe with no start command). First start initializes then performs one explicit start only if still eligible and not cancelled. Polling snapshots does not initialize or control the engine. Worker is persistent after a run. Server reads journal/status independently for idle dashboard. Route finished means no remaining systems after current position in the latest active NavRoute; account for NavRouteClear/route changes, stale old FSDTarget and final FSDJump.

Test fixtures must not use actual game input. Tests may inject fake worker and temporary journal directories. UI fetches /api/state about once a second, pauses retry only on disconnection, and displays actual missing/blocked states. Phase text and controls are Turkish. README must state new bridge/UI has not yet completed a live flight even though the reused engine has.

Market feature: `features/markets/server/markets.mjs` owns `work/markets` and never imports flight code. `/api/markets/*` mounts in the existing server; GETs and POSTs use `Authorization: Bearer <existing session token>`, exact local Origin checks, and loopback Host checks. Existing flight endpoints retain their original X-RoutePilot-Token protocol. See `features/markets/docs/INTEGRATION.md` for response/query schemas. Telemetry adds `position: [x,y,z] | null` from Location/FSDJump/CarrierJump; LoadGame/Shutdown/new journal files clear stale coordinates. Service startup awaits scanner readiness, then starts its opt-in scheduler; shutdown cancels scanner work and closes the engine independently. The markets CLI uses HTTP, not a competing direct storage writer. UI source links may open only https://spansh.co.uk/station/<digits>; renderer security remains unchanged.

Spreadsheet presets (2026-09-29): the RoutePilot host injects SPREADSHEET_DEFAULT_SETTINGS from features/markets/presets.mjs. Nearby trades (100 t / 48 h / 150 ly) and Highest buyers (1 t / 192 h / unlimited distance) both select the best qualifying buyer for all stock and rank by stockProfit. Collection window is 192 hours; no preset contains historical coordinates. defaultSort is a validated persisted setting, used when results/export omit sort. Preset patches preserve ship/budget; generic reusable-library defaults are kept separately. Missing new settings inherit host defaults; existing customized values survive startup.

Large market snapshots use a small `report.json` manifest and an owned `stations-<snapshot UUID>.ndjson` file. Stations are written and read individually to avoid Node's single-string size limit on eight-day datasets. The station file is synced first; the manifest is committed atomically last. Cancelled/failed candidates retain the previous report. Legacy reports containing a stations array still load and migrate on the next refresh. Public results and CSV recompute from source stations; redundant frozen opportunity rows are no longer persisted.
