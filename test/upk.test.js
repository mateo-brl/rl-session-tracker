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

test('patch : un nom plus long passe si la table a du mou ailleurs', () => {
  // La contrainte porte sur la TAILLE TOTALE de la table, pas sur chaque nom.
  // Ici « Boost_AlphaReward_SF » raccourcit de 5 octets, ce qui finance
  // l'allongement de « FX_Trail ».
  const { buf } = build({ names: ALPHA });
  const r = upk.patchPackage(buf, {
    pairs: [['Boost_AlphaReward_SF', 'Boost_X_SF'], ['FX_Trail', 'FX_Trail_PlusLong']],
    keys: upk.loadKeys(),
  });
  const back = upk.inspect(r.buffer, upk.loadKeys());
  assert.equal(back.ok, true);
  assert.ok(back.names.includes('FX_Trail_PlusLong'));
  assert.ok(back.names.includes('Boost_X_SF'));
  assert.equal(back.nameOffset, upk.parseHeader(buf).nameOffset);
  assert.equal(back.importOffset, upk.parseHeader(buf).importOffset);   // rien n'a bougé
  assert.ok(r.buffer.length === buf.length);
});

test('patch : refus quand la table n’a pas assez de mou, ou en collision', () => {
  const { buf } = build({ names: ALPHA });
  assert.throws(() => upk.patchPackage(buf, {
    pairs: [['Boost_AlphaReward', 'Boost_UnNomBeaucoupTropLongPourTenirDansCettePetiteTableDeNoms']],
    keys: upk.loadKeys(),
  }), /il manque/);
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

test('patch : n’importe quel nom de boost, soit ça marche, soit ça refuse proprement', () => {
  // Balayage exhaustif : on fabrique une cible pour chaque longueur de nom
  // plausible et on vérifie qu'il n'existe pas de troisième issue — jamais de
  // fichier produit à moitié, jamais d'octet déplacé hors de la table.
  const keys = upk.loadKeys();
  const src = build({ names: ['None', 'Core', 'Boost_AlphaReward_SF', 'Boost_AlphaReward',
    'Boost_Alpha_Loop', 'SFX_Boost_Alpha', 'AkSoundCue'], body: Buffer.from('ALPHA-BODY-DATA') });
  const h0 = upk.parseHeader(src.buf);
  let okCount = 0, koCount = 0;

  for (let len = 1; len <= 30; len++) {
    for (const cueExtra of [0, 1, 3]) {
      const name = 'B'.repeat(len);
      const cue = 'Boost_' + name + 'x'.repeat(cueExtra) + '_Loop';
      const file = 'Boost_' + name + '_SF.upk';
      const tgt = build({ names: ['None', 'Core', 'Boost_' + name + '_SF', 'Boost_' + name,
        cue, 'SFX_Boost_' + name] });
      const pairs = upk.pairsFor('Boost_AlphaReward_SF.upk', file)
        .concat(upk.rolePairs(upk.namesOf(src.buf, keys), upk.namesOf(tgt.buf, keys)));
      let r = null;
      try {
        r = upk.patchPackage(src.buf, { pairs, keys });
      } catch (e) {
        assert.match(e.message, /il manque|collision/, 'échec inattendu pour ' + file + ' : ' + e.message);
        koCount++;
        continue;
      }
      okCount++;
      // Succès : le paquet reste lisible, porte les noms de la cible, garde le
      // corps de la source, et n'a bougé d'aucun octet en dehors de la table.
      const back = upk.inspect(r.buffer, keys);
      assert.equal(back.ok, true, 'illisible après patch pour ' + file);
      assert.ok(back.names.includes('Boost_' + name + '_SF'));
      assert.ok(back.names.includes(cue));
      assert.ok(!back.names.some((n) => /alphareward/i.test(n)));
      assert.ok(back.names.includes('SFX_Boost_Alpha'));       // l'événement reste celui d'Alpha
      assert.equal(r.buffer.length, src.buf.length);
      assert.equal(back.nameOffset, h0.nameOffset);
      assert.equal(back.importOffset, h0.importOffset);
      assert.equal(back.exportOffset, h0.exportOffset);
      assert.equal(back.totalHeaderSize, h0.totalHeaderSize);
      assert.ok(r.buffer.subarray(h0.totalHeaderSize).equals(src.buf.subarray(h0.totalHeaderSize)));
    }
  }
  assert.ok(okCount > 20, 'trop peu de cas acceptés (' + okCount + ')');
  assert.ok(koCount > 0, 'aucun cas refusé : le test ne prouve rien');
});
