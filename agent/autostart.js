// agent/autostart.js — Démarrage automatique de l'agent avec Windows.
//
// Un .exe console ne peut pas être un VRAI service Windows (il n'implémente
// pas le protocole SCM). Mais ce qu'on veut réellement, c'est que l'agent
// démarre tout seul à l'ouverture de session — quand le jeu peut tourner.
//
// Méthode : on dépose un petit lanceur .vbs dans le dossier « Démarrage » de
// l'utilisateur. Le .vbs relance l'agent FENÊTRE CACHÉE à chaque connexion.
// Avantages : aucun droit administrateur, aucun outil tiers, retrait trivial
// (supprimer le fichier).

const fs = require('fs');
const os = require('os');
const path = require('path');

const VBS_NAME = 'RL Session Tracker.vbs';

function isWindows() {
  return process.platform === 'win32';
}

// L'agent tourne-t-il en exécutable SEA (rl-agent.exe) ou en script Node ?
function isSeaBuild() {
  try { return require('node:sea').isSea(); } catch (e) { return false; }
}

// Dossier « Démarrage » de l'utilisateur courant (ne nécessite aucun droit).
function startupDir() {
  const appData = process.env.APPDATA
    || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows',
    'Start Menu', 'Programs', 'Startup');
}

function vbsPath() {
  return path.join(startupDir(), VBS_NAME);
}

// Expression VBScript construisant la ligne de commande de relance. On utilise
// Chr(34) pour les guillemets : aucun échappement fragile, et les chemins
// Windows (qui ne peuvent pas contenir de guillemet) passent tels quels.
function launchExpr() {
  const quoted = (p) => 'Chr(34) & "' + p + '" & Chr(34)';
  if (isSeaBuild()) {
    return quoted(process.execPath);                 // rl-agent.exe
  }
  // Mode script : node.exe "<…>/agent.js"
  return quoted(process.execPath) + ' & " " & '
    + quoted(path.join(__dirname, 'agent.js'));
}

// Installe le démarrage automatique. Retourne { ok } ou { ok:false, reason }.
function install() {
  if (!isWindows()) return { ok: false, reason: 'disponible uniquement sur Windows' };
  try {
    const dir = startupDir();
    fs.mkdirSync(dir, { recursive: true });
    // Contenu volontairement 100 % ASCII : aucun risque d'encodage avec wscript.
    const vbs = [
      "' Lanceur RL Session Tracker - demarre l'agent au demarrage de Windows.",
      "' Fichier genere automatiquement ; supprime-le pour desactiver.",
      'CreateObject("WScript.Shell").Run ' + launchExpr() + ', 0, False',
      '',
    ].join('\r\n');
    fs.writeFileSync(vbsPath(), vbs);
    return { ok: true, path: vbsPath() };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// Retire le démarrage automatique.
function uninstall() {
  if (!isWindows()) return { ok: false, reason: 'disponible uniquement sur Windows' };
  try {
    if (fs.existsSync(vbsPath())) fs.unlinkSync(vbsPath());
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

function isInstalled() {
  try { return isWindows() && fs.existsSync(vbsPath()); } catch (e) { return false; }
}

module.exports = { install, uninstall, isInstalled, isWindows, vbsPath, VBS_NAME };
