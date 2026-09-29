#!/usr/bin/env node
/** Standalone CLI; no Electron, UI, journal scraping or game automation. */
import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { MarketService, ValidationError, coordinates, parseResultQuery } from '../server/markets.mjs';

export const HELP = `RoutePilot market scanner (Node.js 22+)

  node cli/markets.mjs <command> [options]

Commands:
  refresh     Fetch a NEW rolling snapshot; preserve the last report on failure.
  results     Read/recompute the committed report (JSON; no network).
  export      Export ALL filtered rows as protected CSV.
  status      Show persisted status (use app HTTP status for another process's live progress).
  settings    Read settings, or atomically merge --patch / explicit options.
  watch       Run daily refresh while this process runs; Ctrl+C stops it.

Common:
  --root PATH                  Dedicated scanner directory; never the app's main data file.
  --system NAME --position=x,y,z  Explicit read-only current location; never guessed.
  --context-file PATH          JSON {"systemName":"...","StarPos":[x,y,z]}; read anew on use.
  --cargo N --credits N --reserve N
  --min-stock N --max-age HOURS --pad any|S|M|L
  --max-from-me LY --max-route LY
  --allow-unknown-pad true|false --allow-permits true|false
  --allow-surface true|false --exclude-corrosive true|false
  --sort closestSeller|shortestRoute|margin|loadProfit|stockProfit
  --list all|affordable --limit N --offset N
  --output PATH                export only; defaults to stdout.
  --quiet                      Suppress refresh progress on stderr.
  --help

Persistent collection/scheduling (settings, refresh or watch):
  --window-hours N --daily true|false --utc-hour 0..23
  --patch '{"pageSize":500,...}'  JSON settings patch; or --patch-file PATH.

Null-capable numeric options accept 'null' (no age/radius filter; unknown credits/cargo).
Trading options are per-query for results/export and persisted for settings/refresh/watch.
Daily scheduling is UTC. watch does NOT silently enable the saved daily preference.
Default root: LOCALAPPDATA/RoutePilot/markets, or ~/.routepilot/markets.
Exit codes: 0 success; 1 operation/validation failure; 2 cancelled refresh.
`;
const stringOptions = ['root', 'system', 'position', 'context-file', 'cargo', 'credits', 'reserve',
  'min-stock', 'max-age', 'pad', 'max-from-me', 'max-route', 'allow-unknown-pad', 'allow-permits',
  'allow-surface', 'exclude-corrosive', 'sort', 'list', 'limit', 'offset', 'output',
  'window-hours', 'daily', 'utc-hour', 'patch', 'patch-file'];
const optionSchema = Object.fromEntries(stringOptions.map(key => [key, { type: 'string' }]));
optionSchema.help = { type: 'boolean', short: 'h' }; optionSchema.quiet = { type: 'boolean' };
const tradeMap = { cargo: 'cargoCapacity', credits: 'credits', reserve: 'creditReserve', 'min-stock': 'minStock',
  'max-age': 'maxMarketAgeHours', pad: 'requiredPad', 'max-from-me': 'maxPlayerDistanceLy',
  'max-route': 'maxRouteDistanceLy', 'allow-unknown-pad': 'allowUnknownPad', 'allow-permits': 'allowPermitSystems',
  'allow-surface': 'allowPlanetary', 'exclude-corrosive': 'excludePotentiallyCorrosive',
  sort: 'sort', list: 'list', limit: 'limit', offset: 'offset' };
function defaultRoot() { return process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'RoutePilot', 'markets') : join(homedir(), '.routepilot', 'markets'); }

