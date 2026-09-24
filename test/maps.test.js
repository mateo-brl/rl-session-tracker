// Tests des cartes workshop (src/main/maps.js) et du lecteur ZIP
// (src/main/zip.js) : import, sauvegarde unique de l'original, retour du
// fichier du jeu après une mise à jour, garde des files hors modes classiques.
//   node --test
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const MapLibrary = require('../src/main/maps.js');
const zip = require('../src/main/zip.js');

const SLOT = MapLibrary.SLOT;

// Un « paquet » minimal : la signature Unreal suivie d'un contenu reconnaissable.
function pkg(label) {
  const head = Buffer.alloc(4);
  head.writeUInt32LE(0x9E2A83C1, 0);
  return Buffer.concat([head, Buffer.from(label)]);
}

// Écrit une vraie archive ZIP (deflate ou stockée) : le lecteur est testé sur
// le format réel, pas sur une imitation.
function makeZip(files) {
  const locals = [];
  const cens = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const method = f.store ? 0 : 8;
    const data = method === 8 ? zlib.deflateRawSync(f.data) : f.data;
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(20, 4);
    loc.writeUInt16LE(method, 8);
    loc.writeUInt32LE(data.length, 18);
    loc.writeUInt32LE(f.data.length, 22);
    loc.writeUInt16LE(name.length, 26);
    locals.push(loc, name, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(f.data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    cens.push(cen, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(cens);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

// Installation factice avec l'Underpass d'origine.
function fakeInstall() {
  const install = path.join(tmp('rlst-maps-rl-'), 'rocketleague');
  const cooked = path.join(install, 'TAGame', 'CookedPCConsole');
  fs.mkdirSync(cooked, { recursive: true });
  fs.writeFileSync(path.join(cooked, SLOT), pkg('UNDERPASS-ORIGINAL'));
  return install;
}

function lib(install, extra) {
  return new MapLibrary(tmp('rlst-maps-data-'), Object.assign({
    detectInstalls: () => (install ? [install] : []),
  }, extra));
}

function file(name, content) {
  const f = path.join(tmp('rlst-maps-in-'), name);
  fs.writeFileSync(f, content);
  return f;
}

const slotOf = (install, file) => path.join(install, 'TAGame', 'CookedPCConsole', file || SLOT);
// État d'un emplacement (Underpass par défaut).
const slotState = (l, id) => l.slotStatus().find((s) => s.id === (id || 'underpass'));

test('zip : entrées stockées et compressées, chemins jamais utilisés', async () => {
  const big = Buffer.alloc(5000, 7);
  const buf = makeZip([
    { name: '../../evil/Map.udk', data: big },
    { name: 'readme.txt', data: Buffer.from('salut'), store: true },
  ]);
  const entries = zip.list(buf);
  assert.deepEqual(entries.map((e) => e.name), ['../../evil/Map.udk', 'readme.txt']);
  assert.ok(zip.extract(buf, entries[0]).equals(big));
  assert.equal(zip.extract(buf, entries[1]).toString(), 'salut');
  assert.throws(() => zip.list(Buffer.from('pas une archive du tout, vraiment')), /illisible/);
});

test('import : .zip de bakkesplugins, la carte et son aperçu en sont extraits', async () => {
  const l = lib(fakeInstall());
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]);
  const z = file('6516c70fd371490bbbede5235a8bef9c-LethIceRings_1.0.0.zip', makeZip([
    { name: 'LethIceRings/readme.txt', data: Buffer.from('lisez-moi') },
    { name: 'LethIceRings/preview.jpg', data: jpg },
    { name: 'LethIceRings/IceRings.udk', data: pkg('ICE-RINGS') },
  ]));
  const r = await l.importFile(z, { source: 'bakkesplugins' });
  assert.equal(r.ok, true);
  const listed = l.list().maps;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].title, 'IceRings');          // nom de l'entrée .udk
  assert.equal(listed[0].hasPreview, true);
  assert.match(l.preview(listed[0].id), /^data:image\/jpeg;base64,/);

  // Même contenu une seconde fois : pas de doublon, le titre de la page gagne.
  const again = await l.importFile(z, { title: 'Ice Rings', author: 'Lethamyr' });
  assert.equal(again.duplicate, true);
  assert.equal(l.list().maps.length, 1);
  assert.equal(l.list().maps[0].title, 'Ice Rings');
  assert.equal(l.list().maps[0].author, 'Lethamyr');
});

