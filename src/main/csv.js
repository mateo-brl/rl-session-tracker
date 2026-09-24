// csv.js — Export du journal des matchs en CSV.
//
// 2000 matchs ne doivent pas rester enfermés dans un fichier interne : une
// ligne par match, ouvrable dans un tableur (Excel en français compris :
// séparateur « ; », BOM UTF-8).

function toCsv(rows, pseudo) {
  const cell = (v) => {
    const t = v === null || v === undefined ? '' : String(v);
    // Un pseudo peut contenir « ; », un guillemet ou un retour à la ligne.
    return /[";\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };
  // Coéquipiers ou adversaires, du point de vue du joueur suivi.
  // Le joueur suivi est écarté de la colonne « coéquipiers » par son PSEUDO :
  // le reconnaître à ses stats effaçait un coéquipier ayant fini avec les
  // mêmes points et buts — cas courant en 2v2.
  const me = String(pseudo || '').trim().toLowerCase();
  const names = (m, mine) => (Array.isArray(m.players) && m.myTeam !== null
    ? m.players.filter((p) => (p.team === m.myTeam) === mine
        && !(mine && String(p.name || '').trim().toLowerCase() === me))
      .map((p) => p.name).join(', ')
    : '');
  const head = ['date', 'mode', 'classe', 'resultat', 'score', 'prolongation',
    'forfait', 'buts', 'passes', 'arrets', 'tirs', 'points', 'mvp',
    'coequipiers', 'adversaires'];
  const lines = [head.join(';')];
  for (const m of rows) {
    lines.push([
      new Date(m.endedAt).toISOString(),
      m.mode,
      m.ranked ? 'classe' : 'casual',
      m.result || '',
      Array.isArray(m.score) ? m.score.join('-') : '',
      m.isOT ? 'oui' : 'non',
      m.forfeit ? 'oui' : 'non',
      m.me ? m.me.goals : '', m.me ? m.me.assists : '',
      m.me ? m.me.saves : '', m.me ? m.me.shots : '',
      m.me ? m.me.score : '', m.me && m.me.mvp ? 'oui' : 'non',
      // C'est ici qu'un pseudo peut contenir « ; » ou un guillemet : la
      // fonction `cell` ci-dessus existe pour ces deux colonnes.
      names(m, true), names(m, false),
    ].map(cell).join(';'));
  }
  // BOM UTF-8 : sans lui, Excel lit le CSV en ANSI et massacre les accents.
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

module.exports = { toCsv };
