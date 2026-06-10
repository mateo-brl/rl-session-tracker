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
  mmrCounts: true,       // false si l'utilisateur joue surtout en casual
};

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
