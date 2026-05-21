// variants.jsx — app shell with A/B/C switcher + three layouts

const { useState: useStateV, useEffect: useEffectV, useRef: useRefV, useLayoutEffect: useLayoutEffectV } = React;

/* ============================================================
   AppShell — top bar with tabs, scaling stage below
============================================================ */

const VARIANTS = [
  { id: 'A', code: '01', tabKey: 'tab.A', width: 1920, height: 1080 },
  { id: 'B', code: '02', tabKey: 'tab.B', width: 600,  height: 1200 },
  { id: 'C', code: '03', tabKey: 'tab.C', width: 1920, height: 1080 },
];

function useHashState(initial) {
  const get = () => {
    const h = (window.location.hash || '').replace('#', '');
    return h || initial;
  };
  const [val, setVal] = useStateV(get);
  useEffectV(() => {
    const onHash = () => setVal(get());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const set = (v) => {
    window.location.hash = v;
    setVal(v);
  };
  return [val, set];
}

function ScalingStage({ width, height, children, padding = 24 }) {
  const wrapRef = useRefV(null);
  const [scale, setScale] = useStateV(0);
  useLayoutEffectV(() => {
    const el = wrapRef.current;
    if (!el) return;
    const compute = () => {
      const r = el.getBoundingClientRect();
      const aw = Math.max(0, r.width  - padding * 2);
      const ah = Math.max(0, r.height - padding * 2);
      const s = Math.min(aw / width, ah / height);
      setScale(s > 0 ? s : 1);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width, height, padding]);

  return (
    <div ref={wrapRef} className="rl-stage" style={{ padding }}>
      <div
        className="rl-stage-inner"
        style={{
          width, height,
          position: 'absolute',
          left: '50%', top: '50%',
          transform: `translate(-50%, -50%) scale(${scale || 0.0001})`,
          transformOrigin: 'center center',
          opacity: scale ? 1 : 0,
          transition: 'opacity 200ms ease',
          boxShadow: '0 30px 80px -20px rgba(0,0,0,0.55)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          overflow: 'hidden',
        }}
      >
        {children}
      </div>
    </div>
  );
}

function TopBar({ active, onChange, onOpenSettings }) {
  useLang();
  const s = useRLState();
  const now = useNow(1000);
  const elapsed = s ? Math.floor((now - s.session.startedAt) / 1000) : 0;
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

  const handleLogout = () => {
    window.RL.logout();
  };

  return (
    <header className="rl-topbar">
      <div className="rl-topbar-l">
        <div className="rl-brand">
          <span className="rl-brand-mark" />
          <span className="rl-brand-name">{window.t('brand.tag')}</span>
          {s && <span className="rl-brand-tag">&middot; {s.player.tag}</span>}
        </div>
        <div className="rl-rec">
          <span className="rl-rec-dot" />
          <span>{window.t('brand.rec')}</span>
          <span className="rl-rec-time">{clock}</span>
        </div>
      </div>
      <div className="rl-topbar-c">
        <div className="rl-tabs" role="tablist" aria-label="Dashboard layout">
          {VARIANTS.map(v => (
            <button
              key={v.id}
              role="tab"
              aria-selected={active === v.id}
              className={'rl-tab' + (active === v.id ? ' is-on' : '')}
              onClick={() => onChange(v.id)}
            >
              <span className="idx">{v.code}</span>
              <span>{window.t(v.tabKey)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="rl-topbar-r">
        <DataSourceBadge />
        <span>
          <span className="rl-clock-label">{window.t('brand.session')}</span>
          <span className="rl-clock">{window.RL.fmtDuration(elapsed)}</span>
        </span>
        <button className="rl-logout-btn" onClick={() => onOpenSettings && onOpenSettings()} title="Options">
          &#9881;
        </button>
        <button className="rl-logout-btn" onClick={handleLogout} title="Changer de joueur">
          &larr;
        </button>
      </div>
    </header>
  );
}

function AppShell({ onOpenSettings }) {
  const [active, setActive] = useHashState('A');
  const variant = VARIANTS.find(v => v.id === active) || VARIANTS[0];
  return (
    <div className="rl-shell">
      <TopBar active={variant.id} onChange={setActive} onOpenSettings={onOpenSettings} />
      <ScalingStage width={variant.width} height={variant.height}>
        {variant.id === 'A' && <CommandCenter />}
        {variant.id === 'B' && <Sidekick />}
        {variant.id === 'C' && <FocusVariant />}
      </ScalingStage>
    </div>
  );
}

/* ============================================================
   Variant 1 — Command Center  (1920 x 1080)
============================================================ */
function CommandCenter() {
  useLang();
  const s = useRLState();
  if (!s) return null;
  return (
    <div className="rl-app rl-app-command" data-screen-label="A &middot; Command">
      <header className="rl-app-header">
        <PlayerHeader />
        <div className="rl-app-header-right">
          <div className="rl-headertile">
            <span className="rl-eyebrow">{window.t('brand.session')}</span>
            <span className="rl-headertile-val"><SessionTimer /></span>
          </div>
          <div className="rl-headertile rl-headertile-obj">
            <ObjectiveBlock />
          </div>
        </div>
      </header>

      <SessionRibbon />

      <div className="rl-app-main">
        <div className="rl-app-col-l">
          <MMRChart height={170} />
          <MatchList limit={7} />
        </div>
        <div className="rl-app-col-r">
          <TiltMeter />
          <StatComparison />
          <ModeBreakdown />
        </div>
      </div>

      <TickerBar />
      <ToastStack />
    </div>
  );
}

/* ============================================================
   Variant 2 — Sidekick  (portrait 600 x 1200)
============================================================ */
function Sidekick() {
  useLang();
  const s = useRLState();
  if (!s) return null;
  return (
    <div className="rl-app rl-app-sidekick" data-screen-label="B &middot; Sidekick">
      <header className="rl-app-header is-stack">
        <PlayerHeader compact />
      </header>

      <div className="rl-sidekick-strip">
        <div className="rl-sidekick-strip-cell">
          <span className="rl-eyebrow">{window.t('ribbon.time')}</span>
          <span className="rl-strip-val"><SessionTimer /></span>
        </div>
        <div className="rl-sidekick-strip-cell"><WLBlock size="md" /></div>
        <div className="rl-sidekick-strip-cell"><StreakBlock /></div>
      </div>

      <div className="rl-sidekick-objwrap">
        <Card padding="tight"><ObjectiveBlock /></Card>
      </div>

      <MMRChart height={120} />
      <TiltMeter size="md" />
      <MatchList limit={5} dense />
      <StatComparison />
      <ModeBreakdown />

      <TickerBar />
      <ToastStack />
    </div>
  );
}

/* ============================================================
   Variant 3 — Focus  (1920 x 1080)
============================================================ */
function FocusVariant() {
  useLang();
  const s = useRLState();
  if (!s) return null;
  const up = s.session.mmrDelta >= 0;
  const r = window.RL.rankFromMMR(s.player.mmr);
  const unitLines = window.t('focus.unit').split('\\n');
  return (
    <div className="rl-app rl-app-focus" data-screen-label="C &middot; Focus">
      <div className="rl-focus-hero">
        <div className="rl-focus-hero-top">
          <div className="rl-focus-tagline">
            <RankBadge iconUrl={s.player.rankIcon} mmr={s.player.mmr} size={56} />
            <div>
              <div className="rl-focus-tag">{s.player.tag}</div>
              <div className="rl-focus-rank">
                {s.player.rank || r.name}
                <span className="rl-focus-mmr"> &middot; <AnimatedNumber value={s.player.mmr} /> MMR</span>
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
            <span className="rl-eyebrow">{window.t('brand.live')}</span>
            <StatusPill status={s.player.status} modeId={s.player.statusModeId} />
            <PlaylistPicker />
          </div>
        </div>

        <div className={'rl-focus-bignum ' + (up ? 'is-up' : 'is-down')}>
          <span className="rl-focus-bignum-sign">{up ? '+' : '\u2212'}</span>
          <span className="rl-focus-bignum-val">
            <AnimatedNumber value={Math.abs(s.session.mmrDelta)} />
          </span>
          <span className="rl-focus-bignum-unit">
            {unitLines.map((line, i) => <React.Fragment key={i}>{line}{i < unitLines.length - 1 && <br/>}</React.Fragment>)}
          </span>
        </div>

        <div className="rl-focus-wlbar">
          <div className="rl-focus-wlbig">
            <span className="rl-focus-w"><AnimatedNumber value={s.session.wins} /></span>
            <span className="rl-focus-sep">&ndash;</span>
            <span className="rl-focus-l"><AnimatedNumber value={s.session.losses} /></span>
          </div>
          <div className="rl-focus-streak">
            <span className={'rl-focus-streak-letter is-' + (s.session.streak.type === 'W' ? 'win' : 'loss')}>
              {s.session.streak.type}{s.session.streak.count}
            </span>
            <div className="rl-streak-bar">
              {s.matches.slice(-10).map((m) => (
                <span key={m.id} className={'rl-streak-pip ' + (m.result === 'W' ? 'is-w' : 'is-l')} />
              ))}
            </div>
          </div>
        </div>

        <div className="rl-focus-spark">
          <Sparkline
            data={[s.player.startMMR, ...s.matches.map(m => m.mmrAfter)]}
            width={840}
            height={130}
            animate
          />
          <div className="rl-focus-spark-meta">
            <span><span className="rl-eyebrow">{window.t('focus.start')}</span>{s.player.startMMR}</span>
            <span><span className="rl-eyebrow">{window.t('focus.time')}</span><SessionTimer /></span>
            <span><span className="rl-eyebrow">{window.t('focus.peak')}</span>{s.player.peakMMR}</span>
          </div>
        </div>
      </div>

      <div className="rl-focus-side">
        <TiltMeter size="md" />
        <Card eyebrow={window.t('stats.eyebrow')} title={window.t('stats.short')} padding="tight">
          <StatComparisonInline />
        </Card>
        <MatchList limit={5} title={window.t('matches.short')} dense />
      </div>

      <ToastStack />
    </div>
  );
}

function StatComparisonInline() {
  useLang();
  const s = useRLState();
  if (!s) return null;
  const n = Math.max(1, s.matches.length);
  const you = {
    goals:   s.matches.reduce((a,m) => a + m.goals,   0) / n,
    saves:   s.matches.reduce((a,m) => a + m.saves,   0) / n,
    assists: s.matches.reduce((a,m) => a + m.assists, 0) / n,
    shots:   s.matches.reduce((a,m) => a + m.shots,   0) / n,
  };
  return (
    <div className="rl-stat-bars">
      <StatBarLite label={window.t('stats.goals')}   you={you.goals}   avg={s.seasonAvg.goalsPerGame}   max={5} />
      <StatBarLite label={window.t('stats.saves')}   you={you.saves}   avg={s.seasonAvg.savesPerGame}   max={6} />
      <StatBarLite label={window.t('stats.assists')} you={you.assists} avg={s.seasonAvg.assistsPerGame} max={3} />
      <StatBarLite label={window.t('stats.shots')}   you={you.shots}   avg={s.seasonAvg.shotsPerGame}   max={7} />
    </div>
  );
}

function StatBarLite({ label, you, avg, max }) {
  const youPct = Math.min(100, (you / max) * 100);
  const avgPct = Math.min(100, (avg / max) * 100);
  const better = you >= avg;
  return (
    <div className="rl-statbar is-lite">
      <div className="rl-statbar-head">
        <span className="rl-statbar-label">{label}</span>
        <span className="rl-statbar-vals">
          <span className={'rl-statbar-you ' + (better ? 'is-up' : 'is-down')}>{you.toFixed(1)}</span>
          <span className="rl-statbar-avg">/ {avg.toFixed(1)}</span>
        </span>
      </div>
      <div className="rl-statbar-track">
        <div className="rl-statbar-fill" style={{ width: `${youPct}%` }} />
        <div className="rl-statbar-avgmark" style={{ left: `${avgPct}%` }} />
      </div>
    </div>
  );
}

Object.assign(window, { AppShell, CommandCenter, Sidekick, FocusVariant });

/* ============================================================
   App bootstrap — point d'entrée du dashboard
   (anciennement le <script type="text/babel"> inline d'index.html ;
    déplacé ici pour permettre une CSP stricte sans <script> inline)
============================================================ */

const TWEAK_DEFAULTS = {
  "accent": "#00e5ff",
  "dark": true,
  "density": "spacious",
  "font": "Inter",
  "lang": "fr",
  "showMMR": true,
  "showMatches": true,
  "showTilt": true,
  "showStats": true,
  "showModes": true,
  "showOpponents": true,
  "rightOrder": "tilt-stats-modes-opps",
  "liveDemo": false
};

const ACCENT_OPTIONS = [
  { hex: '#00e5ff', ink: '#04181e' },
  { hex: '#b6ec3d', ink: '#0e1f02' },
  { hex: '#ff3d71', ink: '#280611' },
  { hex: '#f59e0b', ink: '#2a1800' },
  { hex: '#8b5cf6', ink: '#150626' },
];

const FONT_OPTIONS = ['Geist', 'Inter', 'IBM Plex Sans', 'JetBrains Mono'];

const RIGHT_ORDERS = [
  'tilt-stats-modes-opps',
  'stats-tilt-opps-modes',
  'modes-opps-tilt-stats',
];

function inkFor(hex) {
  const o = ACCENT_OPTIONS.find(a => a.hex.toLowerCase() === hex.toLowerCase());
  return o ? o.ink : '#04181e';
}

function applyTweaks(t) {
  const r = document.documentElement;
  r.style.setProperty('--accent', t.accent);
  r.style.setProperty('--accent-ink', inkFor(t.accent));
  r.setAttribute('data-theme', t.dark ? 'dark' : 'light');
  r.setAttribute('data-density', t.density);

  const fontMap = {
    'Geist': "'Geist', system-ui, sans-serif",
    'Inter': "'Inter', system-ui, sans-serif",
    'IBM Plex Sans': "'IBM Plex Sans', system-ui, sans-serif",
    'JetBrains Mono': "'JetBrains Mono', ui-monospace, monospace",
  };
  r.style.setProperty('--font-sans', fontMap[t.font] || fontMap.Inter);

  document.body.classList.toggle('rl-hide-mmr',       !t.showMMR);
  document.body.classList.toggle('rl-hide-matches',   !t.showMatches);
  document.body.classList.toggle('rl-hide-tilt',      !t.showTilt);
  document.body.classList.toggle('rl-hide-stats',     !t.showStats);
  document.body.classList.toggle('rl-hide-modes',     !t.showModes);
  document.body.classList.toggle('rl-hide-opponents', !t.showOpponents);

  const parts = t.rightOrder.split('-');
  parts.forEach((key, i) => {
    const cssVar = key === 'opps' ? '--ord-opponents' : '--ord-' + key;
    r.style.setProperty(cssVar, String(i + 1));
  });
}

function SettingsPanel({ open, onClose, t, setTweak }) {
  if (!open) return null;
  return (
    <div style={{
      position:'fixed', right:16, bottom:16, zIndex:2147483646, width:290,
      maxHeight:'calc(100vh - 32px)', display:'flex', flexDirection:'column',
      background:'rgba(15,18,22,0.92)', color:'var(--fg)',
      backdropFilter:'blur(24px) saturate(160%)',
      border:'1px solid var(--border-2)', borderRadius:10,
      boxShadow:'0 12px 40px rgba(0,0,0,.5)',
      font:'12px/1.4 var(--font-sans)', overflow:'hidden'
    }}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'12px 16px',borderBottom:'1px solid var(--border)'}}>
        <b style={{fontSize:13,letterSpacing:'0.04em',textTransform:'uppercase',fontFamily:'var(--font-mono)'}}>Options</b>
        <button onClick={onClose} style={{background:'none',border:0,color:'var(--fg-muted)',cursor:'pointer',fontSize:16}}>&times;</button>
      </div>
      <div style={{padding:'12px 16px',display:'flex',flexDirection:'column',gap:12,overflowY:'auto',scrollbarWidth:'thin'}}>
        <SettingsSection label="Theme" />
        <SettingsRow label="Langue">
          <SettingsSeg value={t.lang} options={['fr','en']} onChange={v => setTweak('lang', v)} />
        </SettingsRow>
        <SettingsRow label="Accent">
          <div style={{display:'flex',gap:6}}>
            {ACCENT_OPTIONS.map(o => (
              <button key={o.hex} onClick={() => setTweak('accent', o.hex)} style={{
                width:28,height:28,borderRadius:4,border: t.accent === o.hex ? '2px solid var(--fg)' : '1px solid var(--border)',
                background:o.hex,cursor:'pointer',padding:0
              }} />
            ))}
          </div>
        </SettingsRow>
        <SettingsRow label="Mode sombre">
          <SettingsToggle value={t.dark} onChange={v => setTweak('dark', v)} />
        </SettingsRow>
        <SettingsRow label="Densité">
          <SettingsSeg value={t.density} options={['compact','regular','spacious']} onChange={v => setTweak('density', v)} />
        </SettingsRow>
        <SettingsRow label="Police">
          <select value={t.font} onChange={e => setTweak('font', e.target.value)} style={{
            background:'var(--bg-2)',color:'var(--fg)',border:'1px solid var(--border)',borderRadius:4,
            padding:'4px 8px',font:'12px var(--font-mono)',cursor:'pointer'
          }}>
            {FONT_OPTIONS.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
        </SettingsRow>

        <SettingsSection label="Modules" />
        <SettingsRow label="Graph MMR"><SettingsToggle value={t.showMMR} onChange={v => setTweak('showMMR', v)} /></SettingsRow>
        <SettingsRow label="Historique"><SettingsToggle value={t.showMatches} onChange={v => setTweak('showMatches', v)} /></SettingsRow>
        <SettingsRow label="Tiltomètre"><SettingsToggle value={t.showTilt} onChange={v => setTweak('showTilt', v)} /></SettingsRow>
        <SettingsRow label="Stats"><SettingsToggle value={t.showStats} onChange={v => setTweak('showStats', v)} /></SettingsRow>
        <SettingsRow label="Modes"><SettingsToggle value={t.showModes} onChange={v => setTweak('showModes', v)} /></SettingsRow>
      </div>
    </div>
  );
}

function SettingsSection({ label }) {
  return <div style={{fontSize:10,fontWeight:600,letterSpacing:'0.08em',textTransform:'uppercase',color:'var(--fg-faint)',paddingTop:8}}>{label}</div>;
}

function SettingsRow({ label, children }) {
  return (
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12}}>
      <span style={{color:'var(--fg-2)',fontSize:12,fontWeight:500}}>{label}</span>
      {children}
    </div>
  );
}

function SettingsToggle({ value, onChange }) {
  return (
    <button onClick={() => onChange(!value)} style={{
      width:36,height:20,borderRadius:10,border:0,padding:0,cursor:'pointer',
      background: value ? 'var(--accent)' : 'var(--surface-2)',
      position:'relative',transition:'background 0.15s'
    }}>
      <span style={{
        position:'absolute',top:2,left: value ? 18 : 2,
        width:16,height:16,borderRadius:8,background:'#fff',
        transition:'left 0.15s',boxShadow:'0 1px 3px rgba(0,0,0,0.3)'
      }} />
    </button>
  );
}

function SettingsSeg({ value, options, onChange }) {
  return (
    <div style={{display:'flex',background:'var(--bg-2)',borderRadius:4,padding:2,border:'1px solid var(--border)'}}>
      {options.map(o => (
        <button key={o} onClick={() => onChange(o)} style={{
          flex:1,border:0,borderRadius:3,padding:'5px 8px',cursor:'pointer',
          font:'500 10px var(--font-mono)',letterSpacing:'0.1em',textTransform:'uppercase',
          background: value === o ? 'var(--surface-2)' : 'transparent',
          color: value === o ? 'var(--fg)' : 'var(--fg-muted)',
        }}>{o}</button>
      ))}
    </div>
  );
}

// Bannière de match en direct — alimentée par la Stats API native du jeu.
// Visible uniquement quand un match est réellement en cours (score live).
function LiveMatchBanner() {
  const s = useRLState();
  const live = s && s.live;
  if (!live || !live.active) return null;
  const score = live.score || [0, 0];
  const ts = live.timeSeconds;
  const clock = (typeof ts === 'number')
    ? Math.floor(ts / 60) + ':' + String(Math.floor(ts % 60)).padStart(2, '0')
    : null;
  return (
    <div style={{
      position:'fixed', top:14, left:'50%', transform:'translateX(-50%)',
      zIndex:2147483645, display:'flex', alignItems:'center', gap:12,
      padding:'7px 16px', borderRadius:999, whiteSpace:'nowrap',
      background:'rgba(15,18,22,0.94)', backdropFilter:'blur(20px) saturate(160%)',
      border:'1px solid var(--border-2)', boxShadow:'0 8px 30px rgba(0,0,0,.45)',
      font:'600 13px var(--font-mono, monospace)', color:'var(--fg)',
    }}>
      <span style={{
        width:7, height:7, borderRadius:4, background:'#ff3d71',
        boxShadow:'0 0 8px #ff3d71',
        animation:'rl-live-pulse 1.4s ease-in-out infinite',
      }} />
      <span style={{fontSize:9, letterSpacing:'0.16em', color:'var(--fg-faint)'}}>LIVE</span>
      <span style={{color:'#4ea3ff', fontSize:16}}>{score[0]}</span>
      <span style={{color:'var(--fg-faint)'}}>&ndash;</span>
      <span style={{color:'#ff8c42', fontSize:16}}>{score[1]}</span>
      <span style={{color:'var(--fg-muted)'}}>{live.isOT ? 'PROL.' : (clock || '—')}</span>
      {live.mode && (
        <span style={{
          fontSize:9, letterSpacing:'0.12em', color:'var(--fg-faint)',
          borderLeft:'1px solid var(--border)', paddingLeft:10,
        }}>{String(live.mode).toUpperCase()}</span>
      )}
    </div>
  );
}

// Route déduite de l'URL : / = accueil, /u/:id = dashboard d'un joueur.
function getRoute() {
  const m = location.pathname.match(/^\/u\/([^/]+)\/?$/);
  return m ? { mode: 'dashboard', id: decodeURIComponent(m[1]) } : { mode: 'home' };
}

// Message plein écran centré (chargement / erreur).
function CenterMsg({ title, detail }) {
  return (
    <div style={{
      position:'fixed', inset:0, display:'flex', flexDirection:'column',
      alignItems:'center', justifyContent:'center', gap:8, textAlign:'center',
      background:'var(--bg)', color:'var(--fg)', padding:24,
      fontFamily:'var(--font-sans)',
    }}>
      <div style={{fontSize:18, fontWeight:600}}>{title}</div>
      {detail && <div style={{fontSize:13, color:'var(--fg-muted)'}}>{detail}</div>}
    </div>
  );
}

// Page d'accueil publique — liste des joueurs et leur statut live.
function HostedHome() {
  const [players, setPlayers] = React.useState(null);
  React.useEffect(() => {
    let alive = true;
    const tick = () => fetch('/api/players')
      .then(r => r.json())
      .then(d => { if (alive) setPlayers(d.players || []); })
      .catch(() => { if (alive) setPlayers([]); });
    tick();
    const iv = setInterval(tick, 10000);
    return () => { alive = false; clearInterval(iv); };
  }, []);
  return (
    <div style={{
      position:'fixed', inset:0, overflowY:'auto',
      background:'var(--bg)', color:'var(--fg)',
      fontFamily:'var(--font-sans)', padding:'48px 20px',
    }}>
      <div style={{maxWidth:560, margin:'0 auto'}}>
        <div style={{
          fontFamily:'var(--font-mono)', fontSize:11, letterSpacing:'0.22em',
          textTransform:'uppercase', color:'var(--accent)', marginBottom:6,
        }}>Rocket League</div>
        <h1 style={{fontSize:28, fontWeight:700, margin:'0 0 24px'}}>Session Tracker</h1>
        {players === null && <div style={{color:'var(--fg-muted)'}}>Chargement…</div>}
        {players && players.length === 0 &&
          <div style={{color:'var(--fg-muted)'}}>Aucun joueur configuré.</div>}
        {players && players.map(p => {
          const online = p.live && p.live.connected;
          const inMatch = online && p.live.match && p.live.match.active;
          return (
            <a key={p.id} href={'/u/' + encodeURIComponent(p.id)} style={{
              display:'flex', alignItems:'center', justifyContent:'space-between',
              padding:'14px 18px', marginBottom:10, borderRadius:10,
              background:'var(--surface-2, rgba(255,255,255,0.04))',
              border:'1px solid var(--border)', textDecoration:'none',
              color:'var(--fg)',
            }}>
              <span style={{display:'flex', flexDirection:'column'}}>
                <span style={{fontWeight:600, fontSize:15}}>{p.name}</span>
                <span style={{
                  fontSize:11, color:'var(--fg-faint)', fontFamily:'var(--font-mono)',
                }}>{String(p.platform || '').toUpperCase()}</span>
              </span>
              <span style={{
                display:'flex', alignItems:'center', gap:7, fontSize:10,
                letterSpacing:'0.12em', fontFamily:'var(--font-mono)',
                color: online ? 'var(--accent)' : 'var(--fg-faint)',
              }}>
                <span style={{
                  width:7, height:7, borderRadius:4,
                  background: online ? (inMatch ? '#ff3d71' : 'var(--accent)') : 'var(--fg-faint)',
                  boxShadow: online ? '0 0 8px currentColor' : 'none',
                }} />
                {inMatch ? 'EN MATCH' : online ? 'EN LIGNE' : 'HORS LIGNE'}
              </span>
            </a>
          );
        })}
      </div>
    </div>
  );
}

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [loadError, setLoadError] = React.useState(null);
  const rlState = useRLState();
  const route = getRoute();

  React.useEffect(() => { applyTweaks(t); }, [t]);
  React.useEffect(() => { window.setLang(t.lang); }, [t.lang]);

  // Chargement du joueur hébergé. La route est dérivée de location.pathname,
  // qui ne change pas sans rechargement complet de la page : route.id est donc
  // stable pour toute la vie du composant. On déclenche le chargement une
  // seule fois, et on liste route.id en dépendance pour rester correct si la
  // route venait à devenir dynamique.
  React.useEffect(() => {
    if (route.mode !== 'dashboard') return;
    window.RL.loadHostedPlayer(route.id)
      .catch(e => setLoadError(e && e.message ? e.message : 'Joueur introuvable'));
  }, [route.mode, route.id]);

  if (route.mode === 'home') return <HostedHome />;
  if (loadError) return <CenterMsg title="Joueur introuvable" detail={loadError} />;
  if (!rlState) return <CenterMsg title="Chargement…" detail={route.id} />;

  return (
    <React.Fragment>
      <AppShell onOpenSettings={() => setSettingsOpen(s => !s)} />
      <LiveMatchBanner />
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} t={t} setTweak={setTweak} />
    </React.Fragment>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