test('import : refuse ce qui n\'est pas une carte', async () => {
  const l = lib(fakeInstall());
  assert.match((await l.importFile(file('x.udk', Buffer.from('MZ pas un paquet')))).error, /pas une carte/);
  assert.match((await l.importFile(file('x.zip', makeZip([{ name: 'a.txt', data: Buffer.from('a') }])))).error,
    /Aucune carte/);
  assert.match((await l.importFile(file('x.exe', pkg('X')))).error, /Format non pris en charge/);
  assert.equal(l.list().maps.length, 0);
});

test('Underpass : charger, changer de carte, remettre l\'original intact', async () => {
  const install = fakeInstall();
  const l = lib(install);
  const a = (await l.importFile(file('A.udk', pkg('MAP-A')), { title: 'A' })).map;
  const b = (await l.importFile(file('B.udk', pkg('MAP-B')), { title: 'B' })).map;

  assert.equal((await l.load(a.id)).ok, true);
  assert.ok(fs.readFileSync(slotOf(install)).equals(pkg('MAP-A')));
  assert.deepEqual(slotState(l).loaded, { id: a.id, title: 'A' });

  // Passer de A à B ne doit PAS sauvegarder A comme « original ».
  assert.equal((await l.load(b.id)).ok, true);
  assert.ok(fs.readFileSync(slotOf(install)).equals(pkg('MAP-B')));

  assert.equal((await l.restore()).ok, true);
  assert.ok(fs.readFileSync(slotOf(install)).equals(pkg('UNDERPASS-ORIGINAL')));
  assert.equal(slotState(l).loaded, null);
});

test('Underpass : une mise à jour du jeu remet son fichier, la sauvegarde périmée est jetée', async () => {
  const install = fakeInstall();
  const l = lib(install);
  const a = (await l.importFile(file('A.udk', pkg('MAP-A')), { title: 'A' })).map;
  await l.load(a.id);

  // Le jeu se met à jour et réécrit Underpass (nouvelle version).
  fs.writeFileSync(slotOf(install), pkg('UNDERPASS-V2-PLUS-LONG'));
  const s = slotState(l);
  assert.equal(s.loaded, null);
  assert.equal(s.reverted.title, 'A');

  // Recharger sauvegarde la NOUVELLE version, et c'est elle qui revient.
  await l.load(a.id);
  await l.restore();
  assert.ok(fs.readFileSync(slotOf(install)).equals(pkg('UNDERPASS-V2-PLUS-LONG')));
});

test('Underpass : supprimer la carte chargée remet d\'abord l\'original', async () => {
  const install = fakeInstall();
  const l = lib(install);
  const a = (await l.importFile(file('A.udk', pkg('MAP-A')))).map;
  await l.load(a.id);
  assert.equal((await l.remove(a.id)).ok, true);
  assert.ok(fs.readFileSync(slotOf(install)).equals(pkg('UNDERPASS-ORIGINAL')));
  assert.equal(l.list().maps.length, 0);
});

test('Underpass : état conservé d\'un lancement de l\'application à l\'autre', async () => {
  const install = fakeInstall();
  const data = tmp('rlst-maps-data-');
  const l1 = new MapLibrary(data, { detectInstalls: () => [install] });
  const a = (await l1.importFile(file('A.udk', pkg('MAP-A')), { title: 'A' })).map;
  await l1.load(a.id);
  const l2 = new MapLibrary(data, { detectInstalls: () => [install] });
  assert.equal(slotState(l2).loaded.title, 'A');
  await l2.restore();
  assert.ok(fs.readFileSync(slotOf(install)).equals(pkg('UNDERPASS-ORIGINAL')));
});

test('garde des files : modes classiques tranquilles, tout le reste remet Underpass', async () => {
  const install = fakeInstall();
  const l = lib(install);
  const a = (await l.importFile(file('A.udk', pkg('MAP-A')))).map;
  await l.load(a.id);
  assert.deepEqual((await l.guardQueue({ playlist: 11 })).restored, []);   // Doubles classé
  assert.deepEqual((await l.guardQueue({ playlist: 3 })).restored, []);    // Standard casual
  assert.equal(slotState(l).loaded.id, a.id);
  assert.deepEqual((await l.guardQueue({ playlist: 15 })).restored, ['Underpass']);   // Rumble
  assert.ok(fs.readFileSync(slotOf(install)).equals(pkg('UNDERPASS-ORIGINAL')));
  assert.deepEqual((await l.guardQueue({ playlist: 15 })).restored, []);   // plus rien à remettre
});

