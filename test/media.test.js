'use strict';
// Tests du contrôleur média. Aucun PowerShell lancé : le processus est simulé.
// Ce qui compte : la lecture des lignes JSON, le refus propre hors Windows, et
// le plafond de relances (sans lui, une machine sans SMTC relancerait
// PowerShell sans fin).

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const MediaControl = require('../src/main/media.js');

function dir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'rlst-media-')); }

// Faux processus : un stdout et un stdin dont on relit ce qui a été écrit.
function fakeProc() {
  const p = new EventEmitter();
  p.stdout = new EventEmitter();
  p.stdout.setEncoding = () => {};
  p.stderr = new EventEmitter();
  p.stderr.setEncoding = () => {};
  p.written = [];
  p.stdin = { writable: true, write: (s) => { p.written.push(s); return true; } };
  p.kill = () => { p.killed = true; };
  return p;
}

function make(opts) {
  const proc = fakeProc();
  const seen = [];
  const m = new MediaControl(dir(), Object.assign({
    platform: 'win32',
    spawn: () => proc,
    onUpdate: (st) => seen.push(st),
  }, opts || {}));
  return { m, proc, seen };
}

test('hors Windows : rien n’est lancé, et la commande le dit', () => {
  const m = new MediaControl(dir(), { platform: 'linux', spawn: () => { throw new Error('non'); } });
  m.start();
  assert.equal(m.status().available, false);
  assert.equal(m.status().running, false);
  const r = m.command('next');
  assert.equal(r.ok, false);
  assert.match(r.error, /Windows/);
});

test('lecture : une ligne JSON par changement, découpée sur les retours', () => {
  const { m, proc, seen } = make();
  m.start();
  // Le script écrit le titre en deux morceaux : le tampon doit recoller.
  proc.stdout.emit('data', '{"title":"Endgame","artist":"Bossfight",');
  assert.equal(m.now, null);                      // ligne incomplète : rien encore
  proc.stdout.emit('data', '"playing":true,"posMs":42000,"lenMs":210000,'
    + '"app":"Spotify.exe"}\n');
  assert.equal(m.now.title, 'Endgame');
  assert.equal(m.now.artist, 'Bossfight');
  assert.equal(m.now.playing, true);
  assert.equal(m.now.durationMs, 210000);
  assert.equal(m.now.app, 'Spotify');
  assert.ok(seen.length >= 1);
});

test('rien ne joue : état vidé, sans erreur', () => {
  const { m, proc } = make();
  m.start();
  proc.stdout.emit('data', '{"title":"X","playing":true,"posMs":0,"lenMs":1000}\n');
  assert.ok(m.now);
  proc.stdout.emit('data', '{"none":true}\n');
  assert.equal(m.now, null);
  assert.equal(m.status().error, null);
});

test('durée absente : pas de barre de progression menteuse', () => {
  const { m, proc } = make();
  m.start();
  proc.stdout.emit('data', '{"title":"Radio","playing":true,"posMs":0,"lenMs":0}\n');
  assert.equal(m.now.durationMs, 0);
});

test('lignes illisibles ignorées, sans casser le flux', () => {
  const { m, proc } = make();
  m.start();
  proc.stdout.emit('data', 'Le terme « Get-Now » n’est pas reconnu\n');
  proc.stdout.emit('data', '{pas du json}\n');
  proc.stdout.emit('data', '{"title":"Après","playing":false,"posMs":1,"lenMs":2}\n');
  assert.equal(m.now.title, 'Après');
});

test('commandes : seules les connues passent, écrites sur l’entrée standard', () => {
  const { m, proc } = make();
  m.start();
  assert.equal(m.command('next').ok, true);
  assert.equal(m.command('volup').ok, true);
  assert.equal(m.command('mute').ok, true);
  assert.deepEqual(proc.written, ['next\n', 'volup\n', 'mute\n']);
  const bad = m.command('rm -rf');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /inconnue/);
  assert.equal(proc.written.length, 3);           // rien d'autre n'est passé
});

