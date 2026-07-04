// agent/enable-statsapi.js — Active la Stats API de Rocket League depuis l'agent.
//
// Au premier lancement, l'agent active lui-même la Stats API : l'utilisateur
// n'a plus rien à exécuter (fini le enable-statsapi.bat manuel).
//
// ARCHITECTURE (et leçon apprise sur un PC Steam) : la détection des
// installations se fait ICI, dans le processus de l'application — donc dans
// la session du VRAI utilisateur. Le script PowerShell élevé reçoit la liste
// toute prête. Pourquoi : quand UAC élève vers un AUTRE compte (utilisateur
// non-administrateur), le HKCU du script élevé est la ruche de l'admin, où
// la clé Steam n'existe pas — Rocket League dans D:\SteamLibrary devenait
// introuvable et l'ini n'était jamais écrit.
//
// Le script élevé écrit son résultat (chemins configurés, ou NONE) dans un
// fichier que l'application relit : on peut enfin dire à l'utilisateur si
// l'activation a réellement réussi.
//
// Hors Windows : opération sans objet (la Stats API n'existe que sur PC).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// ───────── Détection des installations (session utilisateur) ─────────

function regQuery(key, value) {
  try {
    const out = spawnSync('reg', ['query', key, '/v', value],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    const m = /REG_SZ\s+(.+)/.exec(out.stdout || '');
    return m ? m[1].trim() : null;
  } catch (e) { return null; }
}

// Extrait les chemins de bibliothèques d'un libraryfolders.vdf de Steam.
function parseLibraryFolders(text) {
  const out = [];
  for (const m of String(text).matchAll(/"path"\s+"([^"]+)"/g)) {
    out.push(m[1].replace(/\\\\/g, '\\'));
  }
  return out;
}

// Un vrai dossier d'installation de Rocket League ?
function isRLInstall(p) {
  try {
    return fs.existsSync(path.join(p, 'Binaries', 'Win64', 'RocketLeague.exe'))
      && fs.existsSync(path.join(p, 'TAGame', 'Config'));
  } catch (e) { return false; }
}

function detectInstalls() {
  const found = [];
  const add = (p) => {
    if (p && typeof p === 'string' && !found.includes(p)) found.push(p);
  };

  // Epic Games : manifestes du launcher (ProgramData, lisible sans élévation).
  try {
    const dir = path.join(process.env.ProgramData || 'C:\\ProgramData',
      'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.item')) continue;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (/rocket league/i.test(m.DisplayName || '') && m.InstallLocation) {
          add(m.InstallLocation);
        }
      } catch (e) { /* manifeste illisible : suivant */ }
    }
  } catch (e) { /* pas d'Epic */ }

  // Steam : registre + TOUTES les bibliothèques (y compris autres disques).
  if (process.platform === 'win32') {
    const sp = regQuery('HKCU\\Software\\Valve\\Steam', 'SteamPath');
    if (sp) {
      const libs = [sp];
      try {
        libs.push(...parseLibraryFolders(
          fs.readFileSync(path.join(sp, 'steamapps', 'libraryfolders.vdf'), 'utf8')));
      } catch (e) { /* vdf absent : bibliothèque principale seulement */ }
      for (const l of libs) add(path.join(l, 'steamapps', 'common', 'rocketleague'));
    }
  }

  // Chemins par défaut, au cas où.
  add('C:\\Program Files\\Epic Games\\rocketleague');
  add('C:\\Program Files (x86)\\Steam\\steamapps\\common\\rocketleague');

  return found.filter(isRLInstall);
}

// ───────── Vérification silencieuse (sans élévation) ─────────
// Une « Vérification de l'intégrité des fichiers » Steam, une grosse mise à
// jour du jeu ou une réparation Epic RÉINITIALISENT DefaultStatsAPI.ini : la
// Stats API se coupe sans que l'utilisateur ait touché à rien, et le tracker
// meurt en silence. Lire l'ini ne demande aucun droit admin : on peut donc
// détecter la panne à chaque lancement et ne réactiver (élévation UAC) que
// quand c'est réellement nécessaire.

