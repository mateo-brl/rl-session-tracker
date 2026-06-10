// config.js — Configuration locale de l'application (userData/config.json).
//
// Tout est local : plus de serveur, plus de token. La configuration ne
// contient que les préférences de l'utilisateur.

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  pseudo: '',            // pseudo en jeu — sert à attribuer victoire/défaite
  autoDashboard: true,   // ouvrir le dashboard quand Rocket League démarre
  dashboardFullscreen: true,
  statsApiPort: 49123,
  // MMR : la Stats API du jeu ne le diffuse pas, mais depuis la saison 22 il
  // est visible en jeu. L'utilisateur le recopie une fois par mode (base de
  // calibrage), puis l'application l'estime match après match.
  mmr: {},               // '2v2' → { base: 1234, setAt: timestamp }
  mmrCounts: true,       // les matchs sont classés par défaut (sinon casual)
  sounds: true,          // jingles victoire / défaite
  overlayEnabled: false, // mini-overlay toujours au premier plan pendant le jeu
  overlayPos: null,      // { x, y } — position mémorisée du mini-overlay
  // ── Personnalisation ──
  theme: null,           // { win, loss, bg, gold } — null = thème par défaut
  layout: null,          // disposition des widgets du dashboard — null = défaut
  overlayCfg: {          // contenu et apparence du mini-overlay
    showStreak: true,    // série / % victoires
    showLive: true,      // score du match en cours / dernier match
    scale: 1,            // 0.85 | 1 | 1.25
    opacity: 1,          // 1 | 0.85 | 0.7
  },
  anim: {                // animations du dashboard
    preset: 'broadcast', // broadcast | minimal | arcade
    endMatch: true,      // écran victoire / défaite
    goal: true,          // flash à chaque but
  },
};

const ANIM_PRESETS = ['broadcast', 'minimal', 'arcade'];

const HEX = /^#[0-9a-f]{6}$/i;

let file = null;
let config = { ...DEFAULTS };

function init(userDataDir) {
  file = path.join(userDataDir, 'config.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    config = { ...DEFAULTS, ...raw };
  } catch (e) {
    config = { ...DEFAULTS };
  }
  return config;
}

function get() {
  return config;
}

// `true` si un config.json existe déjà (sert à détecter le premier lancement).
function exists() {
  try { return fs.existsSync(file); } catch (e) { return false; }
}

function update(partial) {
  if (partial && typeof partial === 'object') {
    if (typeof partial.pseudo === 'string') {
      config.pseudo = partial.pseudo.trim().slice(0, 64);
    }
    if (typeof partial.autoDashboard === 'boolean') {
      config.autoDashboard = partial.autoDashboard;
    }
    if (typeof partial.dashboardFullscreen === 'boolean') {
      config.dashboardFullscreen = partial.dashboardFullscreen;
    }
    if (typeof partial.mmrCounts === 'boolean') {
      config.mmrCounts = partial.mmrCounts;
    }
    if (typeof partial.sounds === 'boolean') {
      config.sounds = partial.sounds;
    }
    if (typeof partial.overlayEnabled === 'boolean') {
      config.overlayEnabled = partial.overlayEnabled;
    }
    if (partial.overlayPos && Number.isFinite(partial.overlayPos.x)
        && Number.isFinite(partial.overlayPos.y)) {
      config.overlayPos = { x: Math.round(partial.overlayPos.x),
        y: Math.round(partial.overlayPos.y) };
    }
    // Thème : 4 couleurs hex validées, ou null pour revenir au défaut.
    if (partial.theme === null) config.theme = null;
    else if (partial.theme && typeof partial.theme === 'object') {
      const t = {};
      for (const k of ['win', 'loss', 'bg', 'gold']) {
        if (HEX.test(String(partial.theme[k] || ''))) t[k] = partial.theme[k].toLowerCase();
      }
      config.theme = Object.keys(t).length ? { ...(config.theme || {}), ...t } : config.theme;
    }
    // Disposition des widgets : { id: { x, y, w, h, hidden } } en % bornés.
    if (partial.layout === null) config.layout = null;
    else if (partial.layout && typeof partial.layout === 'object') {
      const out = {};
      for (const id of Object.keys(partial.layout).slice(0, 12)) {
        const w = partial.layout[id];
        if (!w || typeof w !== 'object') continue;
        const c = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v)));
        out[String(id).slice(0, 16)] = {
          x: c(w.x, 0, 95) || 0, y: c(w.y, 0, 95) || 0,
          w: c(w.w, 5, 100) || 20, h: c(w.h, 5, 100) || 20,
          hidden: !!w.hidden,
        };
      }
      config.layout = Object.keys(out).length ? out : null;
    }
    // Animations : style + interrupteurs.
    if (partial.anim && typeof partial.anim === 'object') {
      const a = config.anim = { ...DEFAULTS.anim, ...(config.anim || {}) };
      if (ANIM_PRESETS.includes(partial.anim.preset)) a.preset = partial.anim.preset;
      if (typeof partial.anim.endMatch === 'boolean') a.endMatch = partial.anim.endMatch;
      if (typeof partial.anim.goal === 'boolean') a.goal = partial.anim.goal;
    }
    // Mini-overlay : contenu, échelle, opacité.
    if (partial.overlayCfg && typeof partial.overlayCfg === 'object') {
      const o = config.overlayCfg = { ...DEFAULTS.overlayCfg, ...(config.overlayCfg || {}) };
      if (typeof partial.overlayCfg.showStreak === 'boolean') o.showStreak = partial.overlayCfg.showStreak;
      if (typeof partial.overlayCfg.showLive === 'boolean') o.showLive = partial.overlayCfg.showLive;
      const sc = Number(partial.overlayCfg.scale);
      if (sc >= 0.7 && sc <= 1.6) o.scale = sc;
      const op = Number(partial.overlayCfg.opacity);
      if (op >= 0.4 && op <= 1) o.opacity = op;
    }
    // Calibrage du MMR d'un mode : { mode: '2v2', value: 1234 | null }.
    if (partial.mmrSet && typeof partial.mmrSet.mode === 'string') {
      const mode = partial.mmrSet.mode.slice(0, 8);
      const v = Number(partial.mmrSet.value);
      if (!config.mmr || typeof config.mmr !== 'object') config.mmr = {};
      if (Number.isFinite(v) && v > 0) {
        config.mmr[mode] = { base: Math.round(v), setAt: Date.now() };
      } else {
        delete config.mmr[mode];
      }
    }
  }
  save();
  return config;
}

function save() {
  try {
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  } catch (e) { /* préférences non critiques */ }
}

module.exports = { init, get, exists, update, save };
