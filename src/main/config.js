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
  layouts: {},           // profils de disposition du dashboard : '1'|'2'|'3'
  layoutSlot: '1',       // profil actif
  sessionGoal: 50,       // objectif de MMR de la session (widget)
  lang: 'auto',          // langue de l'interface : auto | fr | en
  overlayCfg: {          // contenu et apparence du mini-overlay
    showStreak: true,    // série / % victoires
    showLive: true,      // score du match en cours / dernier match
    scale: 1,            // 0.85 | 1 | 1.25
    opacity: 1,          // 1 | 0.85 | 0.7
  },
  anim: {                // animations du dashboard
    preset: 'broadcast', // broadcast | minimal | arcade | neon | cinema
    endMatch: true,      // écran victoire / défaite
    goal: true,          // flash à chaque but
  },
  soundPreset: 'broadcast',  // style du jingle : broadcast | arcade | soft | epic
  alphaBoost: {          // son Alpha Boost (100 % externe, via la Stats API)
    enabled: false,
    volume: 0.45,        // 0 → 1
    profile: 'quality',  // quality (paliers de vitesse) | classic (statique)
  },
  discordRpc: false,     // statut Discord (Rich Presence) pendant le jeu
  obs: {                 // mode streamer : overlay local à capturer dans OBS
    enabled: false,
    port: 49350,
    // Personnalisation de l'overlay (appliquée en direct, sans recharger OBS)
    style: 'broadcast',  // broadcast (bandeau) | compact (ligne) | vertical (carte)
    scale: 1,            // 0.7 → 1.6
    bgOpacity: 0.93,     // opacité du fond du bandeau : 0.2 → 1
    showStreak: true,    // la série remplace le titre « Session » dès 2 d'affilée
    showLive: true,      // bloc score du match en cours
    showH2h: true,       // « déjà croisé » à côté du score (1v1)
    banner: true,        // bannière victoire / défaite en fin de match
    goalFlash: true,     // balayage lumineux à chaque but
  },
};

const ANIM_PRESETS = ['broadcast', 'minimal', 'arcade', 'neon', 'cinema'];
const SOUND_PRESETS = ['broadcast', 'arcade', 'soft', 'epic'];
const ALPHA_PROFILES = ['quality', 'classic'];
const OBS_STYLES = ['broadcast', 'compact', 'vertical'];

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
  // Migration : l'ancienne disposition unique devient le profil 1.
  if (config.layout && typeof config.layout === 'object') {
    if (!config.layouts || typeof config.layouts !== 'object') config.layouts = {};
    if (!config.layouts['1']) config.layouts['1'] = config.layout;
    delete config.layout;
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
    // Disposition des widgets : { id: { x, y, w, h, hidden } } en % bornés,
    // écrite dans le profil actif (1, 2 ou 3).
    if (typeof config.layouts !== 'object' || !config.layouts) config.layouts = {};
    if (['1', '2', '3'].includes(partial.layoutSlot)) {
      config.layoutSlot = partial.layoutSlot;
    }
    if (partial.layout === null) {
      config.layouts[config.layoutSlot] = null;
    } else if (partial.layout && typeof partial.layout === 'object') {
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
      if (Object.keys(out).length) config.layouts[config.layoutSlot] = out;
    }
    // Objectif de session (widget) et langue.
    const goal = Number(partial.sessionGoal);
    if (Number.isFinite(goal) && goal >= 10 && goal <= 500) {
      config.sessionGoal = Math.round(goal);
    }
    if (['auto', 'fr', 'en'].includes(partial.lang)) config.lang = partial.lang;
    // Animations : style + interrupteurs.
    if (partial.anim && typeof partial.anim === 'object') {
      const a = config.anim = { ...DEFAULTS.anim, ...(config.anim || {}) };
      if (ANIM_PRESETS.includes(partial.anim.preset)) a.preset = partial.anim.preset;
      if (typeof partial.anim.endMatch === 'boolean') a.endMatch = partial.anim.endMatch;
      if (typeof partial.anim.goal === 'boolean') a.goal = partial.anim.goal;
    }
    // Style du jingle de fin de match.
    if (SOUND_PRESETS.includes(partial.soundPreset)) {
      config.soundPreset = partial.soundPreset;
    }
    if (typeof partial.discordRpc === 'boolean') {
      config.discordRpc = partial.discordRpc;
    }
    // Mode streamer (overlay OBS) : activation, port, style et contenu.
    if (partial.obs && typeof partial.obs === 'object') {
      const o = config.obs = { ...DEFAULTS.obs, ...(config.obs || {}) };
      if (typeof partial.obs.enabled === 'boolean') o.enabled = partial.obs.enabled;
      const p = Number(partial.obs.port);
      if (Number.isInteger(p) && p >= 1024 && p <= 65535) o.port = p;
      if (OBS_STYLES.includes(partial.obs.style)) o.style = partial.obs.style;
      const sc = Number(partial.obs.scale);
      if (sc >= 0.7 && sc <= 1.6) o.scale = sc;
      const bo = Number(partial.obs.bgOpacity);
      if (bo >= 0.2 && bo <= 1) o.bgOpacity = bo;
      for (const k of ['showStreak', 'showLive', 'showH2h', 'banner', 'goalFlash']) {
        if (typeof partial.obs[k] === 'boolean') o[k] = partial.obs[k];
      }
    }
    // Son Alpha Boost : activation, volume, profil sonore.
    if (partial.alphaBoost && typeof partial.alphaBoost === 'object') {
      const ab = config.alphaBoost = { ...DEFAULTS.alphaBoost, ...(config.alphaBoost || {}) };
      if (typeof partial.alphaBoost.enabled === 'boolean') ab.enabled = partial.alphaBoost.enabled;
      const vol = Number(partial.alphaBoost.volume);
      if (Number.isFinite(vol) && vol >= 0 && vol <= 1) ab.volume = vol;
      if (ALPHA_PROFILES.includes(partial.alphaBoost.profile)) ab.profile = partial.alphaBoost.profile;
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