// L'ini d'une installation est-il configuré pour nous ?
function iniConfigured(install, port) {
  try {
    const txt = fs.readFileSync(
      path.join(install, 'TAGame', 'Config', 'DefaultStatsAPI.ini'), 'utf8');
    if (!/\[TAGame\.MatchStatsExporter_TA\]/i.test(txt)) return false;
    const p = /^\s*Port\s*=\s*(\d+)/im.exec(txt);
    const r = /^\s*PacketSendRate\s*=\s*(\d+)/im.exec(txt);
    return !!(p && Number(p[1]) === port && r && Number(r[1]) > 0);
  } catch (e) { return false; }   // absent ou illisible : à refaire
}

// Retourne { installs, broken } — broken : installations détectées dont
// l'ini n'active pas (ou plus) la Stats API sur le port attendu.
function checkStatsApi(port) {
  if (process.platform !== 'win32') return { installs: [], broken: [] };
  const installs = detectInstalls();
  const want = Number(port) || 49123;
  return { installs, broken: installs.filter((p) => !iniConfigured(p, want)) };
}

// ───────── Script PowerShell élevé ─────────
// Reçoit la liste des installations (__INSTALLS__) et le fichier de résultat
// (__RESULT__). Garde une re-détection Epic + chemins par défaut en filet de
// sécurité, mais PLUS de lecture du registre Steam sous élévation.
const PS_LINES = [
  "$ErrorActionPreference='SilentlyContinue'",
  '$Port=49123',
  // 120 paquets/s : nécessaire pour la réactivité du son Alpha Boost (le
  // tracker, lui, se contenterait de 10).
  '$Rate=120',
  "$Result='__RESULT__'",
  // ── Élévation automatique : sans droits admin, on se relance élevé et on
  // ATTEND la fin (le résultat est écrit par l'instance élevée). ──
  '$pr=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())',
  'if(-not $pr.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)){',
  "  try{ Start-Process powershell -Verb RunAs -Wait -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',('\"'+$PSCommandPath+'\"')) }catch{}",
  '  exit',
  '}',
  // ── Validation d'un vrai dossier d'installation Rocket League. ──
  'function Test-RL($p){',
  '  if([string]::IsNullOrWhiteSpace($p)){return $null}',
  '  try{$c=[System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $p -ErrorAction Stop).Path)}catch{return $null}',
  "  if(-not(Test-Path -LiteralPath (Join-Path $c 'Binaries\\Win64\\RocketLeague.exe') -PathType Leaf)){return $null}",
  "  if(-not(Test-Path -LiteralPath (Join-Path $c 'TAGame\\Config') -PathType Container)){return $null}",
  '  return $c',
  '}',
  // ── Installations détectées par l'application (session utilisateur). ──
  '$found=@(__INSTALLS__)',
  // ── Filet de sécurité : Epic (ProgramData, indépendant du compte). ──
  "$em=Join-Path $env:ProgramData 'Epic\\EpicGamesLauncher\\Data\\Manifests'",
  'if(Test-Path $em){',
  '  Get-ChildItem $em -Filter *.item -ErrorAction SilentlyContinue|ForEach-Object{',
  '    try{$m=Get-Content $_.FullName -Raw|ConvertFrom-Json',
  "      if($m.DisplayName -like '*Rocket League*' -and $m.InstallLocation){$found+=$m.InstallLocation}}catch{}",
  '  }',
  '}',
  "$found+='C:\\Program Files\\Epic Games\\rocketleague'",
  "$found+='C:\\Program Files (x86)\\Steam\\steamapps\\common\\rocketleague'",
  // ── Écriture du .ini dans chaque installation valide trouvée. ──
  '$ini="[TAGame.MatchStatsExporter_TA]`r`nPort=$Port`r`nPacketSendRate=$Rate`r`n"',
  '$ok=@()',
  'foreach($p in ($found|Select-Object -Unique)){',
  '  $c=Test-RL $p',
  '  if($c){',
  "    $ip=Join-Path $c 'TAGame\\Config\\DefaultStatsAPI.ini'",
  '    try{',
  "      if(Test-Path $ip){Copy-Item $ip ($ip+'.bak') -Force -ErrorAction SilentlyContinue}",
  '      Set-Content -Path $ip -Value $ini -Encoding ASCII -Force',
  '      $ok+=$c',
  '    }catch{}',
  '  }',
  '}',
  // UTF8 (pas ASCII) : un chemin accentué (« D:\Jeux vidéo\… ») doit survivre
  // au fichier de résultat. Node retire le BOM à la lecture.
  "if($ok.Count -gt 0){Set-Content -Path $Result -Value ($ok -join \"`r`n\") -Encoding UTF8 -Force}",
  "else{Set-Content -Path $Result -Value 'NONE' -Encoding UTF8 -Force}",
];

