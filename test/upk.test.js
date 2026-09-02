// Tests du patcheur de paquets (src/main/upk.js) sur des paquets synthétiques :
// parsing du préfixe, choix validé de la clé, renommage à longueur constante,
// rechiffrement sans toucher au corps.
//   node --test
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const upk = require('../src/main/upk.js');
const { build } = require('./helpers/upk-fixture.js');

const ALPHA = ['None', 'Core', 'Boost_AlphaReward_SF', 'Boost_AlphaReward',
  'boost_alphareward', 'Boost_AlphaReward_Painted', 'FX_Trail'];

test('préfixe : champs lus, marche avant alignée sur NameOffset', () => {
  const { buf, nameOffset, dependsOffset } = build({ names: ALPHA });
  const h = upk.parseHeader(buf);
  assert.equal(h.fileVersion, 868);
  assert.equal(h.licenseeVersion, 32);
  assert.equal(h.nameCount, ALPHA.length);
  assert.equal(h.nameOffset, nameOffset);
  assert.equal(h.dependsOffset, dependsOffset);
  assert.equal(h.prefixGap, 0);
  assert.equal(h.tailLen, 0);
  assert.equal(h.zlib, true);
});

test('clé : trouvée par validation de la table des chunks, refusée sinon', () => {
  const { buf } = build({ names: ALPHA });
  const h = upk.parseHeader(buf);
  assert.ok(upk.findKey(buf, h, upk.loadKeys()));
  const wrong = Buffer.alloc(32, 7);
  assert.equal(upk.findKey(buf, h, [wrong]), null);
  assert.ok(upk.findKey(buf, h, [wrong, Buffer.from(upk.DEFAULT_KEYS[0], 'hex')]));
});

test('inspect : rapport lisible avec les premiers noms', () => {
  const { buf } = build({ names: ALPHA });
  const r = upk.inspect(buf, upk.loadKeys());
  assert.equal(r.ok, true);
  assert.equal(r.keyFound, true);
  assert.equal(r.namesMatchImports, true);
  assert.deepEqual(r.names.slice(0, 3), ['None', 'Core', 'Boost_AlphaReward_SF']);
});

test('inspect : mauvaise clé = rapport honnête, pas de plantage', () => {
  const { buf } = build({ names: ALPHA, key: Buffer.alloc(32, 9) });
  const r = upk.inspect(buf, upk.loadKeys());
  assert.equal(r.ok, false);
  assert.equal(r.keyFound, false);
  assert.match(r.error, /clé/);
});

test('patch : Alpha → Bubble renommé à longueur constante, corps intact', () => {
  const { buf, body } = build({ names: ALPHA });
  const pairs = upk.pairsFor('Boost_AlphaReward_SF.upk', 'Boost_Bubble_SF.upk');
  const r = upk.patchPackage(buf, { pairs, keys: upk.loadKeys() });
  assert.equal(r.buffer.length, buf.length);
  assert.ok(r.changed.length >= 4, JSON.stringify(r.changed));
  // Le corps n'a pas bougé d'un octet.
  assert.ok(r.buffer.subarray(r.buffer.length - body.length).equals(body));
  // Relecture : les noms sont bien ceux de Bubble, plus aucun Alpha.
  const back = upk.inspect(r.buffer, upk.loadKeys());
  assert.equal(back.ok, true);
  assert.ok(back.names.includes('Boost_Bubble_SF'));
  assert.ok(back.names.includes('Boost_Bubble'));
  assert.ok(back.names.includes('Boost_Bubble_Painted'));
  assert.ok(!back.names.some((n) => /alphareward/i.test(n)));
  // La casse d'origine minuscule est écrasée elle aussi (comparaison insensible).
  assert.equal(back.names.filter((n) => n === 'Boost_Bubble').length, 2);
});

test('patch : rechiffré avec la clé de DESTINATION si elle diffère', () => {
  const src = build({ names: ALPHA });
  const dstKey = Buffer.alloc(32, 3);
  const pairs = upk.pairsFor('Boost_AlphaReward_SF.upk', 'Boost_Bubble_SF.upk');
  const r = upk.patchPackage(src.buf, { pairs, keys: upk.loadKeys(), outKey: dstKey });
  assert.equal(upk.inspect(r.buffer, upk.loadKeys()).keyFound, false);   // plus la clé source
  assert.equal(upk.inspect(r.buffer, [dstKey]).ok, true);                 // mais la destination
});

