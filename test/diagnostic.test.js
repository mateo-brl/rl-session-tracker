// Tests du rapport de diagnostic (src/main/diagnostic.js).
//
// Le module est branché sur des dépendances passées en paramètres : ces tests
// tournent donc sans Electron, sans Windows et sans Rocket League installé —
// ce qui est tout l'intérêt, puisque le rapport doit rester juste sur les deux
// machines de test (Steam et Epic) sans qu'on puisse les reproduire ici.
//   node --test
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const diagnostic = require('../src/main/diagnostic.js');

const NOW = Date.UTC(2026, 8, 3, 20, 0, 0);   // horloge figée : rapport reproductible
const MIN = 60 * 1000;

// Une installation Rocket League crédible sur disque : le diagnostic teste des
// droits d'écriture RÉELS, il lui faut donc de vrais dossiers.
function fakeInstall(opts) {
  const o = opts || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlst-diag-'));
  const install = path.join(root, o.name || 'steamapps', 'common', 'rocketleague');
  if (o.config !== false) {
    fs.mkdirSync(path.join(install, 'TAGame', 'Config'), { recursive: true });
    if (o.ini !== false) {
      fs.writeFileSync(path.join(install, 'TAGame', 'Config', 'DefaultStatsAPI.ini'),
        '[TAGame.MatchStatsExporter_TA]\r\nPort=49123\r\nPacketSendRate='
        + (o.rate === undefined ? 60 : o.rate) + '\r\n');
    }
  } else {
    fs.mkdirSync(install, { recursive: true });
  }
  return install;
}

function fakeLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rlst-diag-log-'));
  const file = path.join(dir, 'Launch.log');
  fs.writeFileSync(file, 'Log: Matchmaking: StartMatchmaking for playlists 11\n');
  return file;
}

// Cas nominal : tout est en place, rien n'est cassé.
function healthyDeps(extra) {
  const install = fakeInstall();
  return Object.assign({
    now: () => NOW,
    config: {
      pseudo: 'Mateo', statsApiPort: 49123,
      mmr: { '2v2': { base: 1234, setAt: NOW - 10 * MIN, fromLog: true } },
      mmrStep: { '2v2': 8.4 },
      obs: { enabled: true, port: 49350, canvas: { w: 1920, h: 1080 } },
    },
    game: { processRunning: true, statsConnected: true },
    lastPacketAt: NOW - 2000,
    detectInstalls: () => [install],
    iniConfigured: () => true,
    iniRate: () => 60,
    logFile: fakeLog(),
    readQueue: () => ({ playlist: 11, ranked: true, mode: '2v2', known: true, at: NOW - 5 * MIN }),
    readMmr: () => ({ mode: '2v2', mmr: 1234, tier: 18 }),
    history: [
      { id: 'a', endedAt: NOW - 20 * MIN, mode: '2v2', result: 'W', me: { goals: 2 } },
      { id: 'b', endedAt: NOW - 10 * MIN, mode: '2v2', result: 'L', me: { goals: 0 } },
    ],
    playersSeen: ['Mateo', 'Kévin'],
    obs: { running: true, port: 49350, error: null },
    cosmetics: { swaps: [{ id: 's1', status: 'applied' }], gameRunning: false },
  }, extra || {});
}

function byId(report, id) {
  return report.checks.find((c) => c.id === id);
}

test('cas nominal : rapport complet, aucun échec', () => {
  const r = diagnostic.run(healthyDeps());
  assert.equal(r.at, NOW);
  assert.equal(r.ok, true);
  assert.ok(r.checks.length >= 12, 'le rapport doit couvrir tous les mécanismes');
  // Chaque contrôle est exploitable tel quel par la fenêtre : identifiant,
  // libellé, état connu et détail factuel.
  for (const c of r.checks) {
    assert.ok(c.id && c.label, 'contrôle sans identité : ' + JSON.stringify(c));
    assert.ok(['ok', 'warn', 'fail', 'skip'].includes(c.state), 'état inconnu : ' + c.state);
    assert.equal(typeof c.detail, 'string');
    assert.ok(c.detail.length > 0, 'contrôle sans détail : ' + c.id);
  }
  assert.equal(byId(r, 'installs').state, 'ok');
  assert.equal(byId(r, 'install-0-write').state, 'ok');
  assert.equal(byId(r, 'statsapi-link').state, 'ok');
  assert.equal(byId(r, 'pseudo').state, 'ok');
  assert.equal(byId(r, 'undecided').state, 'ok');
  assert.equal(byId(r, 'obs').state, 'ok');
  // Le détail porte la VALEUR trouvée : c'est ce qu'on relit après coup pour
  // comprendre ce qui s'est passé chez l'ami.
  assert.match(byId(r, 'install-0-rate').detail, /60 paquets\/s/);
  assert.match(byId(r, 'mmr-2v2').detail, /1234/);
  assert.match(byId(r, 'mmr-2v2').detail, /pas appris 8\.4/);
});

