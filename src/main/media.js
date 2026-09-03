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
  $null = $t.Wait(4000)
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
$stdinDone = $false
$stdin = [System.Threading.Tasks.Task]::Run([Func[string]] { $reader.ReadLine() })

while ($true) {
  if (-not $stdinDone -and $stdin.IsCompleted) {
    $cmd = $null
    try { $cmd = $stdin.Result } catch { $stdinDone = $true }
    if ($null -eq $cmd) {
      $stdinDone = $true
    } else {
      $s = $mgr.GetCurrentSession()
      switch ($cmd.Trim()) {
        'next'      { if ($s) { $null = $s.TrySkipNextAsync() } }
        'prev'      { if ($s) { $null = $s.TrySkipPreviousAsync() } }
        'playpause' { if ($s) { $null = $s.TryTogglePlayPauseAsync() } }
        'volup'     { Send-Key 175 }
        'voldown'   { Send-Key 174 }
        'mute'      { Send-Key 173 }
      }
      $stdin = [System.Threading.Tasks.Task]::Run([Func[string]] { $reader.ReadLine() })
      Start-Sleep -Milliseconds 120
    }
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
  }

  status() {
    return { available: this.available, running: !!this.proc, error: this.error, now: this.now };
  }

  scriptPath() { return path.join(this.dir, 'media-control.ps1'); }

  start() {
    if (!this.available || this.proc) return;
    let file;
    try {
      file = this.scriptPath();
      fs.writeFileSync(file, BOM + PS, 'utf8');
    } catch (e) {
      this.error = 'Script indisponible (' + e.code + ')';
      return;
    }
    try {
      // Sysnative : depuis un processus 32 bits, c'est le chemin qui atteint le
      // PowerShell 64 bits. Sans lui, on tombe sur celui de SysWOW64, où les
      // types WinRT ne se résolvent pas — et le script sort aussitôt.
      const exe = (process.arch === 'ia32' && process.env.SystemRoot)
        ? path.join(process.env.SystemRoot, 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : 'powershell.exe';
      this.proc = this.spawn(exe,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      this.error = 'PowerShell indisponible';
      this.proc = null;
      return;
    }
    this.log('média : contrôleur lancé (' + process.arch + ', ' + file + ')');
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => {
      const msg = String(chunk).replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!msg) return;
      this._stderr = msg;
      this.log('média : ' + msg);
    });
    this.proc.on('error', () => { this.error = 'PowerShell indisponible'; this.proc = null; });
    this.proc.on('exit', (code, signal) => {
      this.proc = null;
      this.log('média : PowerShell s’est arrêté (code ' + code
        + (signal ? ', signal ' + signal : '') + ', relance n°' + this._restarts + ')');
      // Un plantage isolé se rattrape ; une boucle d'échecs, non — sans ce
      // plafond, un Windows sans SMTC relancerait PowerShell indéfiniment.
      if (this._restarts < 3) {
        this._restarts++;
        setTimeout(() => this.start(), 5000).unref?.();
      } else {
        // Le message de PowerShell vaut mieux qu'un « indisponible » sec :
        // c'est lui qui dit si c'est le type WinRT, les droits ou autre chose.
        this.error = 'Contrôleur média indisponible'
          + (this._stderr ? ' : ' + this._stderr : ' sur cette machine.');
        this.onUpdate(this.status());
      }
    });
  }

  stop() {
    if (this.proc) {
      try { this.proc.kill(); } catch (e) { /* déjà mort */ }
      this.proc = null;
    }
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
      this._restarts = 0;
      this.onUpdate(this.status());
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
        at: Date.now(),
      };
      // Certains lecteurs ne publient aucune durée : une barre de progression
      // sur une durée nulle vaut mieux cachée que fausse.
      if (!(this.now.durationMs > 0)) this.now.durationMs = 0;
    }
    this.onUpdate(this.status());
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