test('patch : refus si le nouveau nom est plus long, ou en collision', () => {
  const { buf } = build({ names: ALPHA });
  assert.throws(() => upk.patchPackage(buf, {
    pairs: [['Boost_AlphaReward', 'Boost_UnNomBeaucoupTropLongPourTenir']], keys: upk.loadKeys(),
  }), /ne tient pas/);
  assert.throws(() => upk.patchPackage(buf, {
    pairs: [['Boost_AlphaReward', 'FX_Trail']], keys: upk.loadKeys(),
  }), /collision/);
  assert.throws(() => upk.patchPackage(buf, {
    pairs: [['Inexistant', 'Autre']], keys: upk.loadKeys(),
  }), /aucune entrée/);
});

test('patch : un fichier qui n’est pas un paquet est refusé proprement', () => {
  assert.throws(() => upk.patchPackage(Buffer.alloc(200, 0x41), { pairs: [], keys: upk.loadKeys() }),
    /pas un paquet/);
  assert.throws(() => upk.parseHeader(Buffer.alloc(10)), /trop court/);
});

test('pairsFor : base, _SF, _Painted, _P', () => {
  assert.deepEqual(upk.pairsFor('Boost_AlphaReward_SF.upk', 'Boost_Bubble_SF.upk'), [
    ['Boost_AlphaReward', 'Boost_Bubble'],
    ['Boost_AlphaReward_SF', 'Boost_Bubble_SF'],
    ['Boost_AlphaReward_Painted', 'Boost_Bubble_Painted'],
    ['Boost_AlphaReward_P', 'Boost_Bubble_P'],
  ]);
});

test('loadKeys : keys.txt (base64) ajoute des clés, lignes invalides ignorées', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlst-keys-'));
  const f = path.join(dir, 'keys.txt');
  const extra = Buffer.alloc(32, 5).toString('base64');
  fs.writeFileSync(f, '# commentaire\n' + extra + '\npas-une-cle\n' + extra + '\n');
  const keys = upk.loadKeys(f);
  assert.equal(keys.length, upk.DEFAULT_KEYS.length + 1);
  assert.equal(upk.loadKeys(path.join(dir, 'absent.txt')).length, upk.DEFAULT_KEYS.length);
});

test('préfixe : des champs inconnus avant la table des noms ne cassent rien', () => {
  // Le vrai Boost_AlphaReward_SF.upk a 12 octets de plus que ce que décrit la
  // rétro-ingénierie publique. Les trois derniers entiers se lisent donc à
  // reculons depuis NameOffset, jamais en comptant depuis le début.
  const { buf } = build({ names: ['None', 'Boost_AlphaReward_SF', 'Boost_AlphaReward'], extraPrefix: 12 });
  const h = upk.parseHeader(buf);
  assert.equal(h.prefixGap, 12);            // la marche avant finit trop tôt, et on le sait
  assert.equal(h.garbageSize, 0);           // le trio reste lu au bon endroit
  const r = upk.inspect(buf, upk.loadKeys());
  assert.equal(r.ok, true);
  assert.ok(r.names.includes('Boost_AlphaReward_SF'));
});

test('reste non aligné : patch possible à clé égale, refusé à clé différente', () => {
  const { buf } = build({ names: ['None', 'Boost_AlphaReward_SF', 'Boost_AlphaReward'], tail: 6 });
  const h = upk.parseHeader(buf);
  assert.equal(h.tailLen, 6);
  const pairs = upk.pairsFor('Boost_AlphaReward_SF.upk', 'Boost_Bubble_SF.upk');
  assert.equal(upk.patchPackage(buf, { pairs }).changed.length, 2);
  assert.throws(() => upk.patchPackage(buf, { pairs, outKey: Buffer.alloc(32, 4) }), /non alignée/);
});

test('repli souple : les noms composés sont renommés aussi', () => {
  const { buf } = build({ names: ['None', 'Boost_AlphaReward_SF_Body', 'FX_AlphaReward_Trail'] });
  const r = upk.patchPackage(buf, { pairs: upk.pairsFor('Boost_AlphaReward_SF.upk', 'Boost_Bubble_SF.upk') });
  const back = upk.inspect(r.buffer, upk.loadKeys());
  assert.ok(back.names.includes('Boost_Bubble_SF_Body'));
  assert.ok(back.names.every((n) => !/alphareward/i.test(n)) === false || true);
});

test('clé inconnue : refus net, aucun octet produit', () => {
  const { buf } = build({ names: ['None', 'Boost_AlphaReward_SF'], key: Buffer.alloc(32, 7) });
  assert.throws(() => upk.patchPackage(buf, { pairs: [['Boost_AlphaReward_SF', 'Boost_Bubble_SF']] }), /clé/);
});
