// media.js — Ce qui joue sur la machine, et de quoi le piloter.
//
// POURQUOI PAS L'API SPOTIFY. Elle exigeait de créer une application chez
// Spotify, de coller un identifiant client, de s'autoriser en OAuth, et le
// contrôle réclamait un compte Premium — pour ne piloter que Spotify. Windows
// expose déjà tout ça : les « System Media Transport Controls » (SMTC), la
// même chose que la tuile média du volume. Ça couvre Spotify, YouTube dans un
// navigateur, VLC, Deezer, n'importe quel lecteur qui s'y déclare — sans clé,
// sans compte, sans réseau.
//
// COMMENT. Un unique PowerShell tourne en tâche de fond :
//   • il interroge SMTC et écrit une ligne JSON à chaque changement ;
//   • il lit ses commandes sur son entrée standard (next, prev, playpause,
//     volup, voldown, mute).
// Un seul processus, pas un lancement de PowerShell toutes les trois secondes.
//
// Le pilotage passe par la session SMTC elle-même (TrySkipNext…) et, pour le
// volume, par les touches multimédia du clavier (keybd_event) : c'est ce que
// fait Windows quand on appuie sur les touches d'un clavier de bureau.
//
// Hors Windows, le module reste inerte : aucun processus lancé, état nul.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Le script est écrit sur disque puis lancé avec -File : passer 80 lignes de
// PowerShell en -Command est un cauchemar d'échappement.
// BOM UTF-8 obligatoire, sinon PowerShell 5.1 lit les accents en latin-1.
const BOM = '﻿';

const PS = `$ErrorActionPreference = 'Stop'
# PowerShell 5.1 ecrit dans la page de codes de la console : sans cette ligne,
# « Impossible de trouver le type » arrive en octets isoles cote Node, et le
# seul message de diagnostic qu'on possede devient illisible. Meme raison que
# dans enable-statsapi.js.
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime

# Touches multimedia : c'est ce que Windows declenche depuis un clavier de
# bureau. Le volume n'existe pas dans SMTC, il passe forcement par la.
Add-Type -Namespace RLST -Name Keys -MemberDefinition @'
[DllImport("user32.dll")]
public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);
'@
function Send-Key([byte]$k) {
  [RLST.Keys]::keybd_event($k, 0, 0, [System.UIntPtr]::Zero)
  [RLST.Keys]::keybd_event($k, 0, 2, [System.UIntPtr]::Zero)
}

# Les API WinRT sont asynchrones : ce passe-plat attend le resultat.
trap { [Console]::Error.WriteLine($_.Exception.Message); continue }
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $type) {
  $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  # Lire .Result sur une tache qui n'a pas fini BLOQUE : le delai d'attente ne
  # servait a rien, et un lecteur suspendu figeait la boucle pour toujours.
  if (-not $t.Wait(4000)) { return $null }
  $t.Result
}

# La syntaxe du littéral de type WinRT n'accepte aucun espace autour du « = ».
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null
$mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
if ($null -eq $mgrType) { [Console]::Error.WriteLine('type SMTC introuvable'); Write-Output '{"err":"type"}'; exit 1 }
try {
  $mgr = Await ($mgrType::RequestAsync()) ($mgrType)
} catch {
  [Console]::Error.WriteLine('RequestAsync: ' + $_.Exception.Message)
}
if ($null -eq $mgr) { Write-Output '{"err":"smtc"}'; exit 1 }
Write-Output '{"ready":true}'

$propType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$last = ''

function Get-Now {
  $s = $mgr.GetCurrentSession()
  if ($null -eq $s) { return $null }
  $p = Await ($s.TryGetMediaPropertiesAsync()) ($propType)
  if ($null -eq $p) { return $null }
  $i = $s.GetPlaybackInfo()
  $t = $s.GetTimelineProperties()
  [pscustomobject]@{
    title    = [string]$p.Title
    artist   = [string]$p.Artist
    album    = [string]$p.AlbumTitle
    app      = [string]$s.SourceAppUserModelId
    playing  = ($i.PlaybackStatus -eq 'Playing')
    posMs    = [int]($t.Position.TotalMilliseconds)
    lenMs    = [int]($t.EndTime.TotalMilliseconds)
    at       = [int64]((Get-Date).ToUniversalTime() - (Get-Date '1970-01-01')).TotalMilliseconds
  }
}

# Les commandes arrivent sur l'entree standard, une par ligne. La fin de ce
# flux ne doit PAS arreter le script : lance a la main dans une console, il
# n'y a personne pour taper, et il s'arretait aussitot apres la premiere
# ligne. On cesse simplement d'ecouter les commandes.
$reader = [System.IO.StreamReader]::new([System.Console]::OpenStandardInput())
$stdin = $reader.ReadLineAsync()

while ($true) {
  if ($stdin.IsCompleted) {
    $cmd = $stdin.Result
    # Flux fermé : l'application a quitté. C'est la SEULE façon dont ce script
    # se termine — sans elle, un PowerShell invisible survivait à chaque
    # fermeture et s'accumulait jusqu'au redemarrage de la machine.
    if ($null -eq $cmd) { break }
    $s = $mgr.GetCurrentSession()
    switch ($cmd.Trim()) {
      'next'      { if ($s) { $null = $s.TrySkipNextAsync() } }
      'prev'      { if ($s) { $null = $s.TrySkipPreviousAsync() } }
      'playpause' { if ($s) { $null = $s.TryTogglePlayPauseAsync() } }
      'volup'     { Send-Key 175 }
      'voldown'   { Send-Key 174 }
      'mute'      { Send-Key 173 }
    }
    $stdin = $reader.ReadLineAsync()
    Start-Sleep -Milliseconds 120
  }
  $n = $null
  try { $n = Get-Now } catch { [Console]::Error.WriteLine('lecture: ' + $_.Exception.Message) }
  $json = if ($null -eq $n) { '{"none":true}' } else { $n | ConvertTo-Json -Compress }
  # On n'ecrit que ce qui change : la position bouge sans arret, donc elle est
  # comparee arrondie a la seconde.
  $key = if ($null -eq $n) { 'none' } else { $n.title + '|' + $n.playing + '|' + [int]($n.posMs / 1000) }
  if ($key -ne $last) { $last = $key; Write-Output $json }
  Start-Sleep -Milliseconds 900
}
`;