// Échappe un chemin pour une chaîne PowerShell entre apostrophes.
function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

// Lance une commande et résout dès qu'elle se termine (ou expire).
function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => { if (!done) { done = true; resolve(result); } };
    try {
      const cp = spawn(cmd, args, { windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(() => finish({ ok: false, reason: 'délai dépassé' }), timeoutMs);
      cp.on('error', (e) => { clearTimeout(timer); finish({ ok: false, reason: e.message }); });
      cp.on('exit', () => { clearTimeout(timer); finish({ ok: true }); });
    } catch (e) {
      finish({ ok: false, reason: e.message });
    }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Active la Stats API. Retourne { ok, installs, configured, reason? } :
//  • installs   — installations détectées côté application ;
//  • configured — celles où le script élevé a réellement écrit l'ini.
async function enableStatsApi() {
  if (process.platform !== 'win32') {
    return { skipped: true, reason: 'Stats API disponible uniquement sur Windows' };
  }
  const installs = detectInstalls();
  const stamp = process.pid + '-' + Date.now();
  const resultFile = path.join(os.tmpdir(), 'rl-statsapi-result-' + stamp + '.txt');
  let tmpFile;
  try {
    tmpFile = path.join(os.tmpdir(), 'rl-statsapi-' + stamp + '.ps1');
    const script = PS_LINES.join('\r\n')
      .replace('__RESULT__', resultFile.replace(/'/g, "''"))
      .replace('__INSTALLS__', installs.map(psQuote).join(','));
    // BOM UTF-8 OBLIGATOIRE : Windows PowerShell 5.1 (celui de Windows 10)
    // lit un .ps1 sans BOM en ANSI. Le script contient des chemins qui
    // peuvent être accentués — dont $Result dans %TEMP%, qui inclut le nom
    // d'utilisateur (« C:\Users\Mathéo\… ») : sans BOM, le chemin est
    // corrompu, le résultat n'est jamais écrit et l'activation échoue en
    // silence chez les utilisateurs au nom accentué (fréquent en français).
    fs.writeFileSync(tmpFile, '\uFEFF' + script + '\r\n');
  } catch (e) {
    return { ok: false, installs, configured: null,
      reason: 'écriture du script impossible : ' + e.message };
  }

  const r = await run('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpFile], 180000);

  // Résultat écrit par l'instance élevée (petite marge pour le flush).
  let raw = null;
  for (let i = 0; i < 10 && raw === null; i++) {
    try { raw = fs.readFileSync(resultFile, 'utf8'); } catch (e) { await sleep(300); }
  }
  try { fs.unlinkSync(resultFile); } catch (e) {}
  try { fs.unlinkSync(tmpFile); } catch (e) {}

  if (raw === null) {
    return { ok: false, installs, configured: null,
      reason: r.ok ? 'aucun résultat — fenêtre admin refusée ?' : r.reason };
  }
  const lines = raw.replace(/^\uFEFF/, '').trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length || lines[0] === 'NONE') {
    return { ok: false, installs, configured: [],
      reason: 'aucune installation Rocket League valide trouvée' };
  }
  return { ok: true, installs, configured: lines };
}

module.exports = { enableStatsApi, checkStatsApi, iniConfigured, detectInstalls,
  parseLibraryFolders, isRLInstall };
