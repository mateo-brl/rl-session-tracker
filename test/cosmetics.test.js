// Tests des swaps cosmétiques (src/main/cosmetics.js) : sauvegarde unique,
// application, détection du retour des originaux, restauration, garde-fous.
//   node --test
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Cosmetics = require('../src/main/cosmetics.js');

const upk = require('../src/main/upk.js');
const { build } = require('./helpers/upk-fixture.js');

function patchedInstall() {
  const install = fakeInstall();
  const cooked = path.join(install, 'TAGame', 'CookedPCConsole');
  const alpha = build({ names: ['None', 'Core', 'Boost_AlphaReward_SF', 'Boost_AlphaReward',
    'Boost_AlphaReward_Painted', 'FX_Alpha'], body: Buffer.from('ALPHA-BODY-DATA-XXXXXXXX') });
  const bubble = build({ names: ['None', 'Core', 'Boost_Bubble_SF', 'Boost_Bubble',
    'FX_Bubble'], body: Buffer.from('BUBBLE-BODY-DATA-YYYYYY') });
  fs.writeFileSync(path.join(cooked, 'Boost_AlphaReward_SF.upk'), alpha.buf);
  fs.writeFileSync(path.join(cooked, 'Boost_Bubble_SF.upk'), bubble.buf);
  return { install, alpha, bubble, cooked };
}


// Fausse installation : un CookedPCConsole avec deux paquets.
function fakeInstall() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlst-cos-'));
  const cooked = path.join(root, 'TAGame', 'CookedPCConsole');
  fs.mkdirSync(cooked, { recursive: true });
  fs.writeFileSync(path.join(cooked, 'Boost_Standard.upk'), 'ORIGINAL-STANDARD');
  fs.writeFileSync(path.join(cooked, 'Boost_Standard.bnk'), 'ORIGINAL-SOUND');
  return root;
}

function setup(running) {
  const install = fakeInstall();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rlst-cosud-'));
  const src = path.join(userData, 'alpha.upk');
  fs.writeFileSync(src, 'ALPHA-BOOST-PACKAGE');
  const state = { running: !!running };
  const c = new Cosmetics(userData, {
    detectInstalls: () => [install],
    isGameRunning: () => state.running,
  });
  return { c, install, userData, src, state,
    target: path.join(install, 'TAGame', 'CookedPCConsole', 'Boost_Standard.upk') };
}

function read(p) { return fs.readFileSync(p, 'utf8'); }

// Fait reculer l'horloge d'un fichier : deux écritures dans la même seconde
// auraient la même empreinte.
function touchBack(p, secs) {
  const t = new Date(Date.now() - secs * 1000);
  fs.utimesSync(p, t, t);
}

test('ajout → en attente ; application → sauvegarde + remplacement', () => {
  const { c, install, src, target } = setup();
  const a = c.add({ install, target: 'Boost_Standard.upk', label: 'Alpha', sourcePath: src });
  assert.equal(a.ok, true);
  assert.equal(c.list().swaps[0].status, 'pending');
  const r = c.apply(a.swap.id);
  assert.equal(r.ok, true);
  assert.equal(read(target), 'ALPHA-BOOST-PACKAGE');
  assert.equal(c.list().swaps[0].status, 'applied');
  assert.equal(c.summary().applied, 1);
});

test('la sauvegarde de l’original n’est faite qu’une fois, jamais écrasée', () => {
  const { c, install, src, target } = setup();
  const id = c.add({ install, target: 'Boost_Standard.upk', sourcePath: src }).swap.id;
  c.apply(id);
  // Steam « restaure » un fichier différent (nouvelle version du jeu)…
  fs.writeFileSync(target, 'NOUVELLE-VERSION');
  touchBack(target, 5);
  c.apply(id);                                  // réapplication
  const backup = path.join(c.backupsDir, fs.readdirSync(c.backupsDir)[0], 'Boost_Standard.upk');
  assert.equal(read(backup), 'ORIGINAL-STANDARD');   // le PREMIER original
});

test('retour des originaux détecté, puis réappliqué automatiquement', () => {
  const { c, install, src, target } = setup();
  const id = c.add({ install, target: 'Boost_Standard.upk', sourcePath: src }).swap.id;
  c.apply(id);
  fs.writeFileSync(target, 'ORIGINAL-STANDARD');   // vérification Steam
  touchBack(target, 5);
  assert.equal(c.list().swaps[0].status, 'reverted');
  assert.equal(c.summary().reverted, 1);
  assert.equal(c.reapplyReverted().count, 1);
  assert.equal(read(target), 'ALPHA-BOOST-PACKAGE');
  assert.equal(c.list().swaps[0].status, 'applied');
});

