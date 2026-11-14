// skins.js : le catalogue des habillages, lu par toutes les fenêtres et par
// la validation de la configuration (src/main/config.js).
//
// Un habillage, c'est une forme (skins.css, bloc du même identifiant) et une
// palette de départ : victoire, défaite, fond, MVP. Le texte, les panneaux et
// les filets se déduisent du fond dans applyTheme(), l'utilisateur peut donc
// retoucher ces quatre couleurs sans casser l'habillage.
//
// `fam` sert aux filtres de la vitrine. Sombre ou clair n'y figure pas : la
// vitrine le calcule à partir de la couleur de fond.
(function (root) {
  'use strict';

  var SKINS = [
    { id: 'arena', name: 'Arène', nameEn: 'Arena', fam: ['stade', 'vif'],
      t: { win: '#4dabff', loss: '#e0741a', bg: '#0c0e11', gold: '#ffc233' },
      desc: { fr: 'L’origine. Plaques biseautées, cartouches inclinés, halos d’équipe.',
        en: 'The original. Chamfered plates, slanted title plates, team halos.' } },

    { id: 'afficheur', name: 'Afficheur', nameEn: 'Scoreboard', fam: ['stade', 'retro'],
      t: { win: '#ffb000', loss: '#ff5a4a', bg: '#0a0a08', gold: '#ffe9a8' },
      desc: { fr: 'Tableau lumineux de stade. Chiffres en matrice de points, ambre sur noir.',
        en: 'Stadium LED board. Dot-matrix digits, amber on black.' } },
    { id: 'vestiaire', name: 'Vestiaire', nameEn: 'Locker room', fam: ['stade', 'sobre'],
      t: { win: '#1554c0', loss: '#c2410c', bg: '#e9edf0', gold: '#0f1b2d' },
      desc: { fr: 'Tableau blanc tactique. Fond clair, titres soulignés au feutre, aimants ronds.',
        en: 'Tactics whiteboard. Light ground, marker underlines, round magnets.' } },
    { id: 'pelouse', name: 'Pelouse', nameEn: 'Pitch', fam: ['stade'],
      t: { win: '#f1f5ee', loss: '#ffa25c', bg: '#123222', gold: '#ffd166' },
      desc: { fr: 'Terrain tondu. Lignes à la chaux, score dans le rond central.',
        en: 'Mown pitch. Chalk lines, the score sits in the centre circle.' } },
    { id: 'boost', name: 'Boost', nameEn: 'Boost', fam: ['vif'],
      t: { win: '#ffb21a', loss: '#9fb0c8', bg: '#15120e', gold: '#fbf3e4' },
      desc: { fr: 'Tout en rondeurs. Jauge épaisse, scores dans deux pastilles.',
        en: 'All curves. Thick gauge, scores in two round pads.' } },
    { id: 'ardoise', name: 'Ardoise', nameEn: 'Slate', fam: ['sobre'],
      t: { win: '#9bd4ff', loss: '#f4a987', bg: '#2b3037', gold: '#f2e6a7' },
      desc: { fr: 'Gris ardoise, aucun cadre. De grands chiffres fins et des filets.',
        en: 'Slate grey, no frames. Large thin digits and hairlines.' } },

    { id: 'maillot', name: 'Maillot', nameEn: 'Jersey', fam: ['stade', 'vif'],
      t: { win: '#f2c230', loss: '#ff6b7d', bg: '#101a33', gold: '#ffffff' },
      desc: { fr: 'Numéros de maillot cernés de blanc, liseré de col en tête de carte.',
        en: 'Jersey numbers with a white trim, a collar stripe on each card.' } },
    { id: 'tifo', name: 'Tifo', nameEn: 'Tifo', fam: ['stade', 'vif'],
      t: { win: '#ffffff', loss: '#ffc94a', bg: '#9e1024', gold: '#ffd23f' },
      desc: { fr: 'Banderole de tribune. Tout un fond de couleur, lettres d’affiche.',
        en: 'A supporters’ banner. A full field of colour, poster lettering.' } },
    { id: 'trophee', name: 'Trophée', nameEn: 'Trophy', fam: ['stade', 'sobre'],
      t: { win: '#e8c66a', loss: '#b9b2a3', bg: '#0f0d0a', gold: '#fff1c2' },
      desc: { fr: 'Plaque gravée. Chiffres à empattements, double filet doré.',
        en: 'An engraved plaque. Serif digits, a double gold rule.' } },
    { id: 'nocturne', name: 'Nocturne', nameEn: 'Night match', fam: ['stade', 'sobre'],
      t: { win: '#7cc4ff', loss: '#ffb36b', bg: '#070d1c', gold: '#fff2b3' },
      desc: { fr: 'Match de nuit. Deux projecteurs en haut de l’écran, coins doux.',
        en: 'A night match. Two floodlights at the top, soft corners.' } },

    { id: 'teletexte', name: 'Télétexte', nameEn: 'Teletext', fam: ['retro', 'vif'],
      t: { win: '#3ee6ff', loss: '#ff7ad9', bg: '#000000', gold: '#ffee33' },
      desc: { fr: 'La page des résultats sportifs. Bandeaux de couleur pleine, lettres à gros pixels.',
        en: 'The sports results page. Solid colour bars, chunky pixel type.' } },
    { id: 'borne', name: 'Borne', nameEn: 'Arcade cabinet', fam: ['retro', 'vif'],
      t: { win: '#ffd23f', loss: '#ff4d6d', bg: '#130f1f', gold: '#7df9ff' },
      desc: { fr: 'Table des scores d’une borne d’arcade. Chiffres en pixels, cadres épais.',
        en: 'An arcade high-score table. Pixel digits, thick frames.' } },
    { id: 'magneto', name: 'Magnéto', nameEn: 'VCR', fam: ['retro'],
      t: { win: '#ffffff', loss: '#ffd84a', bg: '#1220c4', gold: '#7dfff0' },
      desc: { fr: 'L’écran bleu du magnétoscope, pour revoir ses matchs. Texte incrusté, aucun cadre.',
        en: 'The blue VCR screen, for the replay. On-screen text, no frames.' } },

    { id: 'garage', name: 'Garage', nameEn: 'Garage', fam: ['vif'],
      t: { win: '#ffc400', loss: '#ff7847', bg: '#24272b', gold: '#e8eaed' },
      desc: { fr: 'L’atelier. Lettres au pochoir, bande de sécurité jaune et noire.',
        en: 'The workshop. Stencil lettering, a yellow and black hazard stripe.' } },
    { id: 'compteur', name: 'Compteur', nameEn: 'Gauge', fam: ['sobre'],
      t: { win: '#f2f4f7', loss: '#ff453a', bg: '#0b0c0e', gold: '#ffb300' },
      desc: { fr: 'Tableau de bord. Cadran gradué, la défaite dans la zone rouge.',
        en: 'A car dashboard. A graduated dial, defeat in the red zone.' } },
    { id: 'aquadome', name: 'Aquadôme', nameEn: 'Aquadome', fam: ['vif'],
      t: { win: '#7cf0d6', loss: '#ff9d7a', bg: '#062a33', gold: '#ffe08a' },
      desc: { fr: 'Sous l’eau. Fond qui s’assombrit vers le bas, bulles pour les résultats.',
        en: 'Underwater. The ground darkens with depth, bubbles for results.' } },

    { id: 'gazette', name: 'Gazette', nameEn: 'Gazette', fam: ['sobre'],
      t: { win: '#14213d', loss: '#b3121f', bg: '#e9e7e2', gold: '#14213d' },
      desc: { fr: 'Le journal du lendemain. Titres à empattements, filets doubles, aucun cadre.',
        en: 'Tomorrow’s paper. Serif headlines, double rules, no frames.' } },
    { id: 'carnet', name: 'Carnet', nameEn: 'Notebook', fam: ['vif'],
      t: { win: '#1c3faa', loss: '#d12c2c', bg: '#f4f6fb', gold: '#1c8a4a' },
      desc: { fr: 'Feuille de match à petits carreaux. Chiffres à la main, bâtons pour compter.',
        en: 'A squared match sheet. Handwritten digits, tally marks.' } },
    { id: 'vignette', name: 'Vignette', nameEn: 'Sticker', fam: ['vif'],
      t: { win: '#1447d4', loss: '#d81e3a', bg: '#f7c531', gold: '#111111' },
      desc: { fr: 'Album d’autocollants. Cartes blanches à gros contour sur fond jaune.',
        en: 'A sticker album. White cards with a heavy outline on yellow.' } },
    { id: 'givre', name: 'Givre', nameEn: 'Frost', fam: ['sobre'],
      t: { win: '#2563c9', loss: '#c2572b', bg: '#f3f5f7', gold: '#6b5a1e' },
      desc: { fr: 'Clair et calme. Cartes à peine posées, chiffres fins.',
        en: 'Light and quiet. Barely-there cards, thin digits.' } },
    { id: 'encre', name: 'Encre', nameEn: 'Ink', fam: ['sobre', 'retro'],
      t: { win: '#111111', loss: '#767676', bg: '#ffffff', gold: '#111111' },
      desc: { fr: 'Noir sur blanc. Ton score en plein, celui d’en face en contour.',
        en: 'Black on white. Your score filled, theirs in outline.' } },
  ];

  // Habillages retirés : une installation qui en portait un passe à celui qui
  // l'a remplacé, plutôt que de retomber sur Arène sans prévenir.
  var LEGACY = { console: 'afficheur', papier: 'vestiaire', neon: 'pelouse',
    brut: 'boost', calme: 'ardoise' };

  var api = { list: SKINS, legacy: LEGACY, ids: SKINS.map(function (s) { return s.id; }) };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RL_SKINS = api;
})(typeof window !== 'undefined' ? window : this);