test('Underpass : sans installation, ou sans Underpass, erreur claire', async () => {
  const l = lib(null);
  const a = (await l.importFile(file('A.udk', pkg('MAP-A')))).map;
  assert.match((await l.load(a.id)).error, /Aucune installation/);

  const install = fakeInstall();
  fs.rmSync(slotOf(install));
  const l2 = lib(install);
  const b = (await l2.importFile(file('B.udk', pkg('MAP-B')))).map;
  assert.match((await l2.load(b.id)).error, /introuvable/);
});

test('titre tiré du nom de fichier du CDN', async () => {
  assert.equal(MapLibrary.titleFromFile('6516c70fd371490bbbede5235a8bef9c-LethIceRings_1.0.0.zip'),
    'LethIceRings');
  assert.equal(MapLibrary.titleFromFile('Dribble_Challenge_2.udk'), 'Dribble Challenge 2');
});

test('lire l\'état PENDANT une copie ne fait pas passer la carte pour une remise du jeu', async () => {
  const install = fakeInstall();
  const l = lib(install);
  const a = (await l.importFile(file('A.udk', pkg('MAP-A')), { title: 'A' })).map;
  const b = (await l.importFile(file('B.udk', pkg('MAP-B-PLUS-LONGUE')), { title: 'B' })).map;
  await l.load(a.id);
  // Passage à B, et la fenêtre (ou le diagnostic) relit l'état en même temps.
  const p = l.load(b.id);
  const guard = l.guardQueue({ playlist: 28 });   // Rumble classé, en file derrière
  for (let i = 0; i < 5; i++) { l.list(); await new Promise((r) => setImmediate(r)); }
  assert.equal((await p).ok, true);
  assert.deepEqual((await guard).restored, ['Underpass']);
  // Le vrai original a survécu aux lectures concurrentes.
  assert.ok(fs.readFileSync(slotOf(install)).equals(pkg('UNDERPASS-ORIGINAL')));
});

// Copie vers le jeu qui s'arrête en route (disque plein) : quelques octets
// écrits, puis l'erreur.
async function withBrokenCopy(targetName, fn) {
  const real = fs.promises.copyFile;
  fs.promises.copyFile = async (src, dest) => {
    if (path.basename(dest) === targetName && !src.includes('backups')) {
      fs.writeFileSync(dest, Buffer.from('TRONQ'));
      const e = new Error('ENOSPC: plus de place');
      e.code = 'ENOSPC';
      throw e;
    }
    return real(src, dest);
  };
  try { return await fn(); } finally { fs.promises.copyFile = real; }
}

test('copie interrompue : l\'original est remis, la sauvegarde n\'est jamais perdue', async () => {
  const install = fakeInstall();
  const l = lib(install);
  const a = (await l.importFile(file('A.udk', pkg('MAP-A')), { title: 'A' })).map;
  const r = await withBrokenCopy(SLOT, () => l.load(a.id));
  assert.equal(r.ok, false);
  assert.match(r.error, /Disque plein/);
  assert.ok(fs.readFileSync(slotOf(install)).equals(pkg('UNDERPASS-ORIGINAL')));
  assert.equal(slotState(l).loaded, null);

  // Et ensuite, tout refonctionne normalement.
  assert.equal((await l.load(a.id)).ok, true);
  assert.equal((await l.restore()).ok, true);
  assert.ok(fs.readFileSync(slotOf(install)).equals(pkg('UNDERPASS-ORIGINAL')));
});

// Installation avec une seconde arène Labs (Octagon), pour les emplacements.
function twoSlotInstall() {
  const install = fakeInstall();
  fs.writeFileSync(slotOf(install, 'Labs_Octagon_02_P.upk'), pkg('OCTAGON-ORIGINAL'));
  return install;
}

test('emplacements : seules les arènes présentes dans le jeu sont proposées', async () => {
  const l = lib(twoSlotInstall());
  assert.deepEqual(l.slotStatus().map((s) => s.id), ['underpass', 'octagon']);
  assert.deepEqual(l.slotStatus().map((s) => s.guard), ['extra', 'any']);
});