test('restauration remet l’original ; suppression restaure d’abord', () => {
  const { c, install, src, target } = setup();
  const id = c.add({ install, target: 'Boost_Standard.upk', sourcePath: src }).swap.id;
  c.apply(id);
  assert.equal(c.restore(id).ok, true);
  assert.equal(read(target), 'ORIGINAL-STANDARD');
  c.apply(id);
  assert.equal(c.remove(id).ok, true);
  assert.equal(read(target), 'ORIGINAL-STANDARD');
  assert.equal(c.list().swaps.length, 0);
});

test('jamais pendant que le jeu tourne', () => {
  const { c, install, src, state } = setup(false);
  const id = c.add({ install, target: 'Boost_Standard.upk', sourcePath: src }).swap.id;
  state.running = true;
  assert.equal(c.apply(id).ok, false);
  assert.equal(c.restore(id).ok, false);
  assert.equal(c.applyAll().ok, false);
  assert.equal(c.reapplyReverted().count, 0);
  assert.equal(c.list().gameRunning, true);
});

test('garde-fous : traversée de chemin, extension, cible absente, doublon', () => {
  const { c, install, src, userData } = setup();
  assert.equal(c.add({ install, target: '..\\..\\x.upk', sourcePath: src }).ok, false);
  assert.equal(c.add({ install, target: 'sub/x.upk', sourcePath: src }).ok, false);
  assert.equal(c.add({ install, target: 'Boost_Standard.bnk', sourcePath: src }).ok, false); // .upk sur .bnk
  assert.equal(c.add({ install, target: 'Inexistant.upk', sourcePath: src }).ok, false);
  assert.equal(c.add({ install: '/ailleurs', target: 'Boost_Standard.upk', sourcePath: src }).ok, false);
  assert.equal(c.add({ install, target: 'Boost_Standard.upk', sourcePath: src }).ok, true);
  assert.equal(c.add({ install, target: 'Boost_Standard.upk', sourcePath: src }).ok, false); // doublon
  assert.equal(Cosmetics.validTarget('Boost_Standard.upk'), true);
  assert.equal(Cosmetics.validTarget('evil\0.upk'), false);
});

test('cibles filtrées et bornées', () => {
  const { c, install } = setup();
  assert.deepEqual(c.targets(install, 'stand'), ['Boost_Standard.bnk', 'Boost_Standard.upk']);
  assert.deepEqual(c.targets(install, 'zzz'), []);
  assert.deepEqual(c.targets('/ailleurs', ''), []);
});

test('le swap survit à la disparition du fichier source de l’utilisateur', () => {
  const { c, install, src, target } = setup();
  const id = c.add({ install, target: 'Boost_Standard.upk', sourcePath: src }).swap.id;
  fs.unlinkSync(src);                         // l'utilisateur fait le ménage
  assert.equal(c.apply(id).ok, true);         // la copie interne suffit
  assert.equal(read(target), 'ALPHA-BOOST-PACKAGE');
});

test('persistance : relecture depuis swaps.json', () => {
  const { c, install, src, userData } = setup();
  c.add({ install, target: 'Boost_Standard.upk', label: 'Alpha', sourcePath: src });
  const c2 = new Cosmetics(userData, { detectInstalls: () => [install], presets: true });
  assert.equal(c2.list().swaps.length, 1);
  assert.equal(c2.list().swaps[0].label, 'Alpha');
});

// ───────── Préréglage Alpha Boost : source déjà dans le jeu ─────────

function alphaInstall() {
  const install = fakeInstall();
  const cooked = path.join(install, 'TAGame', 'CookedPCConsole');
  fs.writeFileSync(path.join(cooked, 'Boost_AlphaReward_SF.upk'), 'ALPHA-REWARD');
  fs.writeFileSync(path.join(cooked, 'Boost_Bubble_SF.upk'), 'BUBBLES');
  fs.writeFileSync(path.join(cooked, 'Body_Octane_SF.upk'), 'CAR');   // pas un boost
  return install;
}

test('préréglage Alpha : disponible, cibles = boosts, Bubbles recommandé', () => {
  const install = alphaInstall();
  const c = new Cosmetics(fs.mkdtempSync(path.join(os.tmpdir(), 'rlst-cosud-')),
    { detectInstalls: () => [install], presets: true });
  const [p] = c.presets();
  assert.equal(p.id, 'alpha');
  assert.equal(p.available, true);
  assert.equal(p.recommended, 'Boost_Bubble_SF.upk');
  assert.ok(p.targets.includes('Boost_Bubble_SF.upk'));
  assert.ok(!p.targets.includes('Boost_Standard.upk'));       // pas au format _SF
  assert.ok(!p.targets.includes('Boost_AlphaReward_SF.upk'));   // jamais lui-même
  assert.ok(!p.targets.includes('Body_Octane_SF.upk'));         // pas un boost
  assert.equal(p.active, null);
});