test('processus mort : relancé, mais pas indéfiniment', () => {
  let spawned = 0;
  const procs = [];
  const m = new MediaControl(dir(), {
    platform: 'win32',
    spawn: () => { spawned++; const p = fakeProc(); procs.push(p); return p; },
  });
  m.start();
  assert.equal(spawned, 1);
  // Quatre morts d'affilée : trois relances au plus, puis on renonce en le
  // disant, plutôt que de relancer PowerShell sans fin.
  for (let i = 0; i < 5; i++) {
    procs[procs.length - 1].emit('exit', 1);
    m._restarts = Math.min(m._restarts, 3);
    if (m._restarts < 3) { m.start(); }
  }
  assert.ok(spawned <= 4, 'relances plafonnées, vu ' + spawned);
});

test('nom d’application : lisible, ou rien', () => {
  const f = MediaControl.appName;
  assert.equal(f('Spotify.exe'), 'Spotify');
  assert.equal(f('chrome.exe'), 'Chrome');
  // Identifiant de paquet du Store : on garde la partie parlante.
  assert.equal(f('Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic'), 'Groove');
  assert.equal(f(''), '');
});

test('le script PowerShell n’écrit rien hors de son flux, et se ferme proprement', () => {
  const ps = MediaControl.PS_SCRIPT;
  // Aucune commande destructrice, aucune sortie réseau : ce script ne fait que
  // lire SMTC et envoyer des touches multimédia.
  assert.ok(!/Remove-Item|Invoke-WebRequest|Invoke-Expression|Start-Process/i.test(ps));
  assert.ok(ps.includes('GlobalSystemMediaTransportControlsSessionManager'));
  assert.ok(ps.includes('TrySkipNextAsync'));
  assert.ok(ps.includes('keybd_event'));
});

test('erreur PowerShell : remontée telle quelle, pas noyée dans « indisponible »', () => {
  let spawned = 0;
  const procs = [];
  const seen = [];
  const m = new MediaControl(dir(), {
    platform: 'win32',
    spawn: () => { spawned++; const p = fakeProc(); procs.push(p); return p; },
    onUpdate: (st) => seen.push(st),
  });
  m.start();
  const p = procs[0];
  p.stderr.emit('data', 'Impossible de trouver le type [Windows.Media.Control...]\n');
  // Trois relances, puis on renonce — en disant CE QUE PowerShell a dit.
  m._restarts = 3;
  p.emit('exit', 1);
  assert.match(m.status().error, /Impossible de trouver le type/);
});

test('ligne « prêt » : l’erreur est effacée ET l’interface prévenue', () => {
  // Sans la notification, le message « indisponible » restait affiché alors
  // que le contrôleur venait de démarrer.
  const { m, proc, seen } = make();
  m.start();
  m.error = 'vieille erreur';
  const before = seen.length;
  proc.stdout.emit('data', '{"ready":true}\n');
  assert.equal(m.status().error, null);
  assert.equal(m.now, null);          // « prêt » n'invente pas de lecture
  assert.ok(seen.length > before, 'l’interface doit être prévenue');
  assert.equal(seen[seen.length - 1].error, null);
});

