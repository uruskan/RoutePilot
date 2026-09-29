import fs from 'node:fs/promises';
import path from 'node:path';
import { createMarketClient } from '../features/markets/ui/market-client.mjs';
import { parseResultQuery } from '../features/markets/server/markets.mjs';

export const MARKET_HELP = `RoutePilot-CLI.cmd markets <command>
  status                         Refresh, saved settings and current location
  refresh [--no-wait]             Refresh public markets; show progress
  cancel                         Cancel refresh, retain last successful report
  list [--sort closestSeller]     Show trades (all API result filters accepted)
  export <file.csv> [--sort ...]  Export every matching row
  settings [--file settings.json] Read settings or apply a JSON settings patch
  daily on|off                   Enable/disable daily refresh while app runs
Examples:
  markets list --sort closestSeller --maxPlayerDistanceLy 500 --requiredPad L
  markets list --sort loadProfit --cargoCapacity 1232 --credits 220000000 --creditReserve 20000000
The RoutePilot service must already be running. No flight commands are sent.
Ctrl+C stops waiting only. Use markets cancel to cancel a server refresh.`;
const clean = value => String(value ?? 'Unknown').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
const num = value => Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: 1 }) : '?';

export async function runMarketCli(args, options = {}) {
  const out = options.out ?? console.log, err = options.err ?? console.error;
  const [command = 'status', ...rest] = args;
  if (['help', '--help', '-h'].includes(command)) { out(MARKET_HELP); return 0; }
  const controller = new AbortController(), signal = options.signal ?? controller.signal;
  const stop = () => controller.abort();
  if (!options.signal) { process.on('SIGINT', stop); process.on('SIGTERM', stop); }
  try {
    const base = new URL(options.baseUrl ?? 'http://127.0.0.1:47856');
    if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password) throw new Error('Only the local RoutePilot server is supported.');
    const fetchImpl = options.fetchImpl ?? fetch;
    const client = createMarketClient({ baseUrl: new URL('/api/markets', base).href, fetchImpl,
      getToken: async () => {
        const response = await fetchImpl(new URL('/api/session', base), { redirect: 'error', cache: 'no-store',
          signal: AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 5000)]) });
        const session = await response.json();
        if (!response.ok || typeof session.token !== 'string' || !session.token) throw new Error('RoutePilot session unavailable.');
        return session.token;
      } });
    if (command === 'status' && !rest.length) out(JSON.stringify(await client.status(signal), null, 2));
    else if (command === 'cancel' && !rest.length) out(JSON.stringify(await client.cancel(signal), null, 2));
    else if (command === 'daily' && rest.length === 1 && ['on', 'off'].includes(rest[0])) {
      await client.configure({ dailyRefresh: rest[0] === 'on' }, signal);
      out(`Daily refresh ${rest[0]}; it runs only while RoutePilot is open.`);
    } else if (command === 'settings' && (rest.length === 0 || (rest.length === 2 && rest[0] === '--file'))) {
      const value = rest.length ? await client.configure(JSON.parse(await fs.readFile(rest[1], 'utf8')), signal) : await client.status(signal);
      out(JSON.stringify(value.settings, null, 2));
    } else if (command === 'refresh' && (rest.length === 0 || (rest.length === 1 && rest[0] === '--no-wait'))) {
      let state = await client.refresh(signal);
      out('Market refresh accepted. Flight controls are unchanged.');
      if (rest.length) return 0;
      let previous = '';
      while (state.refresh.running) {
        const progress = state.refresh;
        const line = `${progress.phase}: ${progress.pages ?? 0} pages, ${progress.stations ?? 0} stations, ${progress.requests ?? 0} requests`;
        if (line !== previous) { out(line); previous = line; }
        await new Promise(resolve => {
          const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, options.pollMs ?? 1000);
          signal.addEventListener('abort', done, { once: true });
          if (signal.aborted) done();
        });
        if (signal.aborted) { out('Stopped waiting. Server refresh continues; use markets cancel to stop it.'); return 0; }
        state = await client.status(signal);
      }
      out(JSON.stringify(state.lastAttempt, null, 2));
      return state.lastAttempt?.outcome === 'succeeded' ? 0 : 1;
    } else if (['list', 'export'].includes(command)) {
      const flags = [...rest], destination = command === 'export' ? flags.shift() : null;
      if (command === 'export' && (!destination || destination.startsWith('--'))) throw new Error('export requires a destination CSV path.');
      const params = new URLSearchParams();
      while (flags.length) {
        const key = flags.shift(), value = flags.shift();
        if (!key.startsWith('--') || value === undefined || value.startsWith('--')) throw new Error('Filters use --name value.');
        params.append(key.slice(2), value);
      }
      const query = parseResultQuery(params);
      if (command === 'export') {
        const blob = await client.csv(query, signal);
        const file = path.resolve(destination);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, await blob.text(), 'utf8');
        out(`CSV saved: ${file}`);
      } else {
        const report = await client.results({ limit: 20, ...query }, signal);
        out(`${report.total} matching lots; showing ${report.rows.length}. Location: ${clean(report.context?.systemName)}.`);
        for (const row of report.rows) {
          out(`${clean(row.commodity)} | ${clean(row.seller.displayName)} (${clean(row.seller.systemName)}) → ${clean(row.buyer.displayName)} (${clean(row.buyer.systemName)})`);
          out(`  Stock ${num(row.stock)} t | Margin ${num(row.marginPerTonne)} Cr/t | Load profit ${num(row.profitPerLoad)} Cr | To seller ${num(row.playerToSellerLy)} ly | Route ${num(row.sellerToBuyerLy)} ly`);
        }
        out('Reported quotes can change. Full-stock profits are conditional and not additive.');
      }
    } else { err(MARKET_HELP); return 2; }
    return 0;
  } catch (error) {
    if (signal.aborted) { out('Stopped waiting. No cancellation or flight command sent.'); return 0; }
    err(`Markets: ${clean(error.message)} No mutation was automatically retried.`);
    return 1;
  } finally {
    if (!options.signal) { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  }
}