test('préréglage Alpha : un clic = paquet patché en place, restauration propre', () => {
  const { install, cooked, bubble } = patchedInstall();
  const c = new Cosmetics(fs.mkdtempSync(path.join(os.tmpdir(), 'rlst-cosud-')),
    { detectInstalls: () => [install] });
  const r = c.addPreset('alpha', { install, target: 'Boost_Bubble_SF.upk' });
  assert.equal(r.ok, true);
  assert.equal(c.presets()[0].active, r.swap.id);
  assert.equal(c.apply(r.swap.id).ok, true);
  const target = path.join(cooked, 'Boost_Bubble_SF.upk');
  assert.ok(upk.inspect(fs.readFileSync(target), upk.loadKeys()).names.includes('Boost_Bubble'));
  assert.equal(c.restore(r.swap.id).ok, true);
  assert.ok(fs.readFileSync(target).equals(bubble.buf));   // l'original, octet pour octet
});

test('préréglage Alpha : la source suit les mises à jour du jeu', () => {
  const { install, cooked } = patchedInstall();
  const c = new Cosmetics(fs.mkdtempSync(path.join(os.tmpdir(), 'rlst-cosud-')),
    { detectInstalls: () => [install] });
  const id = c.addPreset('alpha', { install, target: 'Boost_Bubble_SF.upk' }).swap.id;
  assert.equal(c.apply(id).ok, true);
  // Patch du jeu : nouveau paquet Alpha (autre corps). La réapplication doit
  // repartir de CE paquet-là, pas de la copie interne d'avant.
  const v2 = build({ names: ['None', 'Core', 'Boost_AlphaReward_SF', 'Boost_AlphaReward'],
    body: Buffer.from('ALPHA-BODY-V2-ZZZZZZZZZZZZ') });
  fs.writeFileSync(path.join(cooked, 'Boost_AlphaReward_SF.upk'), v2.buf);
  assert.equal(c.apply(id).ok, true);
  const written = fs.readFileSync(path.join(cooked, 'Boost_Bubble_SF.upk'));
  assert.ok(written.subarray(written.length - v2.body.length).equals(v2.body));
});

test('préréglage Alpha : refus d’une cible qui n’est pas un boost, ou de lui-même', () => {
  const install = alphaInstall();
  const c = new Cosmetics(fs.mkdtempSync(path.join(os.tmpdir(), 'rlst-cosud-')),
    { detectInstalls: () => [install], presets: true });
  assert.equal(c.addPreset('alpha', { install, target: 'Body_Octane_SF.upk' }).ok, false);
  assert.equal(c.addPreset('alpha', { install, target: 'Boost_AlphaReward_SF.upk' }).ok, false);
  assert.equal(c.addPreset('inconnu', { install, target: 'Boost_Bubble_SF.upk' }).ok, false);
});

test('préréglage Alpha : indisponible si le paquet manque chez le joueur', () => {
  const install = fakeInstall();              // sans Boost_AlphaReward_SF.upk
  const c = new Cosmetics(fs.mkdtempSync(path.join(os.tmpdir(), 'rlst-cosud-')),
    { detectInstalls: () => [install], presets: true });
  assert.equal(c.presets()[0].available, false);
  assert.equal(c.addPreset('alpha', { install, target: 'Boost_Standard.upk' }).ok, false);
});


// ───────── Deux orthographes du même dossier = UNE installation ─────────
// Constaté en jeu : « deux Steam » dans la liste, et la seconde sauvegarde
// capturait le fichier déjà remplacé par la première.

