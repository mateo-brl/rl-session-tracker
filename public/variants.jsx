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