test('script : aucune conversion de bloc de script en délégué', () => {
  // CAUSE RÉELLE du bug d'origine : [Task]::Run([Func[string]]{ ... }) échoue
  // toujours, parce que convertir un bloc de script en délégué exige un espace
  // d'exécution sur le thread appelant, et un thread du pool n'en a pas. La
  // tâche partait en faute, le script prenait ça pour une fin de flux et
  // sortait. ReadLineAsync est du CLR pur : aucun espace d'exécution requis.
  const ps = MediaControl.PS_SCRIPT;
  assert.ok(!/\[Func\[/.test(ps), 'plus de bloc de script converti en délégué');
  assert.ok(!/Task\]::Run/.test(ps), 'plus de Task::Run');
  assert.ok(ps.includes('ReadLineAsync'));
  // Le script doit pouvoir se terminer : c'est la seule chose qui empêche un
  // PowerShell invisible de survivre à la fermeture de l'application.
  const i = ps.indexOf('while ($true)');
  assert.ok(i !== -1);
  assert.ok(/\bbreak\b/.test(ps.slice(i)), 'la boucle doit pouvoir sortir sur fin de flux');
  // Le délai d'attente doit être honoré, sinon lire .Result bloque à jamais.
  assert.ok(ps.includes('if (-not $t.Wait(4000)) { return $null }'));
  // Accents lisibles côté Node.
  assert.ok(ps.includes('[Console]::OutputEncoding'));
});

test('arrêt : rien ne ressuscite le processus, et l’état est vidé', () => {
  let spawned = 0;
  const procs = [];
  const m = new MediaControl(dir(), {
    platform: 'win32',
    spawn: () => { spawned++; const p = fakeProc(); procs.push(p); return p; },
  });
  m.start();
  m.now = { title: 'Vieux morceau' };
  m.stop();
  // La mort du processus arrive APRÈS le kill : sans le drapeau d'arrêt, elle
  // armait une relance qui ressuscitait tout cinq secondes plus tard.
  procs[0].emit('exit', null, 'SIGTERM');
  assert.equal(m._retry, null, 'aucune relance armée');
  assert.equal(spawned, 1);
  assert.equal(m.status().now, null, 'le morceau du processus mort est oublié');
  m.start();
  assert.equal(spawned, 1, 'un démarrage après arrêt ne relance rien');
});

test('mort du processus : le morceau affiché est oublié', () => {
  const { m, proc, seen } = make();
  m.start();
  proc.stdout.emit('data', '{"title":"Endgame","playing":true,"posMs":1,"lenMs":2}\n');
  assert.ok(m.now);
  proc.emit('exit', 1);
  assert.equal(m.now, null, 'sinon la barre de progression avance toute seule');
  assert.ok(seen[seen.length - 1].now === null);
});

test('relances : le plafond tient même après un « prêt »', () => {
  // « prêt » est écrit AVANT la boucle : il dit que SMTC répond, pas que le
  // processus est stable. Le compter comme un succès rendait le plafond
  // inopérant et relançait PowerShell toutes les cinq secondes, sans fin.
  let spawned = 0;
  const procs = [];
  const m = new MediaControl(dir(), {
    platform: 'win32',
    spawn: () => { spawned++; const p = fakeProc(); procs.push(p); return p; },
  });
  m.start();
  for (let i = 0; i < 6; i++) {
    const p = procs[procs.length - 1];
    p.stdout.emit('data', '{"ready":true}\n');
    p.emit('exit', 1);
    if (m._retry) { clearTimeout(m._retry); m._retry = null; m.start(); }
  }
  assert.ok(spawned <= 4, 'relances plafonnées malgré les « prêt », vu ' + spawned);
  assert.match(m.status().error || '', /indisponible/);
});

test('lancement impossible : l’interface est prévenue et une relance est armée', () => {
  const procs = [];
  const seen = [];
  const m = new MediaControl(dir(), {
    platform: 'win32',
    spawn: () => { const p = fakeProc(); procs.push(p); return p; },
    onUpdate: (st) => seen.push(st),
  });
  m.start();
  const before = seen.length;
  // Un lancement raté émet « error » puis « close », jamais « exit ».
  procs[0].emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
  assert.ok(seen.length > before, 'l’interface doit être prévenue');
  assert.match(m.status().error, /ENOENT/);
  assert.ok(m._retry, 'une relance doit être armée');
  clearTimeout(m._retry);
});

test('reste de ligne : la mort du processus ne pollue pas le suivant', () => {
  const { m, proc } = make();
  m.start();
  proc.stdout.emit('data', '{"title":"Endga');     // ligne coupée en deux
  proc.emit('exit', 1);
  m._stopping = false;
  if (m._retry) { clearTimeout(m._retry); m._retry = null; }
  m.start();
  // Sans remise à zéro du tampon, ce « prêt » se collait au reste précédent,
  // devenait illisible, et l'erreur restait affichée pour toujours.
  m._stderr = '';
  const p2 = m.proc;
  p2.stdout.emit('data', '{"ready":true}\n');
  assert.equal(m.status().error, null);
});

test('horodatage : celui du script est conservé, pas celui de la réception', () => {
  // Le script date son relevé pour que l'affichage puisse annuler le retard du
  // tuyau ; l'écraser faisait avancer la barre d'environ une seconde d'avance.
  const { m, proc } = make();
  m.start();
  const at = Date.now() - 5000;
  proc.stdout.emit('data', JSON.stringify({ title: 'X', playing: true, posMs: 1000,
    lenMs: 200000, at: at }) + '\n');
  assert.equal(m.now.at, at);
});