class MediaControl {
  constructor(userDataDir, opts) {
    const o = opts || {};
    this.dir = userDataDir || '.';
    this.log = o.log || (() => {});
    this.onUpdate = o.onUpdate || (() => {});
    this.platform = o.platform || process.platform;
    this.spawn = o.spawn || spawn;
    this.proc = null;
    this.now = null;
    this.error = null;
    this.available = this.platform === 'win32';
    this._buf = '';
    this._stderr = '';
    this._restarts = 0;
    this._stopping = false;       // arrêt demandé : aucune relance ne doit suivre
    this._retry = null;           // minuterie de relance, pour pouvoir l'annuler
    this._startedAt = 0;
    this._lastLog = '';
  }

  // Toute mutation d'état passe par ici. Sans ce point unique, une erreur
  // posée dans un coin (échec de lancement, arrêt) ne parvenait jamais à
  // l'interface, qui continuait d'afficher l'état précédent.
  _publish() {
    this.onUpdate(this.status());
  }

  status() {
    return { available: this.available, running: !!this.proc, error: this.error, now: this.now };
  }

  scriptPath() { return path.join(this.dir, 'media-control.ps1'); }

  start() {
    if (!this.available || this.proc || this._stopping) return;
    // Restes de la vie précédente : une ligne coupée en deux par la mort du
    // processus se recollait sur la première ligne du suivant et rendait le
    // « prêt » illisible — l'erreur restait alors affichée pour toujours.
    this._buf = '';
    this._stderr = '';
    let file;
    try {
      file = this.scriptPath();
      fs.writeFileSync(file, BOM + PS, 'utf8');
    } catch (e) {
      this.error = 'Script indisponible (' + e.code + ')';
      this._publish();
      return;
    }
    try {
      this.proc = this.spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      this.error = 'PowerShell indisponible';
      this.proc = null;
      this._publish();
      return;
    }
    this._startedAt = Date.now();
    this.log('média : contrôleur lancé (' + process.arch + ', ' + file + ')');
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => {
      const msg = String(chunk).replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!msg) return;
      this._stderr = msg;
      // Le script peut se plaindre à chaque tour de boucle : sans ce filtre,
      // app.log dépassait son plafond en une heure et emportait l'historique
      // de tous les autres sous-systèmes avec lui.
      if (msg === this._lastLog) return;
      this._lastLog = msg;
      try { this.log('média : ' + msg); } catch (e) { /* journal indisponible */ }
    });
    // Un lancement qui échoue émet « error » et « close », mais PAS « exit » :
    // sans ce relais, l'erreur n'était ni affichée ni suivie d'une relance.
    this.proc.on('error', (e) => {
      this.error = 'PowerShell indisponible (' + (e && e.code ? e.code : 'inconnu') + ')';
      this.proc = null;
      this._publish();
      this._scheduleRestart();
    });
    this.proc.on('exit', (code, signal) => {
      this.proc = null;
      // Le morceau affiché appartenait au processus mort : le garder ferait
      // avancer une barre de progression toute seule jusqu'à 100 %.
      this.now = null;
      const alive = Date.now() - this._startedAt;
      // Un processus qui a tenu longtemps puis meurt est un incident isolé,
      // pas une boucle d'échec : son compteur repart. C'est ce qui distingue
      // « ça a planté une fois » de « ça ne démarre pas ».
      if (alive > 60000) this._restarts = 0;
      this._restarts++;
      this.log('média : PowerShell s’est arrêté ('
        + (signal ? 'signal ' + signal : 'code ' + code)
        + ', vécu ' + Math.round(alive / 1000) + ' s, relance n°' + this._restarts + ')');
      if (this._stopping) { this._publish(); return; }
      // Un plantage isolé se rattrape ; une boucle d'échecs, non — sans ce
      // plafond, un Windows sans SMTC relancerait PowerShell indéfiniment.
      if (this._restarts <= 3) {
        this._scheduleRestart();
      } else {
        // Le message de PowerShell vaut mieux qu'un « indisponible » sec :
        // c'est lui qui dit si c'est le type WinRT, les droits ou autre chose.
        this.error = 'Contrôleur média indisponible'
          + (this._stderr ? ' : ' + this._stderr : ' sur cette machine.');
      }
      this._publish();
    });
  }

  // La relance est annulable : sans la garder sous la main, `stop()` tuait le
  // processus et une minuterie déjà armée en ressuscitait un cinq secondes
  // plus tard — y compris pendant la fermeture de l'application.
  _scheduleRestart() {
    if (this._stopping || this._retry) return;
    this._retry = setTimeout(() => { this._retry = null; this.start(); }, 5000);
    if (this._retry.unref) this._retry.unref();
  }

  stop() {
    this._stopping = true;
    if (this._retry) { clearTimeout(this._retry); this._retry = null; }
    if (this.proc) {
      try { this.proc.stdin.end(); } catch (e) { /* déjà fermé */ }
      try { this.proc.kill(); } catch (e) { /* déjà mort */ }
      this.proc = null;
    }
    this.now = null;
    this._buf = '';
    this._publish();
  }

  _onData(chunk) {
    this._buf += chunk;
    const lines = this._buf.split(/\r?\n/);
    this._buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t || t[0] !== '{') continue;
      let d;
      try { d = JSON.parse(t); } catch (e) { continue; }
      this._apply(d);
    }
  }

  _apply(d) {
    if (d.ready) {
      // Le script a résolu SMTC : tout ce qui suivra est fiable. Il FAUT
      // prévenir l'interface, sinon le message d'erreur précédent reste
      // affiché alors que tout fonctionne.
      this.error = null;
      this._publish();
      return;
    }
    if (d.err) {
      this.error = 'Contrôleur média indisponible'
        + (this._stderr ? ' : ' + this._stderr : ' (' + d.err + ')');
      this.now = null;
    } else if (d.none) {
      this.error = null;
      this.now = null;
    } else {
      this.error = null;
      this.now = {
        title: String(d.title || ''),
        artist: String(d.artist || ''),
        album: String(d.album || ''),
        app: appName(d.app),
        playing: !!d.playing,
        progressMs: Number(d.posMs) || 0,
        durationMs: Number(d.lenMs) || 0,
        at: Number(d.at) || Date.now(),
      };
      // Certains lecteurs ne publient aucune durée : une barre de progression
      // sur une durée nulle vaut mieux cachée que fausse.
      if (!(this.now.durationMs > 0)) this.now.durationMs = 0;
    }
    this._publish();
  }

  command(cmd) {
    const known = ['next', 'prev', 'playpause', 'volup', 'voldown', 'mute'];
    if (!this.available) return { ok: false, error: 'Disponible sous Windows uniquement.' };
    if (known.indexOf(cmd) === -1) return { ok: false, error: 'Commande inconnue.' };
    if (!this.proc || !this.proc.stdin || !this.proc.stdin.writable) {
      return { ok: false, error: 'Contrôleur média non démarré.' };
    }
    try {
      this.proc.stdin.write(cmd + '\n');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: 'Commande impossible.' };
    }
  }
}

// « Spotify.exe » ou un identifiant de paquet illisible : on en tire un nom
// présentable, sinon rien du tout plutôt qu'une chaîne cryptique.
function appName(id) {
  const s = String(id || '');
  if (!s) return '';
  const m = /([A-Za-z][A-Za-z0-9 ]{2,})(?:\.exe)?$/.exec(s.replace(/_[a-z0-9]+!.*$/i, ''));
  const raw = m ? m[1] : s;
  const known = { spotify: 'Spotify', chrome: 'Chrome', msedge: 'Edge', firefox: 'Firefox',
    vlc: 'VLC', foobar2000: 'foobar2000', itunes: 'iTunes', deezer: 'Deezer',
    zunemusic: 'Groove', opera: 'Opera', brave: 'Brave' };
  const low = raw.toLowerCase().replace(/\.exe$/, '');
  return known[low] || raw.replace(/\.exe$/i, '');
}

module.exports = MediaControl;
module.exports.appName = appName;
module.exports.PS_SCRIPT = PS;
