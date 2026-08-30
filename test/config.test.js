// Tests de la configuration (src/main/config.js) : validation des entrées.
//   node --test test/
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../src/main/config.js');

function freshConfig() {
  config.init(fs.mkdtempSync(path.join(os.tmpdir(), 'rlst-cfg-')));
  return config;
}

test('valeurs par défaut saines', () => {
  const c = freshConfig().get();
  assert.equal(c.pseudo, '');
  assert.equal(c.autoDashboard, true);
  assert.equal(c.statsApiPort, 49123);
  assert.equal(c.anim.preset, 'broadcast');
});

test('pseudo borné et nettoyé', () => {
  const c = freshConfig();
  c.update({ pseudo: '  ' + 'x'.repeat(100) });
  assert.equal(c.get().pseudo.length, 64);
});

test('calibrage MMR : valeurs valides uniquement', () => {
  const c = freshConfig();
  c.update({ mmrSet: { mode: '2v2', value: 1234.7 } });
  assert.equal(c.get().mmr['2v2'].base, 1235);
  c.update({ mmrSet: { mode: '2v2', value: null } });    // effacement
  assert.equal(c.get().mmr['2v2'], undefined);
  c.update({ mmrSet: { mode: '3v3', value: 'abc' } });   // rejeté
  assert.equal(c.get().mmr['3v3'], undefined);
});

test('thème : hex valides seulement, null = défaut', () => {
  const c = freshConfig();
  c.update({ theme: { win: '#00FF00', loss: 'rouge', bg: '#111111' } });
  assert.deepEqual(c.get().theme, { win: '#00ff00', bg: '#111111' });
  c.update({ theme: null });
  assert.equal(c.get().theme, null);
});

test('disposition : positions bornées, écrite dans le profil actif', () => {
  const c = freshConfig();
  c.update({ layout: { hero: { x: 120, y: -5, w: 300, h: 2, hidden: 1 } } });
  assert.deepEqual(c.get().layouts['1'].hero,
    { x: 95, y: 0, w: 100, h: 5, hidden: true });
  c.update({ layoutSlot: '2' });
  c.update({ layout: { hero: { x: 10, y: 10, w: 30, h: 30 } } });
  assert.equal(c.get().layouts['2'].hero.x, 10);
  assert.equal(c.get().layouts['1'].hero.x, 95);   // profil 1 intact
  c.update({ layoutSlot: '9' });                   // slot invalide ignoré
  assert.equal(c.get().layoutSlot, '2');
});

test('objectif de session et langue bornés', () => {
  const c = freshConfig();
  c.update({ sessionGoal: 70.4 });
  assert.equal(c.get().sessionGoal, 70);
  c.update({ sessionGoal: 9999 });
  assert.equal(c.get().sessionGoal, 70);
  c.update({ lang: 'en' });
  assert.equal(c.get().lang, 'en');
  c.update({ lang: 'de' });
  assert.equal(c.get().lang, 'en');
});

test('animations : preset inconnu ignoré', () => {
  const c = freshConfig();
  c.update({ anim: { preset: 'arcade', endMatch: false } });
  assert.equal(c.get().anim.preset, 'arcade');
  assert.equal(c.get().anim.endMatch, false);
  c.update({ anim: { preset: '<script>' } });
  assert.equal(c.get().anim.preset, 'arcade');
});

test('overlay : échelle et opacité bornées', () => {
  const c = freshConfig();
  c.update({ overlayCfg: { scale: 99, opacity: 0.01, showLive: false } });
  assert.equal(c.get().overlayCfg.scale, 1);       // hors bornes : inchangée
  assert.equal(c.get().overlayCfg.opacity, 1);
  assert.equal(c.get().overlayCfg.showLive, false);
});


test('statut Discord : booléen strict', () => {
  const c = freshConfig();
  assert.equal(c.get().discordRpc, false);           // désactivé par défaut
  c.update({ discordRpc: true });
  assert.equal(c.get().discordRpc, true);
  c.update({ discordRpc: 'oui' });                   // rejeté
  assert.equal(c.get().discordRpc, true);
});

test('nouveaux styles : animations neon/cinema et jingles', () => {
  const c = freshConfig();
  c.update({ anim: { preset: 'neon' } });
  assert.equal(c.get().anim.preset, 'neon');
  c.update({ anim: { preset: 'cinema' } });
  assert.equal(c.get().anim.preset, 'cinema');
  assert.equal(c.get().soundPreset, 'broadcast');   // défaut
  c.update({ soundPreset: 'epic' });
  assert.equal(c.get().soundPreset, 'epic');
  c.update({ soundPreset: 'dubstep' });             // inconnu : rejeté
  assert.equal(c.get().soundPreset, 'epic');
});

test('overlay OBS : port borné', () => {
  const c = freshConfig();
  assert.equal(c.get().obs.enabled, false);
  c.update({ obs: { enabled: true, port: 50000 } });
  assert.equal(c.get().obs.enabled, true);
  assert.equal(c.get().obs.port, 50000);
  c.update({ obs: { port: 80 } });                   // < 1024 : rejeté
  assert.equal(c.get().obs.port, 50000);
  c.update({ obs: { port: 'quatre' } });             // rejeté
  assert.equal(c.get().obs.port, 50000);
});

test('overlay OBS : style, échelle et contenu validés', () => {
  const c = freshConfig();
  assert.equal(c.get().obs.style, 'broadcast');      // défauts
  assert.equal(c.get().obs.showLive, true);
  c.update({ obs: { style: 'vertical', scale: 1.25, bgOpacity: 0.5,
    showLive: false, banner: false } });
  assert.equal(c.get().obs.style, 'vertical');
  assert.equal(c.get().obs.scale, 1.25);
  assert.equal(c.get().obs.bgOpacity, 0.5);
  assert.equal(c.get().obs.showLive, false);
  assert.equal(c.get().obs.banner, false);
  assert.equal(c.get().obs.goalFlash, true);         // intact
  c.update({ obs: { style: 'fantaisie', scale: 9, bgOpacity: 0 } });  // rejetés
  assert.equal(c.get().obs.style, 'vertical');
  assert.equal(c.get().obs.scale, 1.25);
  assert.equal(c.get().obs.bgOpacity, 0.5);
});

test('persistance : relecture depuis le fichier', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlst-cfg-'));
  config.init(dir);
  config.update({ pseudo: 'Mateo' });
  config.init(dir);
  assert.equal(config.get().pseudo, 'Mateo');
});
