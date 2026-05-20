// modules.jsx — dashboard module components for the RL tracker.
// All components read live state via useRLState(). Exposes to window.

const { useState, useEffect, useRef, useMemo, useCallback } = React;

/* ============================================================
   Hooks
============================================================ */

function useRLState() {
  const [state, setState] = useState(window.RL.state);
  useEffect(() => window.RL.subscribe(setState), []);
  return state;
}

function useLang() {
  const [lang, setLang] = useState(window.getLang ? window.getLang() : 'fr');
  useEffect(() => window.onLangChange(setLang), []);
  return lang;
}
const T = (key, vars) => window.t(key, vars);

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function useTween(target, durationMs = 700) {
  const [val, setVal] = useState(target);
  const fromRef = useRef(target);
  const startRef = useRef(performance.now());
  useEffect(() => {
    fromRef.current = val;
    startRef.current = performance.now();
    let raf;
    const tick = (t) => {
      const p = Math.min(1, (t - startRef.current) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3);
      const v = fromRef.current + (target - fromRef.current) * eased;
      setVal(v);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return val;
}

/* ============================================================
   Search Screen — entry point to enter username + platform
============================================================ */

function SearchScreen({ onFound }) {
  useLang();
  const [username, setUsername] = useState('');
  const [platform, setPlatform] = useState('epic');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const platforms = [
    { id: 'epic', label: 'EPIC' },
    { id: 'steam', label: 'STEAM' },
    { id: 'psn', label: 'PSN' },
    { id: 'xbox', label: 'XBOX' },
  ];

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!username.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await window.RL.searchPlayer(platform, username.trim());
      window.RL.startPolling();
      onFound();
    } catch (err) {
      if (err.status === 404) {
        setError(T('search.notFound'));
      } else if (err.status >= 500) {
        setError(T('search.unavailable'));
      } else if (err.name === 'TypeError') {
        setError(T('search.network'));
      } else {
        setError(T('search.error'));
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rl-search-screen">
      <div className="rl-search-brand">
        <span className="rl-brand-mark" />
        <span>{T('brand.tag')}</span>
      </div>
      <div className="rl-search-card">
        <div className="rl-search-title">{T('search.title')}</div>
        <div className="rl-search-subtitle">{T('search.subtitle')}</div>
        <form className="rl-search-form" onSubmit={handleSubmit}>
          <div className="rl-search-field">
            <label className="rl-search-label">{T('search.platform')}</label>
            <div className="rl-search-platforms">
              {platforms.map(p => (
                <button
                  key={p.id}
                  type="button"
                  className={'rl-search-plat-btn' + (platform === p.id ? ' is-on' : '')}
                  onClick={() => setPlatform(p.id)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div className="rl-search-field">
            <label className="rl-search-label">{T('search.username')}</label>
            <input
              className="rl-search-input"
              type="text"
              placeholder="nyx.04"
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoFocus
            />
          </div>
          {error && <div className="rl-search-error">{error}</div>}
          <button
            className="rl-search-submit"
            type="submit"
            disabled={loading || !username.trim()}
          >
            {loading ? T('search.searching') : T('search.go')}
          </button>
        </form>
        <div className="rl-search-hint">{T('search.hint')}</div>
        <button
          className="rl-search-submit"
          type="button"
          style={{ background: 'var(--surface-2)', color: 'var(--fg-2)', border: '1px solid var(--border-2)' }}
          onClick={() => { window.RL.bootstrapDemo(); window.RL.kickLiveLoop(); onFound(); }}
        >
          Mode Demo
        </button>
      </div>
    </div>
  );
}

/* ============================================================
   Tiny primitives
============================================================ */

function Card({ title, eyebrow, action, children, style, padding = 'reg', className = '', titleSize, dataKey }) {
  const padMap = { tight: '12px 14px', reg: '16px 18px', loose: '20px 22px' };
  return (
    <section
      className={'rl-card ' + className}
      data-module={dataKey}
      style={{ padding: padMap[padding] || padMap.reg, ...style }}
    >
      {(title || eyebrow || action) && (
        <header className="rl-card-hd">
          <div className="rl-card-hd-l">
            {eyebrow && <div className="rl-eyebrow">{eyebrow}</div>}
            {title && <div className="rl-card-title" style={titleSize ? { fontSize: titleSize } : null}>{title}</div>}
          </div>
          {action && <div className="rl-card-hd-r">{action}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

function AnimatedNumber({ value, decimals = 0, prefix = '', suffix = '', signed = false }) {
  const v = useTween(value, 600);
  const shown = v.toFixed(decimals);
  let str = shown;
  if (signed && value >= 0) str = '+' + shown;
  return <span className="rl-num">{prefix}{str}{suffix}</span>;
}

function Chip({ children, tone = 'neutral', size = 'sm' }) {
  return <span className={`rl-chip rl-chip-${tone} rl-chip-${size}`}>{children}</span>;
}

function ModeChip({ mode, size = 'sm' }) {
  const m = window.RL.MODES.find(x => x.id === mode);
  const label = m ? m.short : mode;
  return <span className={`rl-chip rl-chip-${size} rl-chip-mode-${mode}`}>{label}</span>;
}

function Sparkline({ data, width = 220, height = 56, accent = 'var(--accent)', fill = true, animate = true, lastDot = true }) {
  const pathRef = useRef(null);
  const safeData = data && data.length >= 2 ? data : null;

  useEffect(() => {
    if (!animate || !pathRef.current || !safeData) return;
    const len = pathRef.current.getTotalLength();
    pathRef.current.style.strokeDasharray = String(len);
    pathRef.current.style.strokeDashoffset = String(len);
    pathRef.current.getBoundingClientRect();
    pathRef.current.style.transition = 'stroke-dashoffset 900ms cubic-bezier(.2,.7,.3,1)';
    pathRef.current.style.strokeDashoffset = '0';
  }, [safeData ? safeData.length : 0, animate]);

  if (!safeData) {
    return (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block' }}>
        <text x={width/2} y={height/2+4} textAnchor="middle" fontSize="11" fill="var(--fg-muted)" fontFamily="var(--font-mono)">
          En attente de données...
        </text>
      </svg>
    );
  }

  const min = Math.min(...safeData);
  const max = Math.max(...safeData);
  const span = Math.max(1, max - min);
  const stepX = safeData.length > 1 ? width / (safeData.length - 1) : width;
  const points = safeData.map((v, i) => {
    const x = i * stepX;
    const y = height - ((v - min) / span) * (height - 8) - 4;
    return [x, y];
  });
  const d = points.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(' ');
  const dArea = d + ` L${width},${height} L0,${height} Z`;
  const lastX = points[points.length - 1][0];
  const lastY = points[points.length - 1][1];

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <linearGradient id={`spark-grad-${accent.replace(/[^a-z0-9]/gi,'')}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={accent} stopOpacity="0.35" />
          <stop offset="100%" stopColor={accent} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && <path d={dArea} fill={`url(#spark-grad-${accent.replace(/[^a-z0-9]/gi,'')})`} />}
      <path ref={pathRef} d={d} fill="none" stroke={accent} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      {lastDot && (
        <g>
          <circle cx={lastX} cy={lastY} r="6" fill={accent} opacity="0.18" />
          <circle cx={lastX} cy={lastY} r="3" fill={accent} />
        </g>
      )}
    </svg>
  );
}

/* ============================================================
   Status pill
============================================================ */

function StatusPill({ status, modeId }) {
  useLang();
  const tone = status === 'in-match' ? 'live' : status === 'in-lobby' ? 'lobby' : 'idle';
  const label = T('status.' + status);
  const mode = window.RL.MODES.find(m => m.id === modeId);
  return (
    <div className={`rl-status rl-status-${tone}`}>
      <span className="rl-status-dot">
        <span className="rl-status-pulse" />
      </span>
      <span className="rl-status-label">{label}</span>
      {mode && status === 'in-match' && <span className="rl-status-sep">&middot;</span>}
      {mode && status === 'in-match' && <span className="rl-status-mode">{mode.label}</span>}
    </div>
  );
}

/* ============================================================
   Player header
============================================================ */

function RankBadge({ iconUrl, mmr, size = 56 }) {
  // Use real rank icon from tracker.gg if available, else fallback to SVG
  if (iconUrl) {
    return (
      <div className="rl-rank-badge" style={{ width: size, height: size }}>
        <img src={iconUrl} alt="" width={size} height={size} style={{ display: 'block', objectFit: 'contain' }} />
      </div>
    );
  }
  const r = window.RL.rankFromMMR(mmr);
  const range = r.upper - r.lower;
  const ringPct = range > 0 ? (mmr - r.lower) / range : 0;
  return (
    <div className="rl-rank-badge" style={{ width: size, height: size }}>
      <svg viewBox="0 0 60 60" width={size} height={size}>
        <circle cx="30" cy="30" r="26" fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="3" />
        <circle cx="30" cy="30" r="26" fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round"
          strokeDasharray={`${163 * ringPct} 163`} transform="rotate(-90 30 30)"
          style={{ transition: 'stroke-dasharray 700ms ease' }} />
        <polygon points="30,12 44,21 44,39 30,48 16,39 16,21"
          fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.18)" strokeWidth="1" />
        <text x="30" y="34" textAnchor="middle" fontSize="13" fontWeight="600"
          fill="var(--fg)" fontFamily="var(--font-mono)" letterSpacing="0.04em">
          {r.name.slice(0,2).toUpperCase()}
        </text>
      </svg>
    </div>
  );
}

// Derive the next rank name from the current one
// e.g. "Diamond II" → "Diamond III", "Diamond III" → "Champion I"
function getNextRankName(currentRank) {
  if (!currentRank) return '';
  const order = ['I', 'II', 'III'];
  const tiers = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Champion', 'Grand Champion'];
  for (let t = 0; t < tiers.length; t++) {
    for (let i = 0; i < order.length; i++) {
      if (currentRank === tiers[t] + ' ' + order[i]) {
        if (i < 2) return tiers[t] + ' ' + order[i + 1];
        if (t < tiers.length - 1) return tiers[t + 1] + ' ' + order[0];
        return 'Supersonic Legend';
      }
    }
  }
  if (currentRank.includes('Grand Champion III')) return 'Supersonic Legend';
  return '';
}

function getNextRankIconUrl(currentIconUrl) {
  if (!currentIconUrl) return null;
  return currentIconUrl.replace(/s(\d+)-(\d+)\.png/, (_, season, num) => {
    return `s${season}-${parseInt(num) + 1}.png`;
  });
}

/* ============================================================
   Playlist picker — choose which playlist drives the headline MMR
============================================================ */

function PlaylistPicker() {
  useLang();
  const s = useRLState();
  if (!s || !s.playlists || s.playlists.length === 0) return null;
  // Most-played first so the dropdown order matches the auto pick.
  const sorted = s.playlists.slice().sort((a, b) => b.played - a.played);
  return (
    <select
      className="rl-playlist-picker"
      value={s.selectedId || 'auto'}
      title={T('picker.label')}
      onChange={e => window.RL.setDisplayPlaylist(e.target.value)}
    >
      <option value="auto">{T('picker.auto')}</option>
      {sorted.map(p => {
        const rk = p.isCasual ? 'Casual' : (p.rank || 'Unranked');
        return (
          <option key={p.id} value={p.id}>
            {p.label} — {rk} · {p.mmr}{p.played ? ` (${p.played})` : ''}
          </option>
        );
      })}
    </select>
  );
}

function PlayerHeader({ compact = false }) {
  useLang();
  const s = useRLState();
  if (!s) return null;

  const currentRank = s.player.rank || '';
  const divNum = s.player.divNum || 0; // 0-3 for Div I-IV
  // Progress within current rank: each rank has 4 divisions
  // divNum 0=Div I (0-25%), 1=Div II (25-50%), 2=Div III (50-75%), 3=Div IV (75-100%)
  const pct = Math.min(100, ((divNum) / 4) * 100 + 12.5);

  const nextRankName = getNextRankName(currentRank);
  const nextRankIcon = getNextRankIconUrl(s.player.rankIcon);

  return (
    <div className={'rl-player-header' + (compact ? ' is-compact' : '')}>
      <RankBadge iconUrl={s.player.rankIcon} mmr={s.player.mmr} size={compact ? 44 : 56} />
      <div className="rl-player-info">
        <div className="rl-player-tagline">
          <span className="rl-player-tag">{s.player.tag}</span>
          <span className="rl-player-platform">{s.player.platform}</span>
          <StatusPill status={s.player.status} modeId={s.player.statusModeId} />
          <PlaylistPicker />
        </div>
        <div className="rl-player-rankline">
          <span className="rl-rank-name">{currentRank}{s.player.division ? ' ' + s.player.division : ''}</span>
          <span className="rl-mmr-num"><AnimatedNumber value={s.player.mmr} /></span>
          <span className={'rl-mmr-delta ' + (s.session.mmrDelta >= 0 ? 'is-up' : 'is-down')}>
            {s.session.mmrDelta >= 0 ? '\u25b2' : '\u25bc'} <AnimatedNumber value={Math.abs(s.session.mmrDelta)} />
          </span>
        </div>
        {nextRankName ? (
          <div className="rl-rank-progress-wrap">
            <div className="rl-rank-progress-labels">
              <span className="rl-rank-progress-current">
                {s.player.rankIcon && <img src={s.player.rankIcon} alt="" className="rl-rank-progress-icon" />}
                <span>{currentRank}</span>
              </span>
              <span className="rl-rank-progress-next">
                <span>{nextRankName}</span>
                {nextRankIcon && <img src={nextRankIcon} alt="" className="rl-rank-progress-icon" onError={e => e.target.style.display='none'} />}
              </span>
            </div>
            <div className="rl-rank-progress">
              <div className="rl-rank-progress-bar" style={{ width: `${pct}%` }} />
            </div>
            <div className="rl-rank-progress-meta">
              <span className="rl-num">{s.player.mmr} MMR</span>
              <span>{s.player.division || ''}</span>
              <span>{nextRankName}</span>
            </div>
          </div>
        ) : (
          <div className="rl-rank-progress-wrap">
            <div className="rl-rank-progress">
              <div className="rl-rank-progress-bar" style={{ width: '100%', background: 'var(--win)' }} />
            </div>
            <div className="rl-rank-progress-meta">
              <span className="rl-num">{s.player.mmr} MMR</span>
              <span>{s.player.division || ''}</span>
              <span style={{color:'var(--win)'}}>Rang max</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   Session strip — timer, W/L, streak, objective
============================================================ */

function SessionTimer() {
  const s = useRLState();
  const now = useNow(1000);
  if (!s) return null;
  const elapsed = Math.floor((now - s.session.startedAt) / 1000);
  return <span className="rl-num">{window.RL.fmtDuration(elapsed)}</span>;
}

function WLBlock({ size = 'lg' }) {
  useLang();
  const s = useRLState();
  if (!s) return null;
  const total = s.session.wins + s.session.losses;
  const wr = total ? Math.round((s.session.wins / total) * 100) : 0;
  return (
    <div className={'rl-wl rl-wl-' + size}>
      <div className="rl-wl-num">
        <span className="rl-wl-w"><AnimatedNumber value={s.session.wins} /></span>
        <span className="rl-wl-sep">&ndash;</span>
        <span className="rl-wl-l"><AnimatedNumber value={s.session.losses} /></span>
      </div>
      <div className="rl-wl-meta">
        <span>{T('ribbon.wlMeta')}</span>
        <span className="rl-wl-wr">{wr}{T('ribbon.wr')}</span>
      </div>
    </div>
  );
}

function StreakBlock() {
  useLang();
  const s = useRLState();
  if (!s) return null;
  const { type, count } = s.session.streak;
  return (
    <div className={'rl-streak rl-streak-' + (type === 'W' ? 'win' : 'loss')}>
      <div className="rl-streak-num">
        <AnimatedNumber value={count} />
        <span className="rl-streak-letter">{type}</span>
      </div>
      <div className="rl-streak-bar">
        {s.matches.slice(-10).map((m, i) => (
          <span key={m.id} className={'rl-streak-pip ' + (m.result === 'W' ? 'is-w' : 'is-l')} />
        ))}
      </div>
      <div className="rl-meta">{T('ribbon.streak')}</div>
    </div>
  );
}

function MMRDeltaBlock() {
  useLang();
  const s = useRLState();
  if (!s) return null;
  const up = s.session.mmrDelta >= 0;
  return (
    <div className={'rl-mmrdelta ' + (up ? 'is-up' : 'is-down')}>
      <div className="rl-mmrdelta-num">
        <span className="rl-mmrdelta-sign">{up ? '+' : ''}</span>
        <AnimatedNumber value={s.session.mmrDelta} />
      </div>
      <div className="rl-meta">{T('ribbon.mmrSession')}</div>
    </div>
  );
}

function ObjectiveBlock() {
  useLang();
  const s = useRLState();
  if (!s) return null;
  const o = s.session.objective;
  const pct = Math.max(0, Math.min(100, (o.current / o.target) * 100));
  const done = o.current >= o.target;
  const curStr = (o.current >= 0 ? '+' : '') + o.current;
  return (
    <div className="rl-objective">
      <div className="rl-objective-line">
        <span className="rl-eyebrow">{T('ribbon.objective')}</span>
        <span className="rl-objective-val">{T('ribbon.objectiveVal', { cur: curStr, target: o.target })}</span>
      </div>
      <div className="rl-progress">
        <div className={'rl-progress-bar ' + (done ? 'is-done' : '')} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/* ============================================================
   MMR chart
============================================================ */

function MMRChart({ height = 140, defaultView = 'session' }) {
  useLang();
  const s = useRLState();
  const [view, setView] = useState(defaultView);

  const data = useMemo(() => {
    if (!s) return [0];
    if (view === 'session') {
      const start = s.player.startMMR;
      const arr = [start, ...s.matches.map(m => m.mmrAfter)];
      return arr;
    }
    return s.seasonCurve.map(p => p.mmr);
  }, [view, s ? s.matches.length : 0, s ? s.seasonCurve : null, s ? s.player.startMMR : 0]);

  if (!s) return null;

  const current = data[data.length - 1];
  const start = data[0];
  const delta = current - start;
  const up = delta >= 0;

  return (
    <Card
      dataKey="mmr"
      eyebrow={T('mmr.eyebrow')}
      title={
        <div className="rl-mmrchart-title">
          <span className="rl-mmrchart-current"><AnimatedNumber value={current} /></span>
          <span className={'rl-mmrchart-delta ' + (up ? 'is-up' : 'is-down')}>
            {up ? '+' : ''}{delta}
          </span>
        </div>
      }
      action={
        <div className="rl-seg">
          <button className={view === 'session' ? 'is-on' : ''} onClick={() => setView('session')}>{T('mmr.session')}</button>
          <button className={view === 'season' ? 'is-on' : ''} onClick={() => setView('season')}>{T('mmr.season')}</button>
        </div>
      }
    >
      <div className="rl-mmrchart-body" style={{ height }}>
        <Sparkline data={data} width={520} height={height} animate />
      </div>
    </Card>
  );
}

/* ============================================================
   Tilt meter
============================================================ */

function computeTilt(state) {
  const recent = state.matches.slice(-6);
  if (!recent.length) return 0;
  let score = 0;
  recent.forEach((m, i) => {
    const w = (i + 1) / recent.length;
    score += m.result === 'L' ? w : -w * 0.6;
  });
  if (state.session.streak.type === 'L') score += state.session.streak.count * 0.4;
  const t = Math.max(0, Math.min(1, (score + 2) / 5));
  return t;
}

function TiltMeter({ size = 'md' }) {
  useLang();
  const s = useRLState();
  const target = s ? computeTilt(s) : 0;
  const tilt = useTween(target, 800);
  if (!s) return null;
  const angle = -110 + tilt * 220;
  const tone = tilt < 0.35 ? 'chill' : tilt < 0.7 ? 'edge' : 'tilt';
  const label = T('tilt.' + tone);
  const W = size === 'lg' ? 260 : 200;
  const H = size === 'lg' ? 150 : 120;
  return (
    <Card dataKey="tilt" eyebrow={T('tilt.eyebrow')} title={label} className={'rl-tilt-card is-' + tone}>
      <div className="rl-tilt" style={{ width: W, height: H, margin: '0 auto' }}>
        <svg viewBox="0 0 200 130" width={W} height={H}>
          <defs>
            <linearGradient id="tilt-grad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%"  stopColor="var(--win)" />
              <stop offset="50%" stopColor="var(--accent)" />
              <stop offset="100%" stopColor="var(--loss)" />
            </linearGradient>
          </defs>
          <path d="M 20 110 A 80 80 0 0 1 180 110" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="10" strokeLinecap="round" />
          <path d="M 20 110 A 80 80 0 0 1 180 110" fill="none" stroke="url(#tilt-grad)" strokeWidth="10" strokeLinecap="round" opacity="0.85" />
          {[0, 0.25, 0.5, 0.75, 1].map((t, i) => {
            const a = (-110 + t * 220) * Math.PI / 180;
            const x1 = 100 + Math.sin(a) * 64;
            const y1 = 110 - Math.cos(a) * 64;
            const x2 = 100 + Math.sin(a) * 74;
            const y2 = 110 - Math.cos(a) * 74;
            return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(255,255,255,0.25)" strokeWidth="1.5" />;
          })}
          <g transform={`rotate(${angle} 100 110)`} style={{ transition: 'transform 800ms cubic-bezier(.2,.7,.3,1)' }}>
            <line x1="100" y1="110" x2="100" y2="38" stroke="var(--fg)" strokeWidth="2.5" strokeLinecap="round" />
            <circle cx="100" cy="110" r="6" fill="var(--surface)" stroke="var(--fg)" strokeWidth="2" />
          </g>
        </svg>
        <div className="rl-tilt-meta">
          <span className="rl-meta">{T('tilt.meta')}</span>
          <span className="rl-tilt-val">{Math.round(tilt * 100)}</span>
        </div>
      </div>
    </Card>
  );
}

/* ============================================================
   Match list
============================================================ */

function MatchRow({ match, dense = false }) {
  useLang();
  const win = match.result === 'W';
  const ago = Math.max(0, Math.round((Date.now() - match.endedAt) / 60000));
  return (
    <div className={'rl-match' + (win ? ' is-win' : ' is-loss') + (dense ? ' is-dense' : '')}>
      <div className="rl-match-l">
        <span className={'rl-match-result ' + (win ? 'is-win' : 'is-loss')}>{win ? 'W' : 'L'}</span>
        <ModeChip mode={match.mode} />
        <span className="rl-match-score rl-num">{match.score[0]}&ndash;{match.score[1]}</span>
      </div>
      {match.hasDetailedStats !== false ? (
        <div className="rl-match-m">
          <span title="goals">    <em>{T('matches.g')}</em> {match.goals}</span>
          <span title="saves">    <em>{T('matches.s')}</em> {match.saves}</span>
          <span title="assists">  <em>{T('matches.a')}</em> {match.assists}</span>
          <span title="shots">    <em>{T('matches.sh')}</em> {match.shots}</span>
        </div>
      ) : (
        <div className="rl-match-m">
          <ModeChip mode={match.mode} size="sm" />
        </div>
      )}
      <div className="rl-match-r">
        <span className={'rl-match-mmr ' + (win ? 'is-up' : 'is-down')}>
          {win ? '+' : ''}{match.mmrChange}
        </span>
        <span className="rl-match-ago">{ago === 0 ? 'now' : ago + 'm'}</span>
      </div>
    </div>
  );
}

function MatchList({ limit = 8, title, dense = false }) {
  useLang();
  const s = useRLState();
  if (!s) return null;
  const items = s.matches.slice(-limit).reverse();
  const finalTitle = title || T('matches.recent');
  return (
    <Card
      dataKey="matches"
      eyebrow={T('matches.eyebrow')}
      title={finalTitle}
      action={<span className="rl-meta">{T('matches.of', { shown: items.length, total: s.matches.length })}</span>}
    >
      <div className="rl-match-list">
        {items.length === 0 && <div className="rl-meta" style={{ padding: '12px 0' }}>Aucun match pour cette session</div>}
        {items.map(m => <MatchRow key={m.id} match={m} dense={dense} />)}
      </div>
    </Card>
  );
}

/* ============================================================
   Stat comparison
============================================================ */

function StatBar({ label, you, avg, max }) {
  const youPct = Math.min(100, (you / max) * 100);
  const avgPct = Math.min(100, (avg / max) * 100);
  const better = you >= avg;
  return (
    <div className="rl-statbar">
      <div className="rl-statbar-head">
        <span className="rl-statbar-label">{label}</span>
        <span className="rl-statbar-vals">
          <span className={'rl-statbar-you ' + (better ? 'is-up' : 'is-down')}>{you.toFixed(1)}</span>
          <span className="rl-statbar-avg">/ {avg.toFixed(1)} {T('stats.avg')}</span>
        </span>
      </div>
      <div className="rl-statbar-track">
        <div className="rl-statbar-fill" style={{ width: `${youPct}%` }} />
        <div className="rl-statbar-avgmark" style={{ left: `${avgPct}%` }} />
      </div>
    </div>
  );
}

function StatComparison() {
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
    <Card dataKey="stats" eyebrow={T('stats.eyebrow')} title={T('stats.title')}>
      <div className="rl-stat-bars">
        <StatBar label={T('stats.goals')}   you={you.goals}   avg={s.seasonAvg.goalsPerGame}   max={5} />
        <StatBar label={T('stats.saves')}   you={you.saves}   avg={s.seasonAvg.savesPerGame}   max={6} />
        <StatBar label={T('stats.assists')} you={you.assists} avg={s.seasonAvg.assistsPerGame} max={3} />
        <StatBar label={T('stats.shots')}   you={you.shots}   avg={s.seasonAvg.shotsPerGame}   max={7} />
      </div>
    </Card>
  );
}

/* ============================================================
   Mode breakdown
============================================================ */

function ModeBreakdown() {
  useLang();
  const s = useRLState();
  if (!s) return null;

  // Use modeStats from API if no session matches, otherwise aggregate session
  let rows;
  if (s.matches.length > 0) {
    const agg = {};
    s.matches.forEach(m => {
      if (!agg[m.mode]) agg[m.mode] = { w: 0, l: 0 };
      if (m.result === 'W') agg[m.mode].w++; else agg[m.mode].l++;
    });
    rows = Object.entries(agg)
      .map(([id, v]) => ({ id, ...v, total: v.w + v.l }))
      .sort((a, b) => b.total - a.total);
  } else {
    rows = s.modeStats.map(ms => ({
      id: ms.id,
      w: ms.wins,
      l: ms.losses,
      total: ms.played,
    })).filter(r => r.total > 0).sort((a, b) => b.total - a.total);
  }

  return (
    <Card dataKey="modes" eyebrow={T('modes.eyebrow')} title={T('modes.title')}>
      <div className="rl-modes">
        {rows.map(r => {
          const hasWL = r.w !== null && r.l !== null;
          const wpct = hasWL && r.total > 0 ? (r.w / r.total) * 100 : 0;
          const lpct = hasWL && r.total > 0 ? (r.l / r.total) * 100 : 0;
          const mode = window.RL.MODES.find(m => m.id === r.id);
          return (
            <div key={r.id} className="rl-mode-row">
              <div className="rl-mode-row-head">
                <span className="rl-mode-row-label">{mode ? mode.label : r.id}</span>
                <span className="rl-meta">
                  {hasWL ? `${r.w}W \u00b7 ${r.l}L` : `${r.total} matchs`}
                </span>
              </div>
              {hasWL ? (
                <div className="rl-mode-row-bar">
                  <span className="rl-mode-row-w" style={{ width: `${wpct}%` }} />
                  <span className="rl-mode-row-l" style={{ width: `${lpct}%` }} />
                </div>
              ) : (
                <div className="rl-mode-row-bar">
                  <span className="rl-mode-row-w" style={{ width: '100%', background: 'var(--accent)', opacity: 0.4 }} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/* ============================================================
   Opponents
============================================================ */

function OpponentsCard() {
  useLang();
  const s = useRLState();
  if (!s) return null;
  const lastTwo = s.matches.slice(-2).reverse();
  if (lastTwo.length === 0) return null;
  return (
    <Card dataKey="opponents" eyebrow={T('opps.eyebrow')} title={T('opps.title')}>
      <div className="rl-opps">
        {lastTwo.map(m => (
          <div key={m.id} className="rl-opps-group">
            <div className="rl-opps-grouphd">
              <ModeChip mode={m.mode} />
              <span className={'rl-match-result ' + (m.result === 'W' ? 'is-win' : 'is-loss')}>{m.result}</span>
              <span className="rl-match-score">{m.score[0]}&ndash;{m.score[1]}</span>
            </div>
            {m.opponents && m.opponents.length > 0 && (
              <div className="rl-opps-list">
                {m.opponents.map((o, i) => (
                  <div key={i} className="rl-opps-row">
                    <span className="rl-opps-tag">{o.tag}</span>
                    <span className="rl-opps-rank">{o.rank}</span>
                    <span className="rl-opps-mmr rl-num">{o.mmr}</span>
                    <span className="rl-opps-plat">{o.platform}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ============================================================
   Toast stack
============================================================ */

function ToastStack() {
  useLang();
  const s = useRLState();
  if (!s) return null;
  const latest = s.toasts[s.toasts.length - 1];
  const kindClass = latest ? ` has-${latest.kind}` : '';
  return (
    <div className={'rl-toasts' + kindClass}>
      {s.toasts.slice(-1).map(tt => {
        const titleLookup = { win: T('toast.victory'), loss: T('toast.defeat'), tilt: T('toast.tiltAlert') };
        const detail = tt.kind === 'tilt' ? T('toast.tiltDetail') : tt.detail;
        return (
          <div key={tt.id} className={'rl-toast rl-toast-' + tt.kind}>
            <div className="rl-toast-icon">
              {tt.kind === 'win' ? 'W' : tt.kind === 'loss' ? 'L' : '!'}
            </div>
            <div className="rl-toast-body">
              <div className="rl-toast-title">{titleLookup[tt.kind] || tt.title}</div>
              <div className="rl-toast-detail">{detail}</div>
            </div>
            {tt.mode && <ModeChip mode={tt.mode} size="md" />}
          </div>
        );
      })}
    </div>
  );
}

/* ============================================================
   Session ribbon
============================================================ */

function SessionRibbon({ layout = 'h' }) {
  useLang();
  return (
    <div className={'rl-session-ribbon is-' + layout}>
      <div className="rl-ribbon-cell">
        <div className="rl-eyebrow">{T('ribbon.sessionTime')}</div>
        <div className="rl-ribbon-val"><SessionTimer /></div>
      </div>
      <div className="rl-ribbon-cell"><WLBlock /></div>
      <div className="rl-ribbon-cell"><StreakBlock /></div>
      <div className="rl-ribbon-cell"><MMRDeltaBlock /></div>
      <div className="rl-ribbon-cell rl-ribbon-objective"><ObjectiveBlock /></div>
    </div>
  );
}

/* ============================================================
   Ticker bar
============================================================ */

function TickerBar({ items }) {
  useLang();
  const s = useRLState();
  if (!s) return null;
  const defaults = [
    { label: T('ticker.startMmr'),   val: s.player.startMMR },
    { label: T('ticker.currentMmr'), val: s.player.mmr },
    { label: T('ticker.peakSession'),val: Math.max(s.player.startMMR, ...s.matches.map(m => m.mmrAfter), s.player.mmr) },
    { label: T('ticker.peak'),       val: s.player.peakMMR },
    { label: T('ticker.winrate'),    val: Math.round(s.seasonStats.winRate * 100) + '%' },
    { label: T('ticker.played'),     val: s.seasonStats.played },
  ];
  const list = items || defaults;
  return (
    <div className="rl-ticker">
      <div className="rl-ticker-tag">
        <span className="rl-ticker-dot" />
        {T('brand.rec')}
      </div>
      <div className="rl-ticker-track">
        {list.map((it, i) => (
          <span key={i} className="rl-ticker-item">
            <span className="rl-ticker-label">{it.label}</span>
            <span className="rl-ticker-val rl-num">{it.val}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/* ============================================================
   Export to window
============================================================ */

Object.assign(window, {
  useRLState, useTween, useNow, useLang,
  Card, AnimatedNumber, Chip, ModeChip, Sparkline,
  StatusPill, RankBadge, PlayerHeader, PlaylistPicker, SearchScreen,
  SessionTimer, WLBlock, StreakBlock, MMRDeltaBlock, ObjectiveBlock, SessionRibbon,
  MMRChart, TiltMeter, MatchRow, MatchList,
  StatComparison, ModeBreakdown, OpponentsCard,
  ToastStack, TickerBar,
});
