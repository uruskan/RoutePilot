import React, { useId } from 'react';
import { ArrowRight, ArrowUpRight, Box, ChevronDown, MapPin, ShieldAlert } from 'lucide-react';
import { formatNumber, formatAge } from './market-client.mjs';
import { sameSystem, routeDistanceLabel, tradeAccessWarnings } from './trade-presentation.mjs';

const credits = value => Number.isFinite(value) ? `${formatNumber(value)} Cr` : 'Unknown';
const compactCredits = value => Number.isFinite(value)
  ? `${new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 2 }).format(value)} Cr`
  : 'Set ship & budget';

function SourceLink({ station, onOpenExternal }) {
  return <a href={station.sourceUrl} target="_blank" rel="noopener noreferrer" onClick={event => {
    if (onOpenExternal) { event.preventDefault(); onOpenExternal(station.sourceUrl); }
  }}>{station.displayName || station.name}<ArrowUpRight size={13} aria-hidden="true" /></a>;
}

function Endpoint({ station, side, price, onOpenExternal }) {
  return <div className={`rp-trade-endpoint rp-trade-${side}`}>
    <span className="rp-trade-label">{side === 'seller' ? '01 / BUY FROM' : '02 / SELL TO'}</span>
    <SourceLink station={station} onOpenExternal={onOpenExternal} />
    <span className="rp-trade-system">{station.systemName || 'System unknown'}</span>
    <div className="rp-trade-endpoint-meta"><span>{credits(price)} / t</span><span>{station.knownPad ? `Pad ${station.knownPad}` : 'Pad unknown'} · quote {formatAge(station.marketAgeHours)}</span></div>
  </div>;
}

function SourceDetail({ station, label, onOpenExternal }) {
  return <div className="rp-trade-source"><h4>{label}</h4><SourceLink station={station} onOpenExternal={onOpenExternal} />
    <dl>
      <div><dt>System</dt><dd>{station.systemName || 'Unknown'}</dd></div>
      <div><dt>Type</dt><dd>{station.type || 'Unknown'}</dd></div>
      <div><dt>From arrival star</dt><dd>{Number.isFinite(station.arrivalDistanceLs) ? `${formatNumber(station.arrivalDistanceLs)} ls` : 'Unknown'}</dd></div>
      <div><dt>Quote timestamp</dt><dd>{station.marketUpdatedAt ? <time dateTime={station.marketUpdatedAt}>{new Date(station.marketUpdatedAt).toLocaleString()}</time> : 'Unknown'}</dd></div>
      <div><dt>Docking access</dt><dd>{station.dockingAccess || (station.publicDocking === true ? 'Public' : 'Unknown')}</dd></div>
      <div><dt>Permit</dt><dd>{station.needsPermit === true ? 'Required' : station.needsPermit === false ? 'Not required' : 'Unknown'}</dd></div>
      <div><dt>Market ID / callsign</dt><dd>{station.id}{station.name !== station.displayName ? ` / ${station.name}` : ''}</dd></div>
    </dl>
  </div>;
}

