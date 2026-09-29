import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createMarketClient, settingsToDraft, draftToPatch, formatNumber, formatAge } from './market-client.mjs';
import './MarketPanel.css';
import { SPREADSHEET_PRESETS } from '../presets.mjs';
import { ArrowDownToLine, ChevronDown, MapPin, RefreshCw, SlidersHorizontal } from 'lucide-react';
import TradeCard from './TradeCard.jsx';

const SORT_LABELS = {
  closestSeller: 'Closest to me', shortestRoute: 'Shortest trade route',
  margin: 'Profit per tonne', loadProfit: 'Profit per load',
  stockProfit: 'Total stock profit',
};
const noToken = () => null;
const timeLabel = value => value ? new Date(value).toLocaleString() : 'Never';

/**
 * Isolated, read-only-to-the-game trading UI. getToken is supplied by your existing
 * authenticated transport/preload bridge. No dependency on RoutePilot app state.
 */
export default function MarketPanel({ baseUrl = 'http://127.0.0.1:47856/api/markets',
  getToken = noToken, fetchImpl = globalThis.fetch, pollMs = 3_000, onOpenExternal }) {
  const id = useId();
  const client = useMemo(() => createMarketClient({ baseUrl, getToken, fetchImpl }), [baseUrl, getToken, fetchImpl]);
  const [status, setStatus] = useState(null), [report, setReport] = useState(null);
  const [draft, setDraft] = useState(null), [list, setList] = useState('all');
  const savedSort = status?.settings.defaultSort || 'stockProfit';
  const sort = savedSort === 'closestSeller' && !status?.context.positionAvailable ? 'stockProfit' : savedSort;
  const activePreset = status && Object.values(SPREADSHEET_PRESETS).find(preset =>
    Object.entries(preset.settings).every(([key, value]) => (key === 'defaultSort' ? savedSort : status.settings[key]) === value));
  const [offset, setOffset] = useState(0), [revision, setRevision] = useState(0);
  const [readError, setReadError] = useState(''), [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const mounted = useRef(false), actions = useRef(new Set()), downloadUrls = useRef(new Set());
  const reload = () => setRevision(value => value + 1);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const controller of actions.current) controller.abort();
      for (const url of downloadUrls.current) URL.revokeObjectURL(url);
      downloadUrls.current.clear();
    };
  }, []);

  // One poll at a time. Cleanup aborts stale requests on unmount/filter changes;
  // React Strict Mode can mount/unmount this effect without leaking timers.
  useEffect(() => {
    const controller = new AbortController(); let timer;
    async function poll() {
      let running = false;
      try {
        const next = await client.status(controller.signal);
        if (controller.signal.aborted) return;
        if (!next?.settings || !next?.refresh || !next?.context) throw new Error('Invalid market status response.');
        setStatus(next); setDraft(current => current ?? settingsToDraft(next.settings));
        running = next.refresh.running;
        const preferredSort = next.settings.defaultSort || 'stockProfit';
        const currentSort = !next.context.positionAvailable && preferredSort === 'closestSeller' ? 'stockProfit' : preferredSort;
        const query = { sort: currentSort, list, limit: 100, offset,
          ...(next.context.positionAvailable ? {} : { maxPlayerDistanceLy: null }) };
        const results = await client.results(query, controller.signal);
        if (controller.signal.aborted) return;
        if (!Array.isArray(results?.rows)) throw new Error('Invalid market results response.');
        setReport(results); setReadError('');
        // Expiring filters can shrink the result set while the user is on a later page.
        if (offset > 0 && offset >= results.total) setOffset(0);
      } catch (error) {
        if (!controller.signal.aborted) setReadError(error.message || 'Could not load markets.');
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, running ? Math.min(Math.max(pollMs, 500), 1_000) : Math.max(pollMs, 1_000));
      }
    }
    poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [client, sort, list, offset, revision, pollMs]);

  async function action(fn) {
    if (busy) return;
    const controller = new AbortController(); actions.current.add(controller);
    setBusy(true); setActionError(''); setNotice('');
    try { await fn(controller.signal); if (mounted.current) reload(); }
    catch (error) { if (mounted.current && !controller.signal.aborted) setActionError(error.message || 'Market action failed.'); }
    finally { actions.current.delete(controller); if (mounted.current) setBusy(false); }
  }
  function setField(key, value) { setDraft(current => ({ ...current, [key]: value })); }
  async function applyPreset(preset) {
    await action(async signal => {
      const result = await client.configure(preset.settings, signal);
      if (mounted.current) {
        setStatus(current => ({ ...current, settings: result.settings }));
        setDraft(settingsToDraft(result.settings)); setOffset(0); setList('all');
        setNotice('Query saved. Your ship and budget settings are unchanged.');
      }
    });
  }
  async function save(event) {
    event.preventDefault();
    await action(async signal => {
      const result = await client.configure(draftToPatch(draft), signal);
      if (mounted.current) { setStatus(current => ({ ...current, settings: result.settings })); setDraft(settingsToDraft(result.settings)); setOffset(0); setNotice('Settings saved. Trading filters and budget apply immediately; window changes apply on the next refresh.'); }
    });
  }
  async function exportCsv() {
    await action(async signal => {
      const query = { sort, list, ...(status?.context.positionAvailable ? {} : { maxPlayerDistanceLy: null }) };
      const blob = await client.csv(query, signal);
      if (!mounted.current) return;
      const url = URL.createObjectURL(blob); downloadUrls.current.add(url);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'routepilot-trades.csv';
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      setTimeout(() => { URL.revokeObjectURL(url); downloadUrls.current.delete(url); }, 10_000);
      setNotice('CSV exported with all matching rows, not only the current page.');
    });
  }
  const running = Boolean(status?.refresh.running), positionKnown = Boolean(status?.context.positionAvailable);
  const failed = status?.lastAttempt && ['failed', 'cancelled', 'interrupted'].includes(status.lastAttempt.outcome);
  const numericField = (key, label, { nullable = false, min = 0, max, step = 1, disabled = false, hint } = {}) =>
    <label className="rp-market-field" htmlFor={`${id}-${key}`}>
      <span>{label}</span>
      <input id={`${id}-${key}`} type="number" min={min} max={max} step={step} disabled={disabled}
        required={!nullable} value={draft?.[key] ?? ''} placeholder={nullable ? 'Unknown / no limit' : ''}
        onChange={event => setField(key, event.target.value)} />
      {hint && <small>{hint}</small>}
    </label>;
  const checkbox = (key, label) => <label className="rp-market-check">
    <input type="checkbox" checked={Boolean(draft?.[key])} onChange={event => setField(key, event.target.checked)} />{label}
  </label>;

  return <section className="rp-market" aria-labelledby={`${id}-heading`}>
    <header className="rp-market-header">
      <div><p className="rp-market-eyebrow">CARRIER MARKET SCANNER</p><h2 id={`${id}-heading`}>Find your next trade</h2>
        <p>See what a load earns, where to go, and what it takes to get there.</p></div>
      <div className="rp-market-actions">
        <button type="button" className="rp-market-primary" disabled={busy || running || !status} onClick={() => action(signal => client.refresh(signal))}><RefreshCw size={15} aria-hidden="true" />{running ? 'Refreshing…' : 'Refresh markets'}</button>
        {running && <button type="button" disabled={busy || !status?.refresh.canCancel} onClick={() => action(async signal => {
          const result = await client.cancel(signal); if (mounted.current) setNotice(result.accepted ? 'Cancellation requested. The previous successful report is retained.' : 'No cancellable refresh; an atomic save may already be finishing.');
        })}>Cancel refresh</button>}
        <button type="button" className="rp-market-export" disabled={busy || !report?.hasReport} onClick={exportCsv}><ArrowDownToLine size={15} aria-hidden="true" />Export CSV</button>
      </div>
    </header>

    <div className="rp-market-location"><MapPin size={15} aria-hidden="true" /><span>From <strong>{status?.context.systemName || 'Unknown location'}</strong></span>
      <span className="rp-market-collected" title={`Collection time: ${timeLabel(status?.report?.collectedAt)}. Individual quote ages appear on each trade.`}>{status?.report?.collectedAt ? `Snapshot ${formatAge(Math.max(0, (Date.now() - Date.parse(status.report.collectedAt)) / 3_600_000))}` : 'No snapshot yet'}</span>
    </div>
    {running && <div className="rp-market-progress" role="status" aria-live="polite">
      <progress aria-label="Market refresh progress" />
      <span>{status.refresh.phase} · {formatNumber(status.refresh.stations ?? 0)} stations · {formatNumber(status.refresh.requests ?? 0)} requests · {formatNumber(status.refresh.pages ?? 0)} pages · {formatNumber(status.refresh.splits ?? 0)} splits · {formatNumber(status.refresh.retries ?? 0)} retries
        {status.refresh.detailsTotal > 0 && ` · details ${status.refresh.detailsCompleted}/${status.refresh.detailsTotal}`}
        {status.refresh.rateLimitWaitMs > 0 && ` · pacing for ${(status.refresh.rateLimitWaitMs / 1_000).toFixed(1)} s`}</span>
    </div>}
    {(readError || actionError) && <div className="rp-market-error" role="alert">{actionError || readError}{readError && report && ' Previously displayed rows are retained; they have not been updated.'}</div>}
    {notice && <p className="rp-market-notice" role="status">{notice}</p>}
    {failed && <div className="rp-market-warning" role="status">
      Last refresh: {status.lastAttempt.outcome}. {status.lastAttempt.error?.message}
      {status.hasReport ? ' The last successful report is still available; quote ages continue to increase.' : ' No successful report is available yet.'}
      {status.lastAttempt.error?.code === 'INCOMPLETE_COVERAGE' && <details><summary>Coverage diagnostics</summary><pre>{JSON.stringify(status.lastAttempt.error.details, null, 2)}</pre></details>}
    </div>}
    {!positionKnown && <p className="rp-market-warning">{status?.context.warning || 'Current position is unknown.'} Closest-seller ranking is disabled. A saved distance-from-me limit is inactive until valid StarPos is available. Seller → buyer distance still works when both markets have coordinates.</p>}
    {status?.scheduler.enabled && !status.scheduler.started && <p className="rp-market-warning">Daily refresh is enabled, but the host has not called startScheduler().</p>}
    {status?.warnings.map((warning, index) => <p className="rp-market-warning" key={index}>{warning}</p>)}
    {status?.report?.window && new Date(status.report.window.end) - new Date(status.report.window.start) < status.settings.windowHours * 3_600_000 - 1000 &&
      <p className="rp-market-warning">The saved scan covers fewer than {formatNumber(status.settings.windowHours)} hours. Refresh markets to search the full selected window.</p>}

    <div className="rp-market-presets" aria-label="Spreadsheet queries">
      <div className="rp-market-preset-buttons">{Object.entries(SPREADSHEET_PRESETS).map(([key, preset]) =>
        <button key={key} data-preset={key} type="button" aria-pressed={activePreset === preset} disabled={busy || !status} onClick={() => applyPreset(preset)} title={preset.description}>{key === 'nearby' ? 'Short trade routes' : 'Highest buyers'}</button>)}</div>
      <span>{activePreset ? (activePreset === SPREADSHEET_PRESETS.nearby ? '100 t minimum · 48 h quotes · up to 150 ly between markets' : 'All lot sizes · 8-day quotes · unlimited route distance') : 'Custom query'}<small>Presets from your spreadsheet · distance from you is separate</small></span>
    </div>

    {draft && <details className="rp-market-settings-shell"><summary><SlidersHorizontal size={17} aria-hidden="true" /><strong>Ship & filters</strong><span>{status.settings.cargoCapacity === null ? 'Cargo unknown' : `${formatNumber(status.settings.cargoCapacity)} t cargo`} · {status.settings.requiredPad === 'any' ? 'Any pad' : `${status.settings.requiredPad} pad`} · {status.settings.maxPlayerDistanceLy === null ? 'Any distance from you' : `Within ${formatNumber(status.settings.maxPlayerDistanceLy)} ly of you`}</span><ChevronDown size={16} aria-hidden="true" /></summary>
      <form onSubmit={save} className="rp-market-settings">
      <fieldset disabled={busy}><legend>Ship, budget and trading filters</legend><p>Ship and budget are editable planning inputs. Spreadsheet starting values: 16 t cargo, 220M Cr, 20M Cr reserve.</p><div className="rp-market-form-grid">
        {numericField('cargoCapacity', 'Cargo capacity (t)', { nullable: true, hint: 'Empty means unknown, not zero.' })}
        {numericField('credits', 'Available credits (Cr)', { nullable: true })}
        {numericField('creditReserve', 'Protected reserve (Cr)')}
        {numericField('minStock', 'Minimum seller stock (t)', { min: 1, hint: 'The buyer must also have demand for ALL seller stock.' })}
        {numericField('maxPlayerDistanceLy', 'Maximum distance from me (ly)', { nullable: true, step: 'any', disabled: !positionKnown, hint: 'Player → seller only.' })}
        {numericField('maxRouteDistanceLy', 'Maximum market route (ly)', { nullable: true, step: 'any', hint: 'Seller → buyer only.' })}
        {numericField('maxMarketAgeHours', 'Maximum market age (hours)', { nullable: true, step: 'any', hint: 'Both endpoints; blank includes unknown/stale quotes.' })}
        <label className="rp-market-field" htmlFor={`${id}-pad`}><span>Required landing pad</span><select id={`${id}-pad`} value={draft.requiredPad} onChange={event => setField('requiredPad', event.target.value)}>
          <option value="any">Any / no pad filter</option><option value="S">Small ship</option><option value="M">Medium ship</option><option value="L">Large ship</option>
        </select></label>
      </div><div className="rp-market-checkboxes">
        {checkbox('allowUnknownPad', 'Allow unknown pad capability')}{checkbox('allowPermitSystems', 'Include permit/unknown-permit systems')}
        {checkbox('allowPlanetary', 'Include surface/unknown-surface markets')}{checkbox('excludePotentiallyCorrosive', 'Exclude potentially corrosive cargo')}
      </div></fieldset>
      <fieldset disabled={busy}><legend>Collection and daily refresh</legend><div className="rp-market-form-grid rp-market-form-small">
        {numericField('windowHours', 'Rolling collection window (hours)', { min: 1 / 60, max: 720, step: 'any', hint: 'Re-queried on every refresh. Older buyers are outside this scan.' })}
        {numericField('dailyUtcHour', 'Daily refresh hour (UTC)', { min: 0, max: 23 })}
        <div className="rp-market-field">{checkbox('dailyRefresh', 'Enable daily refresh while running')}<small>Startup catch-up and failure backoff are automatic.</small></div>
      </div></fieldset>
      <div className="rp-market-actions"><button type="submit" disabled={busy}>Apply settings</button><button type="button" disabled={busy || !status} onClick={() => setDraft(settingsToDraft(status.settings))}>Reset unsaved edits</button></div>
    </form></details>}

    <div className="rp-market-results-heading"><div><h3>{report ? formatNumber(report.total) : '—'} opportunities</h3><p>Independent quotes. Total profits are conditional and cannot be added together.</p></div></div>
    <div className="rp-market-table-controls">
      <label htmlFor={`${id}-sort`}>Rank by <select id={`${id}-sort`} value={sort} disabled={busy || !status} onChange={event => {
        const defaultSort = event.target.value;
        action(async signal => {
          const result = await client.configure({ defaultSort }, signal);
          if (mounted.current) { setStatus(current => ({ ...current, settings: result.settings })); setOffset(0); }
        });
      }}>
        {Object.entries(SORT_LABELS).map(([key, label]) => <option key={key} value={key} disabled={key === 'closestSeller' && !positionKnown}>{label}</option>)}
      </select></label>
      <label htmlFor={`${id}-list`}>Show <select id={`${id}-list`} value={list} onChange={event => { setList(event.target.value); setOffset(0); }}>
        <option value="all">All opportunities</option><option value="affordable">Can afford at least 1 t</option>
      </select></label>
      <span>Buyer selection: highest eligible price, then shortest known route.</span>
    </div>
    {report?.hasReport && report.rows.length > 0 ? <div className="rp-market-cards" role="region" aria-label="Trading opportunities">
      {report.rows.map((row, index) => <TradeCard key={row.id} row={row} rank={offset + index + 1} currentSystem={positionKnown ? status.context.systemName : null} requiredPad={status.settings.requiredPad} onOpenExternal={onOpenExternal} />)}
    </div> : <p className="rp-market-empty">{!status ? 'Connecting to the local market service…' : !report?.hasReport ? 'No successful market snapshot yet. Refresh markets to collect data.' : 'No opportunities pass the current filters. No replacement rows have been fabricated.'}</p>}
    {report && <div className="rp-market-pagination">
      <button type="button" disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - 100))}>Previous 100</button>
      <span>{report.total ? `${formatNumber(offset + 1)}–${formatNumber(Math.min(offset + report.rows.length, report.total))} of ${formatNumber(report.total)}` : '0 matching rows'}</span>
      <button type="button" disabled={!report.hasMore} onClick={() => setOffset(value => value + 100)}>Next 100</button>
    </div>}
    <footer className="rp-market-footnotes"><details><summary>How these estimates work & source diagnostics <ChevronDown size={14} aria-hidden="true" /></summary>
      <p><strong>* Not a guaranteed payout.</strong> Full-stock profit assumes every advertised tonne can be bought and sold at the displayed prices. Trades can share the same buyer demand; do not add rows together. Trips use the initial affordable load without assuming reinvested profit.</p>
      <p><strong>Bulk-price risk is unmodeled.</strong> The scanner does not invent a demand threshold or price adjustment. Verify prices, stock, docking permissions, permits, cargo hazards and destination access before buying.</p>
      <p>Distances are straight-line light-years, not a jump route or travel-time estimate. A 0 ly same-system trade may still involve a long supercruise journey. Market timestamps come from the source, independently of the collection time above.</p>
      {report?.diagnostics && <details><summary>Source data quality and matching diagnostics</summary>
        <p>Missing or invalid values remain unknown. Finite age limits exclude unknown/future timestamps; active distance limits exclude missing coordinates.</p>
        <dl className="rp-market-diagnostics">{Object.entries(report.diagnostics).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{formatNumber(value)}</dd></div>)}</dl>
      </details>}
      {status?.report && <p>Collected window: {status.report.window?.start} → {status.report.window?.end}. Coverage: reconciled against returned API counts; not an atomic or galaxy-complete snapshot.</p>}
      <p>Daily refresh: {status?.scheduler.enabled ? `${String(status.scheduler.utcHour).padStart(2, '0')}:00 UTC · next ${timeLabel(status.scheduler.nextRunAt)}` : 'Disabled'}. Runs while RoutePilot stays open.</p>
    </details></footer>
  </section>;
}