test('emplacements : deux cartes chargées à la fois, remises chacune de son côté', async () => {
  const install = twoSlotInstall();
  const l = lib(install);
  const a = (await l.importFile(file('A.udk', pkg('MAP-A')), { title: 'A' })).map;
  const b = (await l.importFile(file('B.udk', pkg('MAP-B')), { title: 'B' })).map;
  assert.equal((await l.load(a.id, 'underpass')).ok, true);
  assert.equal((await l.load(b.id, 'octagon')).ok, true);
  assert.ok(fs.readFileSync(slotOf(install)).equals(pkg('MAP-A')));
  assert.ok(fs.readFileSync(slotOf(install, 'Labs_Octagon_02_P.upk')).equals(pkg('MAP-B')));
  const listed = l.list().maps;
  assert.deepEqual(listed.find((m) => m.id === b.id).loadedIn, ['octagon']);

  assert.equal((await l.restore('octagon')).ok, true);
  assert.ok(fs.readFileSync(slotOf(install, 'Labs_Octagon_02_P.upk')).equals(pkg('OCTAGON-ORIGINAL')));
  assert.equal(slotState(l).loaded.id, a.id);          // Underpass intact

  assert.equal((await l.load(b.id, 'octagon')).ok, true);
  assert.equal((await l.restore()).ok, true);           // tout remettre
  assert.ok(fs.readFileSync(slotOf(install)).equals(pkg('UNDERPASS-ORIGINAL')));
  assert.ok(fs.readFileSync(slotOf(install, 'Labs_Octagon_02_P.upk')).equals(pkg('OCTAGON-ORIGINAL')));
});

test('garde des files : les autres arènes repartent à TOUTE recherche, Underpass seulement hors modes classiques', async () => {
  const install = twoSlotInstall();
  const l = lib(install);
  const a = (await l.importFile(file('A.udk', pkg('MAP-A')))).map;
  const b = (await l.importFile(file('B.udk', pkg('MAP-B')))).map;
  await l.load(a.id, 'underpass');
  await l.load(b.id, 'octagon');
  const g = await l.guardQueue({ playlist: 11 });          // Doubles classé
  assert.deepEqual(g.restored, ['Octagon']);
  assert.ok(fs.readFileSync(slotOf(install, 'Labs_Octagon_02_P.upk')).equals(pkg('OCTAGON-ORIGINAL')));
  assert.equal(slotState(l).loaded.id, a.id);
});

test('emplacement inconnu ou absent du jeu : refus clair', async () => {
  const l = lib(fakeInstall());
  const a = (await l.importFile(file('A.udk', pkg('MAP-A')))).map;
  assert.match((await l.load(a.id, 'nimporte')).error, /Emplacement inconnu/);
  assert.match((await l.load(a.id, 'octagon')).error, /Octagon introuvable/);
});

test('favoris : en tête de liste, conservés', async () => {
  const data = tmp('rlst-maps-data-');
  const l = new MapLibrary(data, { detectInstalls: () => [] });
  const a = (await l.importFile(file('A.udk', pkg('MAP-A')), { title: 'A' })).map;
  await l.importFile(file('B.udk', pkg('MAP-B')), { title: 'B' });
  assert.equal(l.list().maps[0].title, 'B');               // la plus récente d'abord
  assert.equal(l.setFavorite(a.id, true).ok, true);
  assert.equal(l.list().maps[0].title, 'A');
  const again = new MapLibrary(data, { detectInstalls: () => [] });
  assert.equal(again.list().maps[0].favorite, true);
});

test('reprise du format 3.33 : l\'Underpass chargé reste connu et se remet', async () => {
  const install = fakeInstall();
  const data = tmp('rlst-maps-data-');
  const l = new MapLibrary(data, { detectInstalls: () => [install] });
  const a = (await l.importFile(file('A.udk', pkg('MAP-A')), { title: 'A' })).map;
  await l.load(a.id);
  // Réécrit le fichier comme la 3.33 l'aurait laissé.
  const lib33 = JSON.parse(fs.readFileSync(path.join(data, 'maps', 'library.json'), 'utf8'));
  const st = lib33.slots.underpass;
  for (const k of Object.keys(st.installs)) delete st.installs[k].file;
  fs.writeFileSync(path.join(data, 'maps', 'library.json'),
    JSON.stringify({ maps: lib33.maps, slot: { loaded: st.loaded, installs: st.installs }, reverted: null }));
  const l2 = new MapLibrary(data, { detectInstalls: () => [install] });
  assert.equal(slotState(l2).loaded.title, 'A');
  assert.equal((await l2.restore()).ok, true);
  assert.ok(fs.readFileSync(slotOf(install)).equals(pkg('UNDERPASS-ORIGINAL')));
});