test('aucune installation détectée : échec et conseil', () => {
  const r = diagnostic.run(healthyDeps({ detectInstalls: () => [] }));
  const c = byId(r, 'installs');
  assert.equal(c.state, 'fail');
  assert.equal(r.ok, false);
  assert.ok(c.hint, 'un échec sans conseil ne sert à rien');
  // Sans installation, aucune ligne par installation n'est produite.
  assert.equal(r.checks.some((x) => x.id.startsWith('install-')), false);
});

test('installation sans DefaultStatsAPI.ini : signalée, débit à zéro', () => {
  const install = fakeInstall({ ini: false });
  const r = diagnostic.run(healthyDeps({
    detectInstalls: () => [install],
    iniConfigured: () => false,
    iniRate: () => 0,
  }));
  assert.equal(byId(r, 'install-0-config').state, 'ok');   // le dossier existe
  const ini = byId(r, 'install-0-ini');
  assert.equal(ini.state, 'fail');
  assert.match(ini.detail, /absent/);
  assert.match(ini.hint, /Réactiver la Stats API/);
  assert.equal(byId(r, 'install-0-rate').state, 'fail');
  assert.equal(r.ok, false);
});

test('dossier TAGame\\Config manquant : installation incomplète', () => {
  const install = fakeInstall({ config: false });
  const r = diagnostic.run(healthyDeps({ detectInstalls: () => [install] }));
  assert.equal(byId(r, 'install-0-config').state, 'fail');
  // Le test d'écriture ne peut pas réussir dans un dossier qui n'existe pas :
  // c'est bien un échec, pas une exception.
  assert.equal(byId(r, 'install-0-write').state, 'fail');
});

test('droits d’écriture : un dossier en lecture seule est repéré', () => {
  const install = fakeInstall();
  const r = diagnostic.run(healthyDeps({
    detectInstalls: () => [install],
    // On simule le refus plutôt que de jouer avec les droits du système de
    // fichiers : chmod est sans effet quand les tests tournent en root (CI).
    fs: Object.assign(Object.create(fs), {
      writeFileSync: (p) => {
        const e = new Error('permission denied');
        e.code = 'EACCES';
        throw e;
      },
    }),
  }));
  const c = byId(r, 'install-0-write');
  assert.equal(c.state, 'fail');
  assert.match(c.detail, /EACCES/);
  assert.match(c.hint, /élévation/);
});

test('journal du jeu absent : le MMR et la réconciliation sont hors service', () => {
  const r = diagnostic.run(healthyDeps({
    logFile: path.join(os.tmpdir(), 'rlst-journal-qui-nexiste-pas', 'Launch.log'),
    readQueue: () => null,
    readMmr: () => null,
  }));
  const c = byId(r, 'log-file');
  assert.equal(c.state, 'fail');
  assert.match(c.detail, /introuvable/);
  assert.match(c.hint, /forfait/);
  // Sans journal, ni file ni MMR : signalés, mais en avertissement — le cas
  // « pas chef de groupe » est légitime et ne doit pas passer le rapport au rouge.
  assert.equal(byId(r, 'log-queue').state, 'warn');
  assert.equal(byId(r, 'log-mmr').state, 'warn');
});

test('journal trouvé : taille et âge de la dernière écriture', () => {
  const file = fakeLog();
  const r = diagnostic.run(healthyDeps({ logFile: file, now: () => Date.now() }));
  const c = byId(r, 'log-file');
  assert.equal(c.state, 'ok');
  assert.match(c.detail, / o,|Ko,|Mo,/);      // la taille est bien relevée
  // « écrit il y a à l’instant » ne se dit pas : le tout juste écoulé a sa
  // propre tournure, et le journal d'un jeu qui tourne est toujours dans ce cas.
  assert.match(c.detail, /écrit (à l’instant|il y a )/);
});

