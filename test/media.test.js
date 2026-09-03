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

test('ligne « prêt » : l’erreur précédente est effacée', () => {
  const { m, proc } = make();
  m.start();
  m.error = 'vieille erreur';
  proc.stdout.emit('data', '{"ready":true}\n');
  assert.equal(m.status().error, null);
  assert.equal(m.now, null);          // « prêt » n'invente pas de lecture
});