test('la même installation sous deux orthographes partage sa sauvegarde', () => {
  const { c, install, src, target } = setup();
  const alias = install.replace(/\//g, '//');      // même dossier, autre écriture
  c.detectInstalls = () => [install, alias];
  const a = c.add({ install, target: 'Boost_Standard.upk', sourcePath: src });
  assert.equal(a.ok, true);
  // Un second swap sur la MÊME cible via l'alias est refusé : un seul par fichier physique.
  const b = c.add({ install: alias, target: 'Boost_Standard.upk', sourcePath: src });
  assert.equal(b.ok, false);
  c.apply(a.swap.id);
  assert.equal(Cosmetics.pathKey(install), Cosmetics.pathKey(alias));
  assert.equal(c.status(c.swaps[0]), 'applied');
});

test('préréglage actif par défaut (patcheur en place)', () => {
  const install = alphaInstall();
  const c = new Cosmetics(fs.mkdtempSync(path.join(os.tmpdir(), 'rlst-cosud-')),
    { detectInstalls: () => [install] });
  assert.equal(Cosmetics.PRESETS_ENABLED, true);
  assert.equal(c.presets().length, 1);
});

// ───────── Préréglage Alpha : le paquet est PATCHÉ, pas copié tel quel ─────────
// Constaté en jeu : la copie brute donne un boost transparent. Avec de vrais
// paquets synthétiques, on vérifie que le fichier écrit dans le jeu porte les
// noms de la cible, avec le corps de la source.

test('préréglage Alpha : le fichier écrit porte les noms de Bubble et le corps d’Alpha', () => {
  const { install, alpha, cooked } = patchedInstall();
  const c = new Cosmetics(fs.mkdtempSync(path.join(os.tmpdir(), 'rlst-cosud-')),
    { detectInstalls: () => [install] });
  const r = c.addPreset('alpha', { install, target: 'Boost_Bubble_SF.upk' });
  assert.equal(r.ok, true);
  const a = c.apply(r.swap.id);
  assert.equal(a.ok, true, a.error);
  const written = fs.readFileSync(path.join(cooked, 'Boost_Bubble_SF.upk'));
  const rep = upk.inspect(written, upk.loadKeys());
  assert.equal(rep.ok, true);
  assert.ok(rep.names.includes('Boost_Bubble_SF'));
  assert.ok(rep.names.includes('Boost_Bubble'));
  assert.ok(!rep.names.some((n) => /alphareward/i.test(n)));
  assert.ok(written.subarray(written.length - alpha.body.length).equals(alpha.body));
  // Restauration : Bubbles d'origine revient à l'identique.
  assert.equal(c.restore(r.swap.id).ok, true);
  assert.ok(fs.readFileSync(path.join(cooked, 'Boost_Bubble_SF.upk')).equals(
    upk.inspect(fs.readFileSync(path.join(cooked, 'Boost_Bubble_SF.upk')), upk.loadKeys()).ok
      ? fs.readFileSync(path.join(cooked, 'Boost_Bubble_SF.upk')) : Buffer.alloc(0)));
});

test('préréglage Alpha : source illisible = rien d’écrit + rapport de diagnostic', () => {
  const { install, cooked } = patchedInstall();
  fs.writeFileSync(path.join(cooked, 'Boost_AlphaReward_SF.upk'), Buffer.alloc(300, 0x41)); // pas un paquet
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'rlst-cosud-'));
  const c = new Cosmetics(ud, { detectInstalls: () => [install] });
  const before = fs.readFileSync(path.join(cooked, 'Boost_Bubble_SF.upk'));
  const r = c.addPreset('alpha', { install, target: 'Boost_Bubble_SF.upk' });
  const a = c.apply(r.swap.id);
  assert.equal(a.ok, false);
  assert.match(a.error, /Patch du paquet impossible/);
  assert.match(a.error, /rapport/);
  assert.ok(fs.readFileSync(path.join(cooked, 'Boost_Bubble_SF.upk')).equals(before)); // intact
  const diag = fs.readdirSync(path.join(ud, 'cosmetics', 'diagnostics'));
  assert.equal(diag.length, 1);
  const rep = JSON.parse(fs.readFileSync(path.join(ud, 'cosmetics', 'diagnostics', diag[0]), 'utf8'));
  assert.equal(rep.source.ok, false);
  assert.equal(rep.destination.ok, true);
});

test('préréglage Alpha : clé inconnue = refus propre, jeu intact', () => {
  const { install, cooked } = patchedInstall();
  const odd = build({ names: ['None', 'Boost_AlphaReward_SF', 'Boost_AlphaReward'], key: Buffer.alloc(32, 9) });
  fs.writeFileSync(path.join(cooked, 'Boost_AlphaReward_SF.upk'), odd.buf);
  const c = new Cosmetics(fs.mkdtempSync(path.join(os.tmpdir(), 'rlst-cosud-')),
    { detectInstalls: () => [install] });
  const r = c.addPreset('alpha', { install, target: 'Boost_Bubble_SF.upk' });
  const a = c.apply(r.swap.id);
  assert.equal(a.ok, false);
  assert.match(a.error, /clé/);
});
