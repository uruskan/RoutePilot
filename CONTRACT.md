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