test('pseudo qui ne correspond à personne : échec et candidats proposés', () => {
  const r = diagnostic.run(healthyDeps({
    config: { pseudo: 'Fantôme', statsApiPort: 49123 },
    history: [
      { id: 'a', endedAt: NOW - MIN, result: null, me: null,
        players: [{ name: 'Mateo' }, { name: 'Kévin' }] },
    ],
    playersSeen: ['Mateo', 'Kévin'],
  }));
  const c = byId(r, 'pseudo');
  assert.equal(c.state, 'fail');
  assert.match(c.detail, /Fantôme/);
  assert.match(c.hint, /Mateo/);              // on dit par quoi le remplacer
  assert.equal(r.ok, false);
});

test('pseudo absent, et pseudo reconnu sur les données brutes', () => {
  const vide = diagnostic.run(healthyDeps({ config: { pseudo: '' } }));
  assert.equal(byId(vide, 'pseudo').state, 'fail');
  assert.match(byId(vide, 'pseudo').hint, /Mateo/);

  // Historique brut (`players`) au lieu de l'historique évalué (`me`) : les
  // deux formes doivent être reconnues, sinon le contrôle accuse un pseudo juste.
  const brut = diagnostic.run(healthyDeps({
    config: { pseudo: 'Mateo', statsApiPort: 49123 },
    history: [{ id: 'a', endedAt: NOW - MIN, result: 'W',
      players: [{ name: 'Mateo' }, { name: 'Kévin' }] }],
  }));
  assert.equal(byId(brut, 'pseudo').state, 'ok');
});

test('matchs indécidables : comptés, datés, et signalés comme forfaits', () => {
  const un = diagnostic.run(healthyDeps({
    history: [
      { id: 'a', endedAt: NOW - 30 * MIN, result: null, me: { goals: 1 } },
      { id: 'b', endedAt: NOW - 10 * MIN, result: 'W', me: { goals: 2 } },
    ],
  }));
  const c = byId(un, 'undecided');
  assert.equal(c.state, 'warn');
  assert.match(c.detail, /1 sur 2/);
  assert.match(c.detail, /30 min/);           // depuis quand
  assert.match(c.hint, /forfait/);
  assert.equal(un.ok, true);                  // un avertissement ne fait pas échouer

  // Trois indécidables d'affilée, ce n'est plus un accident : le mécanisme de
  // réconciliation ne fait pas son travail.
  const trois = diagnostic.run(healthyDeps({
    history: [1, 2, 3].map((n) => ({ id: 'x' + n, endedAt: NOW - n * MIN,
      result: null, me: { goals: 0 } })),
  }));
  assert.equal(byId(trois, 'undecided').state, 'fail');

  // Un match où le pseudo n'a PAS été trouvé relève du pseudo, pas du forfait :
  // le compter ici enverrait chercher un problème qui n'existe pas.
  const sansMoi = diagnostic.run(healthyDeps({
    history: [{ id: 'a', endedAt: NOW - MIN, result: null, me: null }],
  }));
  assert.equal(byId(sansMoi, 'undecided').state, 'ok');
});

test('aucune exception ne remonte quand les dépendances échouent', () => {
  const boom = () => { throw new Error('dépendance cassée'); };
  let r;
  assert.doesNotThrow(() => {
    r = diagnostic.run({
      now: () => NOW,
      config: { pseudo: 'Mateo', statsApiPort: 49123, obs: { enabled: true, port: 49350 } },
      detectInstalls: boom,
      iniConfigured: boom,
      iniRate: boom,
      readQueue: boom,
      readMmr: boom,
      logFile: '/inexistant/Launch.log',
      history: [{ id: 'a', endedAt: NOW, result: 'W', me: {} }],
      obs: { running: false, port: 49350, error: 'EADDRINUSE' },
      cosmetics: null,
    });
  });
  assert.ok(r && Array.isArray(r.checks) && r.checks.length, 'un rapport est rendu quand même');
  assert.equal(r.ok, false);
  const c = byId(r, 'installs');
  assert.equal(c.state, 'fail');
  assert.match(c.detail, /dépendance cassée/);
  // Les contrôles qui NE dépendent pas de la dépendance cassée restent justes.
  assert.equal(byId(r, 'statsapi-port').state, 'ok');
  assert.equal(byId(r, 'obs').state, 'fail');
  assert.match(byId(r, 'obs').detail, /EADDRINUSE/);
});

