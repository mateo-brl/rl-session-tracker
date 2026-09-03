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

test('overlay OBS : toile de composition bornée et entière', () => {
  const c = freshConfig();
  assert.deepEqual(c.get().obs.canvas, { w: 1920, h: 1080 });
  c.update({ obs: { canvas: { w: 2560.6, h: 1440 } } });
  assert.deepEqual(c.get().obs.canvas, { w: 2561, h: 1440 });
  c.update({ obs: { canvas: { w: 100, h: 9000 } } });        // hors bornes : ignorées
  assert.deepEqual(c.get().obs.canvas, { w: 2561, h: 1440 });
  c.update({ obs: { canvas: { w: 'large' } } });             // NaN : ignoré
  assert.equal(c.get().obs.canvas.w, 2561);
  c.update({ obs: { canvas: { h: 720 } } });                 // fusion, pas remplacement
  assert.deepEqual(c.get().obs.canvas, { w: 2561, h: 720 });
  // Les valeurs par défaut ne doivent pas avoir été écrites au passage : une
  // toile modifiée ici la changerait pour toute nouvelle configuration.
  const neuf = freshConfig();
  assert.deepEqual(neuf.get().obs.canvas, { w: 1920, h: 1080 });
});

test('alertes : interrupteurs stricts, durée bornée 2..15 s', () => {
  const c = freshConfig();
  assert.deepEqual(c.get().alerts,
    { enabled: true, streak: true, rankUp: true, mvp: true, record: true, seconds: 6 });
  c.update({ alerts: { mvp: false, record: false, seconds: 12 } });
  assert.equal(c.get().alerts.mvp, false);
  assert.equal(c.get().alerts.record, false);
  assert.equal(c.get().alerts.seconds, 12);
  assert.equal(c.get().alerts.streak, true);        // les autres restent intacts
  c.update({ alerts: { seconds: 0 } });             // sous la borne : ignoré
  assert.equal(c.get().alerts.seconds, 12);
  c.update({ alerts: { seconds: 99 } });            // au-dessus : ignoré
  assert.equal(c.get().alerts.seconds, 12);
  c.update({ alerts: { seconds: 5.4 } });           // arrondi à la seconde
  assert.equal(c.get().alerts.seconds, 5);
  c.update({ alerts: { enabled: 'oui', streak: 1 } });   // non booléens : rejetés
  assert.equal(c.get().alerts.enabled, true);
  assert.equal(c.get().alerts.streak, true);
  c.update({ alerts: { enabled: false } });
  assert.equal(c.get().alerts.enabled, false);
});

test('persistance : relecture depuis le fichier', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlst-cfg-'));
  config.init(dir);
  config.update({ pseudo: 'Mateo' });
  config.init(dir);
  assert.equal(config.get().pseudo, 'Mateo');
});

// ───────── Fenêtre de configuration : géométrie mémorisée, barre des tâches ─────────

test('trayOnly : booléen strict, défaut vrai', () => {
  const c = freshConfig();
  assert.equal(c.get().trayOnly, true);
  c.update({ trayOnly: false });
  assert.equal(c.get().trayOnly, false);
  c.update({ trayOnly: 'non' });          // ignoré
  assert.equal(c.get().trayOnly, false);
});

test('controlBounds : validé, arrondi, jamais absurde', () => {
  const c = freshConfig();
  assert.equal(c.get().controlBounds, null);
  c.update({ controlBounds: { x: 10.6, y: 20.2, width: 1080.4, height: 720, maximized: 1 } });
  assert.deepEqual(c.get().controlBounds,
    { x: 11, y: 20, width: 1080, height: 720, maximized: true });
  c.update({ controlBounds: { x: 0, y: 0, width: 50, height: 50 } });   // trop petit
  assert.equal(c.get().controlBounds.width, 1080);
  c.update({ controlBounds: { x: 'a', y: 0, width: 900, height: 700 } }); // NaN
  assert.equal(c.get().controlBounds.width, 1080);
});

test('réglage inconnu ignoré : la configuration ne se laisse pas polluer', () => {
  // Le moteur audio Alpha Boost a été retiré (le swap de fichiers rend le vrai
  // son du jeu) : une configuration qui en garde la trace ne doit ni faire
  // planter la validation, ni ressusciter la clé.
  const c = freshConfig();
  c.update({ alphaBoost: { enabled: true, volume: 0.7 }, inventé: 42 });
  assert.equal(c.get().alphaBoost, undefined);
  assert.equal(c.get()['inventé'], undefined);
});
test('atelier : ingrédients validés, valeurs inconnues ignorées', () => {
  const c = freshConfig();
  assert.equal(c.get().tune, null);                       // l'habillage décide
  c.update({ tune: { font: 'mono', cut: 'round', density: 'couch', skew: -7, italic: false } });
  assert.deepEqual(c.get().tune,
    { font: 'mono', cut: 'round', density: 'couch', skew: -7, italic: false });
  // Fusion, pas remplacement : on ne perd pas les autres ingrédients.
  c.update({ tune: { font: 'serif' } });
  assert.equal(c.get().tune.font, 'serif');
  assert.equal(c.get().tune.density, 'couch');
  // Valeurs hors liste ou hors bornes : ignorées.
  c.update({ tune: { font: '<script>', cut: 'nope', skew: 400 } });
  assert.equal(c.get().tune.font, 'serif');
  assert.equal(c.get().tune.cut, 'round');
  assert.equal(c.get().tune.skew, -7);
  c.update({ tune: null });
  assert.equal(c.get().tune, null);
});

test('looks : un look enregistré emporte ses ingrédients d’atelier', () => {
  const c = freshConfig();
  c.update({ looks: [{ id: 'a', name: 'Stream', skin: 'neon',
    theme: { win: '#22d3ee', loss: '#f43f5e', bg: '#0b0716', gold: '#facc15' },
    tune: { font: 'mono', cut: 'round' } }] });
  const l = c.get().looks[0];
  assert.equal(l.name, 'Stream');
  assert.equal(l.tune.font, 'mono');
  // Un look sans palette complète est refusé : il rendrait un aperçu faux.
  c.update({ looks: [{ id: 'b', name: 'Cassé', skin: 'neon', theme: { win: '#22d3ee' } }] });
  assert.equal(c.get().looks.length, 0);
});
