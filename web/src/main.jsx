import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowDown, ArrowRight, ArrowUpRight, Check, CheckCheck, CheckCircle2, ChevronDown, Circle, Clock3, Compass, Crosshair, Download, ExternalLink, Fuel, Info, Layers3, LoaderCircle, MapPin, Navigation, Orbit, Play, Radio, RefreshCw, Save, Settings2, ShieldCheck, Square, Sun, Terminal, TriangleAlert, Waypoints, X, Zap } from 'lucide-react';
import './styles.css';
import MarketPanel from '../../features/markets/ui/MarketPanel.jsx';

async function getMarketToken() {
  const response = await fetch('/api/session', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('RoutePilot oturumu okunamadı.');
  const session = await response.json();
  if (typeof session.token !== 'string' || !session.token) throw new Error('Oturum anahtarı eksik.');
  return session.token;
}

const number = (n, digits = 0) => Number.isFinite(n) ? n.toLocaleString('tr-TR', { maximumFractionDigits: digits }) : '—';
const phases = [
  { id: 'align', name: 'Hizalanma', icon: Crosshair, description: 'Sonraki sistem pusulada bulunur; gemi hedefe hizalanır.' },
  { id: 'jump', name: 'Atlama', icon: Zap, description: 'FSD hazırlanır. Yeni sisteme giriş oyun günlüğünden doğrulanır.' },
  { id: 'refuel', name: 'Yakıt', icon: Fuel, description: 'Uygun yıldızda yakıt toplanır. Depo doluluğu takip edilir.' },
  { id: 'clearance', name: 'Yıldız kontrolü', icon: Sun, description: 'Varış yıldızı seçilir; yıldızın geminin arkasında olduğu doğrulanır.' },
  { id: 'depart', name: 'Ayrılma', icon: Navigation, description: 'Gemi yıldızdan uzaklaşır ve sonraki atlamaya hazırlanır.' },
];
const phaseTitles = { idle: 'Yolculuğa hazır olduğunda', align: 'Sonraki sisteme hizalanıyor', jump: 'Yıldızlararası atlama', refuel: 'Yakıt toplanıyor', clearance: 'Yıldızın konumu doğrulanıyor', depart: 'Yıldızdan uzaklaşılıyor', complete: 'Hedef sisteme ulaşıldı', paused: 'Uçuş durduruldu', error: 'Devam etmek için işlem gerekiyor' };
const statusLabels = { offline: 'Beklemede', loading: 'Motor hazırlanıyor', ready: 'Hazır', running: 'Rota takip ediliyor', stopped: 'Durduruldu', completed: 'Tamamlandı', error: 'Kontrol gerekli' };

function usePilot() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const token = useRef(null);
  const mounted = useRef(true);
  const commandBusy = useRef(null);
  useEffect(() => {
    mounted.current = true;
    let timer, stopped = false, controller;
    const poll = async () => {
      controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch('/api/state', { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('Yerel sunucuya ulaşılamadı.');
        const body = await response.json();
        if (!body.engine || !body.controls) throw new Error('Uygulama durumu okunamadı.');
        if (!stopped) { setData(body); setError(null); }
      } catch { if (!stopped) setError('Bağlantı kesildi. Gösterilen bilgiler son alınan durumdur.'); }
      finally { clearTimeout(timeout); if (!stopped) timer = setTimeout(poll, 1000); }
    };
    poll();
    return () => { stopped = true; mounted.current = false; clearTimeout(timer); controller?.abort(); };
  }, []);
  const command = async action => {
    if (commandBusy.current && action !== 'stop') return null;
    commandBusy.current = action; setBusy(action);
    try {
      if (!token.current) {
        const r = await fetch('/api/session', { cache: 'no-store' });
        if (!r.ok) throw new Error('Oturum açılamadı. Sayfayı yenileyin.');
        token.current = (await r.json()).token;
      }
      const response = await fetch('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-RoutePilot-Token': token.current }, body: JSON.stringify({ action }) });
      const body = await response.json();
      if (!response.ok || !body.ok) {
        if (response.status === 403) token.current = null;
        throw new Error(body.message || 'İşlem tamamlanamadı.');
      }
      return { ok: true, message: body.message || 'İşlem tamamlandı.' };
    } catch (e) { return { ok: false, message: e.message || 'Sunucuya ulaşılamadı.' }; }
    finally { if (commandBusy.current === action) { commandBusy.current = null; if (mounted.current) setBusy(null); } }
  };
  return { data, error, busy, command };
}