export async function runCLI(args, { fetchImpl = globalThis.fetch, now = Date.now,
  stdout = process.stdout, stderr = process.stderr, signal } = {}) {
  let service, progressTimer;
  const print = value => stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  try {
    const { values, positionals } = parseArgs({ args, options: optionSchema, allowPositionals: true, strict: true });
    const command = positionals[0] || 'help';
    if (values.help || command === 'help') { stdout.write(HELP); return 0; }
    if (positionals.length !== 1 || !['refresh', 'results', 'export', 'status', 'settings', 'watch'].includes(command)) throw new ValidationError('Choose one valid command. Use --help.');
    if (values['context-file'] && (values.position !== undefined || values.system !== undefined)) throw new ValidationError('Use either --context-file or --system/--position, not both.');
    let explicitPosition = null;
    if (values.position !== undefined) {
      explicitPosition = coordinates(values.position.split(','));
      if (!explicitPosition) throw new ValidationError('--position must have three finite coordinates; missing coordinates are not zero.');
    }
    const getContext = values['context-file'] ? async () => JSON.parse(await readFile(resolve(values['context-file']), 'utf8')) :
      () => ({ systemName: values.system ?? null, StarPos: explicitPosition });
    const params = new URLSearchParams();
    for (const [flag, key] of Object.entries(tradeMap)) if (values[flag] !== undefined) params.set(key, values[flag]);
    const query = parseResultQuery(params);
    const writable = ['refresh', 'settings', 'watch'].includes(command);
    if (!writable && ['window-hours', 'daily', 'utc-hour', 'patch', 'patch-file'].some(key => values[key] !== undefined)) throw new ValidationError('Collection/scheduler patches require settings, refresh or watch.');
    if (values.output !== undefined && command !== 'export') throw new ValidationError('--output is only valid for export.');
    if (command === 'status' && Object.keys(query).length) throw new ValidationError('status does not accept trading filters.');
    if (writable && ['sort', 'list', 'limit', 'offset'].some(key => Object.hasOwn(query, key))) throw new ValidationError('sort/list/limit/offset are results/export options, not persistent settings.');
    if (values.patch && values['patch-file']) throw new ValidationError('Use --patch or --patch-file, not both.');
    let patch = values.patch ? JSON.parse(values.patch) : values['patch-file'] ? JSON.parse(await readFile(resolve(values['patch-file']), 'utf8')) : {};
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new ValidationError('The settings patch must be an object.');
    if (writable) patch = { ...patch, ...query };
    for (const [flag, key] of [['window-hours', 'windowHours'], ['utc-hour', 'dailyUtcHour']]) {
      if (values[flag] !== undefined) {
        if (!values[flag].trim()) throw new ValidationError(`--${flag} requires a number.`);
        patch[key] = Number(values[flag]);
      }
    }
    if (values.daily !== undefined) {
      if (!['true', 'false'].includes(values.daily)) throw new ValidationError('--daily must be true or false.');
      patch.dailyRefresh = values.daily === 'true';
    }
    service = new MarketService({ root: values.root || defaultRoot(), fetchImpl, now, getContext, readOnly: !writable });
    await service.ready;
    if (writable && Object.keys(patch).length) await service.configure(patch);
    const cancel = () => service.cancel();
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      if (command === 'results') print(await service.results(query));
      else if (command === 'status') print(await service.status());
      else if (command === 'settings') print((await service.status()).settings);
      else if (command === 'export') {
        const csv = await service.csv(query);
        if (values.output) {
          const path = resolve(values.output); await mkdir(dirname(path), { recursive: true });
          await writeFile(path, csv, { encoding: 'utf8', mode: 0o600 });
          stderr.write(`CSV written: ${path}\n`);
        } else stdout.write(csv);
      } else if (command === 'refresh') {
        if (signal?.aborted) return 2;
        if (!values.quiet) {
          let polling = false;
          progressTimer = setInterval(async () => {
            if (polling) return;
            polling = true;
            try { const status = await service.status(); stderr.write(`${JSON.stringify(status.refresh)}\n`); } catch {} finally { polling = false; }
          }, 1_000);
        }
        const result = await service.refresh(); print(result);
        return result.outcome === 'succeeded' ? 0 : result.outcome === 'cancelled' ? 2 : 1;
      } else if (command === 'watch') {
        if (!(await service.status()).settings.dailyRefresh) throw new ValidationError('Daily refresh is disabled. Use watch --daily true, or enable it in settings first.');
        if (signal?.aborted) return 0;
        await service.startScheduler({ keepAlive: true });
        stderr.write('Daily scanner running; deadlines are UTC. Ctrl+C stops this process.\n');
        await new Promise(resolvePromise => {
          if (signal?.aborted) resolvePromise();
          else signal?.addEventListener('abort', resolvePromise, { once: true });
        });
      }
      return 0;
    } finally { signal?.removeEventListener('abort', cancel); }
  } catch (error) {
    stderr.write(`${error.code || 'ERROR'}: ${error.message}\n`);
    return 1;
  } finally {
    clearInterval(progressTimer);
    if (service) await service.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  process.exitCode = await runCLI(process.argv.slice(2), { signal: controller.signal });
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
}