export default function TradeCard({ row, rank, currentSystem, requiredPad, onOpenExternal }) {
  const id = useId();
  const local = sameSystem(row.seller.systemName, row.buyer.systemName);
  const accessWarnings = tradeAccessWarnings(row, requiredPad);
  return <article className="rp-trade-card" aria-labelledby={`${id}-name`}>
    <div className="rp-trade-top">
      <div className="rp-trade-heading"><span className="rp-trade-icon"><Box size={22} aria-hidden="true" /></span>
        <div><span className="rp-trade-label">OPPORTUNITY {String(rank).padStart(2, '0')}</span><h3 id={`${id}-name`}>{row.commodity}</h3></div>
      </div>
      <div className="rp-trade-profit"><span className="rp-trade-label">PROFIT PER LOAD</span><strong title={credits(row.profitPerLoad)}>{compactCredits(row.profitPerLoad)}</strong>
        <small>{Number.isFinite(row.affordableCargoPerTrip) ? `With your ${formatNumber(row.affordableCargoPerTrip)} t load` : 'Cargo or budget unknown'}</small></div>
      <div className="rp-trade-total"><span className="rp-trade-label">IF ALL STOCK SELLS</span><strong title={credits(row.fullStockProfit)}>{compactCredits(row.fullStockProfit)}</strong>
        <small>{Number.isFinite(row.tripsNeeded) ? `${formatNumber(row.tripsNeeded)} loads at this capacity` : 'Set ship & budget for load count'}</small></div>
    </div>

    <div className="rp-trade-route">
      <Endpoint station={row.seller} side="seller" price={row.buyPrice} onOpenExternal={onOpenExternal} />
      <div className="rp-trade-leg"><ArrowRight size={19} aria-hidden="true" /><strong>{routeDistanceLabel(row.seller.systemName, row.buyer.systemName, row.sellerToBuyerLy)}</strong><small>{local ? 'Supercruise required' : 'Between systems'}</small></div>
      <Endpoint station={row.buyer} side="buyer" price={row.sellPrice} onOpenExternal={onOpenExternal} />
    </div>

    <div className="rp-trade-facts">
      <span className="rp-trade-position"><MapPin size={14} aria-hidden="true" /><span><b>{routeDistanceLabel(currentSystem, row.seller.systemName, row.playerToSellerLy, { player: true })}</b> to seller</span></span>
      <span><b>{formatNumber(row.stock)} t</b> available</span>
      <span><b>{credits(row.marginPerTonne)}</b> profit / t</span>
      <span><b>{credits(row.costPerLoad)}</b> to buy one load</span>
    </div>

    {(accessWarnings.length > 0 || row.potentiallyCorrosive) && <div className="rp-trade-access" aria-label="Access and cargo restrictions"><ShieldAlert size={15} aria-hidden="true" />
      <div>{accessWarnings.map(warning => <span key={warning.code} className={warning.severity === 'danger' ? 'rp-trade-danger' : ''} title={warning.detail}>{warning.code === 'rackhams-carrier-access' ? 'Fleet carrier ride required to reach this system' : warning.label}</span>)}
        {row.potentiallyCorrosive && <span>Potentially corrosive cargo</span>}</div>
    </div>}

    <details className="rp-trade-details">
      <summary><span>Trade details & checks</span><span className="rp-trade-detail-hint">Demand, exact totals, source data</span><ChevronDown size={15} aria-hidden="true" /></summary>
      <div className="rp-trade-detail-content">
        <div className="rp-trade-calculations"><div><span>Exact profit / load</span><strong>{credits(row.profitPerLoad)}</strong></div><div><span>Buyer demand</span><strong>{formatNumber(row.buyerDemand)} t</strong></div><div><span>Cost of all stock</span><strong>{credits(row.fullStockCost)}</strong></div><div><span>Profit on all stock</span><strong>{credits(row.fullStockProfit)}</strong></div></div>
        <p className="rp-trade-assumption">Profit is a quote-based estimate. Moving all stock assumes unchanged prices and demand across every load. Other offers may use the same buyer demand.</p>
        <div className="rp-trade-sources"><SourceDetail station={row.seller} label="Seller source" onOpenExternal={onOpenExternal} /><SourceDetail station={row.buyer} label="Buyer source" onOpenExternal={onOpenExternal} /></div>
        <p>Light-years measure distance between systems, not travel time. Arrival distances are measured from the arrival star, not between these two markets. Carriers can move.</p>
        {accessWarnings.map(warning => <p key={warning.code} className="rp-trade-access-detail">{warning.detail}{warning.sourceUrl && <> <a href={warning.sourceUrl} target="_blank" rel="noopener noreferrer">Access guide ↗</a></>}</p>)}
        {row.flags.length > 0 && <ul className="rp-trade-flags">{row.flags.map(flag => <li key={flag}>{flag.replaceAll(':', ': ').replaceAll('-', ' ')}</li>)}</ul>}
      </div>
    </details>
  </article>;
}