function App() {
  const { data, error, busy, command } = usePilot();
  const [tab, setTab] = useState('route');
  useEffect(() => { window.scrollTo({ top: 0, left: 0 }); }, [tab]);
  const [filter, setFilter] = useState('all');
  const [details, setDetails] = useState(false);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const [help, setHelp] = useState(false);
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  const engine = data?.engine || { status: 'offline', phase: 'idle', message: 'Oyun verileri okunuyor…' };
  const telemetry = data?.telemetry || {};
  const route = data?.route || {};
  const activity = data?.activity || [];
  const controls = data?.controls || {};
  const checks = data?.checks || [];
  const journalConnected = checks.some(c => c.id === 'journal' && c.ok);
  const loading = engine.status === 'loading' || busy === 'start';
  const running = engine.status === 'running';
  const currentPhase = phases.findIndex(p => p.id === engine.phase);
  const finished = engine.status === 'completed' || (route.total > 0 && route.remaining === 0);
  const progress = route.total > 0 && Number.isFinite(route.completed) ? Math.max(0, Math.min(100, route.completed / route.total * 100)) : 0;
  const fuelPercent = Number.isFinite(telemetry.fuel) && telemetry.fuelCapacity > 0 ? Math.max(0, Math.min(100, telemetry.fuel / telemetry.fuelCapacity * 100)) : null;
  const ship = telemetry.ship ? telemetry.ship.replace(/\b\w/g, s => s.toUpperCase()).replaceAll('_', ' ') : 'Gemi bilgisi bekleniyor';
  const flightStatus = telemetry.landed ? 'Yüzeyde' : telemetry.docked ? 'İstasyonda' : telemetry.supercruise ? 'Supercruise' : telemetry.inMainShip ? 'Normal uzay' : 'Gemi dışında';
  const events = filter === 'important' ? activity.filter(e => e.level !== 'info') : activity;
  const doCommand = async action => {
    const result = await command(action);
    if (result) { setToast(result); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(null), result.ok ? 5500 : 10000); }
  };
  const downloadLog = () => {
    const text = activity.map(e => `${e.time || ''}\t${e.level || 'info'}\t${e.title || ''}\t${e.detail || ''}`).join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = `routepilot-${new Date().toISOString().slice(0, 10)}.txt`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#" onClick={e => { e.preventDefault(); setTab('route'); }} aria-label="RoutePilot ana ekran"><span className="brand-mark"><Navigation size={21} strokeWidth={2.4} /></span><span>Route<span className="brand-light">Pilot</span></span></a>
      <div className="product-tag">ELITE DANGEROUS / COMPANION</div>
      <div className="sidebar-section">KONTROL MERKEZİ</div>
      <nav aria-label="Ana gezinme">
        <button aria-label="Rota takibi" title="Rota takibi" className={tab === 'route' ? 'nav-item selected' : 'nav-item'} onClick={() => setTab('route')}><Waypoints size={19} /><span>Rota takibi</span><span className="nav-indicator" /></button>
        <button aria-label="Ticaret tarayıcısı" title="Ticaret tarayıcısı" className={tab === 'markets' ? 'nav-item selected' : 'nav-item'} onClick={() => setTab('markets')}><Layers3 size={19} /><span>Ticaret tarayıcısı</span></button>
        <button aria-label="İşlem geçmişi" title="İşlem geçmişi" className={tab === 'activity' ? 'nav-item selected' : 'nav-item'} onClick={() => setTab('activity')}><Terminal size={18} /><span>İşlem geçmişi</span>{activity.length > 0 && <span className="count-badge">{activity.length}</span>}</button>
        <button aria-label="Uçuş tercihleri" title="Uçuş tercihleri" className={tab === 'settings' ? 'nav-item selected' : 'nav-item'} onClick={() => setTab('settings')}><Settings2 size={18} /><span>Uçuş tercihleri</span></button>
      </nav>
      <div className="sidebar-bottom">
        <div className="focus-note"><div className="note-icon"><Radio size={17} /></div><strong>{tab === 'markets' ? 'Piyasalar arka planda yenilenir' : 'Uçuşta Elite ön planda kalmalı'}</strong><p>{tab === 'markets' ? 'Tarayıcı oyun tuşlarını kullanmaz. Mesafeler günlüğündeki konumdan hesaplanır.' : 'Başlattığında oyun öne gelir. Başka pencereye geçmek uçuşu durdurur.'}</p></div>
        <button className="help-link" onClick={() => setHelp(true)}><Info size={16} /> Nasıl kullanılır? <ArrowUpRight size={15} /></button>
        <div className="sidebar-footer"><span className="small-mark">R/P</span><span>YEREL UYGULAMA</span><span>v{data?.app?.version || '0.1.0'}</span></div>
      </div>
    </aside>

    <div className="workspace">
      <header className="topbar"><div className="breadcrumb"><Compass size={16} /><span>Uçuş paneli</span><span className="slash">/</span><strong>{tab === 'markets' ? 'Ticaret tarayıcısı' : tab === 'route' ? 'Rota takibi' : tab === 'activity' ? 'İşlem geçmişi' : 'Uçuş tercihleri'}</strong></div><div className="connection"><span className={`status-dot ${error ? 'bad' : journalConnected ? 'good' : ''}`} />{error ? 'Bağlantı kesildi' : journalConnected ? 'Oyun günlüğü bağlı' : data ? 'Oyun bekleniyor' : 'Bağlanıyor'}<span className="local-pill">LOCAL</span></div></header>
      <main>
        {error && <div className="connection-alert" role="alert"><TriangleAlert size={18} /><span>{error} Yeni uçuş başlatılamaz.</span></div>}
        {tab !== 'markets' && <div className="page-heading"><div><div className="eyebrow">{tab === 'route' ? 'BİR SONRAKİ YILDIZA' : tab === 'activity' ? 'HER ADIM GÖRÜNÜR' : 'SADECE GEREKENLER'}</div><h1>{tab === 'route' ? 'Rotanı seç. Gerisini takip et.' : tab === 'activity' ? 'Uçuşun işlem geçmişi' : 'Uçuş tercihleri'}</h1><p>{tab === 'route' ? 'Planladığın rota, geminin durumu ve sıradaki adım. Tek bir yerde.' : tab === 'activity' ? 'Ne yapıldı, neden beklendi, nerede duruldu — gerçek motor ve oyun kayıtları.' : 'Bu sürüm, sistemler arası planlı rota takibine odaklanır.'}</p></div><div className={`mode-pill ${running ? 'live' : ''}`}><span className="status-dot" />{statusLabels[engine.status] || engine.status}</div></div>}

        {tab === 'route' && <>
          <div className="hero-grid">
            <section className={`route-card panel ${running ? 'is-running' : ''}`}>
              <div className="card-heading"><span className="section-label"><Waypoints size={16} /> PLANLANAN ROTA</span><span className="subtle-badge">{route.available ? 'GALAKSİ HARİTASI' : finished ? 'VARIŞ YAPILDI' : 'ROTA BEKLENİYOR'}</span></div>
              <div className="route-endpoints">
                <div className="endpoint current"><span className="endpoint-dot" /><div><span className="field-label">BULUNDUĞUN SİSTEM</span><h2 title={telemetry.system || ''}>{telemetry.system || 'Oyun günlüğü bekleniyor'}</h2></div></div>
                <div className="route-line"><span /><ArrowDown size={15} /><span /></div>
                <div className="endpoint destination"><span className="endpoint-icon"><Crosshair size={19} /></span><div><span className="field-label">{finished ? 'ULAŞILAN HEDEF' : 'SON HEDEF'}</span><h2 title={route.destination || ''}>{route.destination || 'Galaksi haritasından bir rota çiz'}</h2></div></div>
              </div>
              <div className="route-metrics"><div><span className="big-number">{number(route.total === null ? null : route.remaining)}</span><span className="metric-caption">atlama kaldı</span></div><div className="metric-divider" /><div><span className="distance-number">{number(route.distanceRemaining, 1)}<small> ly</small></span><span className="metric-caption">kalan mesafe</span></div><div className="route-progress-label">{finished ? <><CheckCheck size={21} /><span>Rotanın sonundasın</span></> : <><Orbit size={21} /><span>{Number.isFinite(route.total) && route.total > 0 ? `${number(route.completed)} / ${number(route.total)} tamamlandı` : 'Rota oyundan okunur'}</span></>}</div></div>
              <div className="progress-track" role="progressbar" aria-label="Rota ilerlemesi" aria-valuenow={Math.round(progress)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${progress}%` }} /></div>
              <div className="next-system"><span>SONRAKİ SİSTEM</span><strong>{route.nextSystem || (finished ? 'Bu rota tamamlandı' : 'Henüz seçilmedi')}</strong><ArrowRight size={17} /></div>
            </section>

            <section className="pilot-card panel">
              <div className="card-heading"><span className="section-label"><Navigation size={16} /> UÇUŞ KONTROLÜ</span><span className="tiny-label">ROTA MODU</span></div>
              <div className={`pilot-symbol ${running || loading ? 'animated' : ''}`}><div className="orbit-ring" /><Navigation size={37} strokeWidth={1.2} /></div>
              <h2>{loading ? 'Uçuş motoru hazırlanıyor' : finished && !running ? 'Bir sonraki yolculuğa hazır' : phaseTitles[engine.phase] || 'Yolculuğa hazır olduğunda'}</h2>
              <p className="pilot-message" aria-live="polite">{loading ? 'Görüntü tanıma ve kayıtlı gemi ayarları yükleniyor. Hazır olunca oyun öne gelecek.' : (running || ['error', 'stopped'].includes(engine.status)) ? engine.message || phases[currentPhase]?.description : controls.startReason || engine.message || 'Rotayı çiz, kokpite dön ve yolculuğu başlat.'}</p>
              <button className="primary-button" disabled={!controls.canStart || !!error || !!busy || loading || running} onClick={() => doCommand('start')}>{loading ? <LoaderCircle size={19} className="spin" /> : <Play size={18} fill="currentColor" />}{loading ? 'Hazırlanıyor…' : engine.status === 'stopped' ? 'Rotayı yeniden başlat' : 'Rotayı başlat'}<span>↗</span></button>
              <button className="stop-button" disabled={!controls.canStop && !loading && !running} onClick={() => doCommand('stop')}><Square size={13} fill="currentColor" />{loading ? 'Başlatmayı iptal et' : 'Durdur'}<kbd>Ctrl Alt End</kbd></button>
              <div className="save-hint"><ShieldCheck size={14} />Varışta durur <span>·</span> Atlama sınırı yok</div>
            </section>
          </div>

          <div className="telemetry-strip panel"><div className="ship-stat"><span className="stat-icon"><Navigation size={21} /></span><div><span className="field-label">GEMİ</span><strong>{ship}</strong></div></div><div><span className="field-label">UÇUŞ DURUMU</span><strong><span className="mini-dot" />{data ? flightStatus : '—'}</strong></div><div className="fuel-stat"><span className="field-label">YAKIT DEPOSU</span><strong>{number(telemetry.fuel, 1)} <small>/ {number(telemetry.fuelCapacity)} t</small><Fuel size={15} /></strong><div className="fuel-track"><span style={{ width: `${fuelPercent ?? 0}%` }} /></div></div><div><span className="field-label">GÖVDE</span><strong>{number(telemetry.hull)}<small> %</small><ShieldCheck size={16} className="muted-icon" /></strong></div></div>

          <section className="phase-panel panel"><div className="card-heading"><span className="section-label"><Layers3 size={16} /> HER ATLAMADA</span><span className="tiny-label">{running ? 'CANLI İŞLEM' : 'UÇUŞ DÖNGÜSÜ'}</span></div><div className="phase-track">{phases.map((p, i) => <div key={p.id} className={`phase ${running && i === currentPhase ? 'active' : ''}`}><div className="phase-top"><span className="phase-icon"><p.icon size={20} strokeWidth={1.6} /></span>{i < phases.length - 1 && <span className="phase-connector" />}</div><strong>{p.name}</strong><p>{p.description}</p>{running && i === currentPhase && <span className="current-tag"><span className="status-dot" /> Şu anda</span>}</div>)}</div></section>

          <div className="bottom-grid"><section className="activity-panel panel"><div className="card-heading"><span className="section-label"><Terminal size={16} /> SON İŞLEMLER</span><button className="text-button" onClick={() => setTab('activity')}>Tümünü gör <ArrowUpRight size={14} /></button></div><EventList events={activity.slice(0, 5)} compact /></section><section className="checks-panel panel"><div className="card-heading"><span className="section-label"><CheckCircle2 size={16} /> BAŞLATMA KONTROLLERİ</span><span className="tiny-label">{checks.filter(c => c.ok).length}/{checks.length}</span></div><div className="checks-list">{checks.length ? checks.map(c => <div className={`check-row ${c.ok ? 'passed' : ''}`} key={c.id}>{c.ok ? <CheckCircle2 size={17} /> : <Circle size={17} />}<div><strong>{c.label}</strong>{!c.ok && <p>{c.detail}</p>}</div></div>) : <div className="empty-copy">Oyun durumu okununca kontroller burada görünecek.</div>}</div></section></div>
        </>}

        {tab === 'markets' && <MarketPanel baseUrl="/api/markets" getToken={getMarketToken} />}
        {tab === 'activity' && <section className="panel full-history"><div className="card-heading"><div className="filter-buttons"><button className={filter === 'all' ? 'selected' : ''} onClick={() => setFilter('all')}>Tüm işlemler <span>{activity.length}</span></button><button className={filter === 'important' ? 'selected' : ''} onClick={() => setFilter('important')}>Önemli olaylar</button></div><div className="history-actions"><button className={`text-button ${details ? 'on' : ''}`} onClick={() => setDetails(!details)}><Terminal size={15} />{details ? 'Ayrıntıyı gizle' : 'Teknik ayrıntı'}</button><button className="secondary-button small" onClick={downloadLog} disabled={!activity.length}><Download size={15} /> Dışa aktar</button></div></div><EventList events={[...events]} details={details} /></section>}

        {tab === 'settings' && <div className="settings-layout"><section className="panel settings-panel"><div className="card-heading"><span className="section-label"><Settings2 size={16} /> ROTA DAVRANIŞI</span></div><SettingRow icon={Waypoints} title="Atlama sınırı" text="Planladığın rotayı son sisteme kadar takip eder." value="Sınırsız" /><SettingRow icon={MapPin} title="Hedef sisteme varış" text="Rota bitince durur. İstasyon yaklaşması veya iniş başlatmaz." value="Dur" /><SettingRow icon={Save} title="Öğrenilen gemi ayarları" text="Uçuş sonunda otomatik kaydedilir; uygulamayı kapattığında korunur." value="Otomatik kayıt" /><SettingRow icon={Radio} title="Pencere odağı" text="Elite ön planda olmalı. Odak kaybolursa durur; kendiliğinden devam etmez." value="Ön plan" /><div className="settings-actions"><p>Mevcut ayarları ayrıca diske kaydedebilirsin.</p><button className="secondary-button" disabled={!engine.connected || running || loading || !!busy || !!error} onClick={() => doCommand('save')}><Save size={16} />Şimdi kaydet</button></div></section><section className="panel scope-card"><span className="note-icon"><Compass size={22} /></span><h2>Tek iş. Açık bir akış.</h2><p>Rota takibi uçuşu yönetir. Ticaret tarayıcısı, güncel piyasa raporlarından fırsatları ayrıca listeler.</p><p>Yüzeye iniş, istasyon yanaşması ve arka planda uçuş bu sürüme dahil değildir.</p><button className="text-button" onClick={() => setHelp(true)}>Başlangıç rehberi <ArrowRight size={16} /></button></section></div>}

        <footer className="page-footer"><span><span className={`status-dot ${error ? 'bad' : journalConnected ? 'good' : ''}`} />{error ? 'Son alınan oyun verileri gösteriliyor' : 'Yerel oyun günlüğü · Hesap bağlantısı gerekmez'}</span><span>Uçuş verileri bu bilgisayarda kalır.</span></footer>
      </main>
    </div>
    {toast && <div className={`toast ${toast.ok ? 'success' : 'error'}`} role={toast.ok ? 'status' : 'alert'}>{toast.ok ? <CheckCircle2 size={19} /> : <TriangleAlert size={19} />}<span>{toast.message}</span><button aria-label="Bildirimi kapat" onClick={() => setToast(null)}><X size={16} /></button></div>}
    {help && <HelpDialog close={() => setHelp(false)} />}
  </div>;
}

function EventList({ events, compact = false, details = false }) {
  if (!events.length) return <div className="empty-history"><Terminal size={26} strokeWidth={1.2} /><div><strong>Henüz bir işlem yok</strong><p>Rota başladığında her aşama ve durma nedeni burada görünecek.</p></div></div>;
  return <ol className={`event-list ${compact ? 'compact' : ''}`}>{events.map((event, i) => {
    const Icon = event.level === 'error' || event.level === 'warning' ? TriangleAlert : event.level === 'success' ? Check : Circle;
    const date = event.time ? new Date(event.time) : null;
    const time = date && !Number.isNaN(date.getTime()) ? date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
    return <li key={event.id || `${event.time}-${i}`} className={`event ${event.level || 'info'}`}><time>{time}</time><span className="event-icon"><Icon size={13} /></span><div><strong>{event.title}</strong>{event.detail && <p className={details ? 'technical' : ''}>{event.detail}</p>}</div></li>;
  })}</ol>;
}

function SettingRow({ icon: Icon, title, text, value }) { return <div className="setting-row"><Icon size={20} /><div><strong>{title}</strong><p>{text}</p></div><span className="setting-value">{value}</span></div>; }

function HelpDialog({ close }) {
  const ref = useRef(null);
  useEffect(() => { const dialog = ref.current; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog ref={ref} className="help-dialog" onCancel={e => { e.preventDefault(); close(); }} onClick={e => { if (e.target === e.currentTarget) close(); }}><div className="dialog-inner"><button className="dialog-close" onClick={close} aria-label="Rehberi kapat"><X size={19} /></button><div className="eyebrow">İLK YOLCULUK</div><h2>Rotayı çiz, uçuşu başlat.</h2><ol><li><span>01</span><div><strong>Elite'i aç ve rotanı çiz</strong><p>Galaksi Haritası'nda hedef sisteme bir rota planla. AsterEDAP kontrol profili seçili olmalı.</p></div></li><li><span>02</span><div><strong>Kokpite ve supercruise'a dön</strong><p>Yıldızdan uzaklaş, gazı sıfırla ve ana gemide supercruise durumunda ol. Panelleri kapat.</p></div></li><li><span>03</span><div><strong>Rotayı başlat</strong><p>Oyun otomatik öne gelir. Uçuş boyunca Elite'i ön planda bırak. İlk başlangıçta motorun yüklenmesi biraz sürebilir.</p></div></li><li><span>04</span><div><strong>Gerektiğinde durdur</strong><p>Durdur düğmesini veya Ctrl+Alt+End kısayolunu kullan. Odak kaybında oyun gazı sıfırlanamayabilir; Elite'te X sıfır gazdır.</p></div></li></ol><button className="primary-button" onClick={close}>Anladım <Check size={18} /></button></div></dialog>;
}

createRoot(document.getElementById('root')).render(<App />);
