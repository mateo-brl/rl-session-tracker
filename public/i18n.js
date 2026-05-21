// i18n.js — bilingual strings table for the dashboard.
// Exposes window.t(key) and window.setLang(lang).

(function () {
  const DICT = {
    fr: {
      'brand.tag':           'TRACKER \u00b7 RL',
      'brand.session':       'Session',
      'brand.live':          'En direct',
      'brand.rec':           'REC',

      'status.in-match':     'En match',
      'status.in-lobby':     'En lobby',
      'status.menu':         'Au menu',
      'status.online':       'En ligne',
      'status.offline':      'Hors ligne',

      'tab.A':               'Command',
      'tab.B':               'Sidekick',
      'tab.C':               'Focus',

      'player.toNext':       'pour le rang suivant',

      'ribbon.sessionTime':  'Temps de session',
      'ribbon.wlMeta':       'session',
      'ribbon.wr':           '% victoires',
      'ribbon.streak':       's\u00e9rie \u00b7 10 derniers',
      'ribbon.mmrSession':   'MMR \u00b7 session',
      'ribbon.objective':    'Objectif',
      'ribbon.objectiveVal': '{cur} / +{target} MMR',
      'ribbon.time':         'Temps',

      'mmr.eyebrow':         'MMR',
      'mmr.session':         'Session',
      'mmr.season':          'Saison',

      'picker.label':        'Choisir le MMR affiché',
      'picker.auto':         'Auto · mode le + joué',

      'tilt.eyebrow':        'Tiltom\u00e8tre',
      'tilt.chill':          'D\u00e9tendu',
      'tilt.edge':           'Sur les nerfs',
      'tilt.tilt':           'Tilt\u00e9',
      'tilt.meta':           '6 derniers matchs',

      'matches.eyebrow':     'Historique',
      'matches.recent':      'Derniers matchs',
      'matches.short':       'R\u00e9cents',
      'matches.of':          '{shown} sur {total}',
      'matches.g':           'B',
      'matches.s':           'A',
      'matches.a':           'PD',
      'matches.sh':          'TIRS',
      'matches.waiting':     'En attente d\'un nouveau match',
      'matches.waitingHint': 'Joue un match — il apparaîtra ici dès que tracker.gg l\'aura enregistré',

      'fresh.checked':       'Vérifié il y a {ago}',
      'fresh.note':          'tracker.gg peut avoir quelques minutes de retard',

      'stats.eyebrow':       'Performance',
      'stats.title':         'Toi vs moy. saison',
      'stats.short':         'vs moyenne',
      'stats.goals':         'Buts',
      'stats.saves':         'Arr\u00eats',
      'stats.assists':       'Passes d\u00e9c.',
      'stats.shots':         'Tirs',
      'stats.avg':           'moy',

      'modes.eyebrow':       'Par mode',
      'modes.title':         'R\u00e9partition session',

      'opps.eyebrow':        'Adversaires',
      'opps.title':          '2 derniers lobbies',

      'toast.victory':       'Victoire',
      'toast.defeat':        'D\u00e9faite',
      'toast.tiltAlert':     'Alerte tilt',
      'toast.tiltDetail':    '3 d\u00e9faites d\'affil\u00e9e \u2014 pause ?',

      'focus.unit':          'MMR cette\\nsession',
      'focus.start':         'D\u00e9but',
      'focus.peak':          'Plafond',
      'focus.time':          'Temps',

      'ticker.peak':         'PIC SAISON',
      'ticker.winrate':      'WR RÉCENT',
      'ticker.played':       'MATCHS JOU\u00c9S',
      'ticker.startMmr':     'D\u00c9BUT DE SESSION',
      'ticker.currentMmr':   'MMR EN COURS',
      'ticker.peakSession':  'PIC SESSION',

      'search.title':        'Tracker ta session',
      'search.subtitle':     'Entre ton pseudo pour commencer le tracking en direct',
      'search.username':     'Pseudo',
      'search.platform':     'Plateforme',
      'search.suggestSearching': 'Recherche en cours…',
      'search.go':           'Lancer le tracking',
      'search.searching':    'Recherche en cours\u2026',
      'search.hint':         'Le pseudo doit correspondre \u00e0 ton compte Epic Games, Steam, PSN ou Xbox',
      'search.notFound':     'Joueur introuvable. V\u00e9rifie le pseudo saisi et la plateforme s\u00e9lectionn\u00e9e.',
      'search.unavailable':  'tracker.network est momentan\u00e9ment injoignable. R\u00e9essaie dans quelques secondes.',
      'search.network':      'Impossible de joindre le serveur. V\u00e9rifie ta connexion internet.',
      'search.error':        'Une erreur inattendue est survenue. R\u00e9essaie.',

      'source.live':         'Agent connect\u00e9 \u00b7 live',
      'source.deferred':     'via tracker.gg \u00b7 diff\u00e9r\u00e9',
    },
    en: {
      'brand.tag':           'TRACKER \u00b7 RL',
      'brand.session':       'Session',
      'brand.live':          'Live',
      'brand.rec':           'REC',

      'status.in-match':     'In match',
      'status.in-lobby':     'In lobby',
      'status.menu':         'In menu',
      'status.online':       'Online',
      'status.offline':      'Offline',

      'tab.A':               'Command',
      'tab.B':               'Sidekick',
      'tab.C':               'Focus',

      'player.toNext':       'to next rank',

      'ribbon.sessionTime':  'Session time',
      'ribbon.wlMeta':       'session',
      'ribbon.wr':           '% WR',
      'ribbon.streak':       'streak \u00b7 last 10',
      'ribbon.mmrSession':   'MMR \u00b7 session',
      'ribbon.objective':    'Objective',
      'ribbon.objectiveVal': '{cur} / +{target} MMR',
      'ribbon.time':         'Time',

      'mmr.eyebrow':         'MMR',
      'mmr.session':         'Session',
      'mmr.season':          'Season',

      'picker.label':        'Choose the displayed MMR',
      'picker.auto':         'Auto · most played',

      'tilt.eyebrow':        'Tilt meter',
      'tilt.chill':          'Chill',
      'tilt.edge':           'On edge',
      'tilt.tilt':           'Tilted',
      'tilt.meta':           'last 6 games',

      'matches.eyebrow':     'History',
      'matches.recent':      'Recent matches',
      'matches.short':       'Recent',
      'matches.of':          '{shown} of {total}',
      'matches.g':           'G',
      'matches.s':           'S',
      'matches.a':           'A',
      'matches.sh':          'SH',
      'matches.waiting':     'Waiting for a new match',
      'matches.waitingHint': 'Play a match — it shows up here once tracker.gg has logged it',

      'fresh.checked':       'Checked {ago} ago',
      'fresh.note':          'tracker.gg data can be a few minutes behind',

      'stats.eyebrow':       'Performance',
      'stats.title':         'You vs season avg',
      'stats.short':         'vs season avg',
      'stats.goals':         'Goals',
      'stats.saves':         'Saves',
      'stats.assists':       'Assists',
      'stats.shots':         'Shots',
      'stats.avg':           'avg',

      'modes.eyebrow':       'By mode',
      'modes.title':         'Session breakdown',

      'opps.eyebrow':        'Opponents',
      'opps.title':          'Last 2 lobbies',

      'toast.victory':       'Victory',
      'toast.defeat':        'Defeat',
      'toast.tiltAlert':     'Tilt alert',
      'toast.tiltDetail':    '3 losses in a row \u2014 take a break?',

      'focus.unit':          'MMR this\\nsession',
      'focus.start':         'Start',
      'focus.peak':          'Peak',
      'focus.time':          'Time',

      'ticker.peak':         'SEASON PEAK',
      'ticker.winrate':      'RECENT WR',
      'ticker.played':       'GAMES PLAYED',
      'ticker.startMmr':     'SESSION START',
      'ticker.currentMmr':   'CURRENT MMR',
      'ticker.peakSession':  'SESSION PEAK',

      'search.title':        'Track your session',
      'search.subtitle':     'Enter your username to start live tracking',
      'search.username':     'Username',
      'search.platform':     'Platform',
      'search.suggestSearching': 'Searching…',
      'search.go':           'Start tracking',
      'search.searching':    'Searching\u2026',
      'search.hint':         'Username must match your Epic Games, Steam, PSN or Xbox account',
      'search.notFound':     'Player not found. Double-check the username spelling and the selected platform.',
      'search.unavailable':  'tracker.network is temporarily unreachable. Try again in a few seconds.',
      'search.network':      'Could not reach the server. Check your internet connection.',
      'search.error':        'An unexpected error occurred. Please try again.',

      'source.live':         'Agent connected · live',
      'source.deferred':     'via tracker.gg · deferred',
    },
  };

  let lang = 'fr';
  const listeners = new Set();

  function t(key, vars) {
    let s = (DICT[lang] && DICT[lang][key]) || (DICT.en[key] || key);
    if (vars) {
      Object.keys(vars).forEach(k => { s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), vars[k]); });
    }
    return s;
  }

  function setLang(l) {
    if (!DICT[l]) return;
    lang = l;
    listeners.forEach(fn => { try { fn(l); } catch(e){} });
  }

  function getLang() { return lang; }

  function onLangChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  window.t = t;
  window.setLang = setLang;
  window.getLang = getLang;
  window.onLangChange = onLangChange;
})();