test('sans aucune dépendance : rapport complet, tout en « skip »', () => {
  let r;
  assert.doesNotThrow(() => { r = diagnostic.run(); });
  assert.ok(r.checks.length >= 6);
  assert.equal(r.checks.some((c) => c.state === 'fail'), true);   // pseudo absent
  // Aucune information ne doit être inventée : ce qu'on n'a pas pu vérifier est
  // « skip », jamais « ok ».
  assert.equal(byId(r, 'installs').state, 'skip');
  assert.equal(byId(r, 'log-queue').state, 'skip');
  assert.equal(byId(r, 'statsapi-link').state, 'skip');
  assert.equal(byId(r, 'cosmetics').state, 'skip');
  assert.equal(diagnostic.run(null).checks.length, r.checks.length);
});

test('Stats API : jeu ouvert mais rien qui écoute = panne, jeu fermé = indécidable', () => {
  const panne = diagnostic.run(healthyDeps({
    game: { processRunning: true, statsConnected: false },
  }));
  const c = byId(panne, 'statsapi-link');
  assert.equal(c.state, 'fail');
  assert.match(c.hint, /redémarre Rocket League/);

  const ferme = diagnostic.run(healthyDeps({
    game: { processRunning: false, statsConnected: false },
    lastPacketAt: 0,
  }));
  assert.equal(byId(ferme, 'statsapi-link').state, 'skip');
  assert.equal(byId(ferme, 'statsapi-packet').state, 'skip');
  assert.equal(ferme.ok, true);         // jeu fermé : rien n'est cassé

  // Connecté mais muet depuis dix minutes en pleine partie : c'est le symptôme
  // que le flux s'est tari sans que le socket tombe.
  const muet = diagnostic.run(healthyDeps({ lastPacketAt: NOW - 10 * MIN }));
  assert.equal(byId(muet, 'statsapi-packet').state, 'warn');
  assert.match(byId(muet, 'statsapi-packet').detail, /10 min/);
});

test('port personnalisé signalé, calibrage manuel distingué du relevé', () => {
  const r = diagnostic.run(healthyDeps({
    config: {
      pseudo: 'Mateo', statsApiPort: 50000,
      mmr: { '3v3': { base: 900, setAt: NOW - 3 * MIN } },   // saisi à la main
      mmrStep: {},
    },
  }));
  assert.equal(byId(r, 'statsapi-port').state, 'warn');
  assert.match(byId(r, 'statsapi-port').detail, /50000/);
  const m = byId(r, 'mmr-3v3');
  assert.equal(m.state, 'warn');
  assert.match(m.detail, /saisi à la main/);
  assert.match(m.detail, /pas non appris/);
  assert.equal(byId(r, 'mmr').state, 'ok');

  // Aucun mode calibré : la réconciliation d'un forfait n'a aucune base.
  const sans = diagnostic.run(healthyDeps({
    config: { pseudo: 'Mateo', statsApiPort: 49123, mmr: {} },
  }));
  assert.equal(byId(sans, 'mmr').state, 'warn');
  assert.equal(sans.checks.some((c) => c.id.startsWith('mmr-')), false);
});

test('cosmétiques : swap défait signalé, aucun swap = sans objet', () => {
  const defait = diagnostic.run(healthyDeps({
    cosmetics: { swaps: [{ id: 's1', status: 'applied' }, { id: 's2', status: 'reverted' }],
      gameRunning: false },
  }));
  const c = byId(defait, 'cosmetics');
  assert.equal(c.state, 'warn');
  assert.match(c.detail, /2 swap/);
  assert.match(c.hint, /FERMETURE/);

  const manquant = diagnostic.run(healthyDeps({
    cosmetics: { swaps: [{ id: 's1', status: 'missing' }], gameRunning: true },
  }));
  assert.equal(byId(manquant, 'cosmetics').state, 'fail');

  const aucun = diagnostic.run(healthyDeps({ cosmetics: { swaps: [] } }));
  assert.equal(byId(aucun, 'cosmetics').state, 'skip');
});

test('overlay OBS désactivé : sans objet, et non en échec', () => {
  const r = diagnostic.run(healthyDeps({
    config: { pseudo: 'Mateo', statsApiPort: 49123, obs: { enabled: false, port: 49350 } },
    obs: { running: false, port: 0, error: null },
  }));
  assert.equal(byId(r, 'obs').state, 'skip');
  assert.equal(r.ok, true);
});
