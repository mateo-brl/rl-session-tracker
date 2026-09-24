// mmr-guard.js — Une lecture de MMR dans le journal est-elle crédible ?
//
// Chaque lecture de Launch.log devient une ANCRE : elle recale la courbe,
// sert à apprendre le gain moyen par match, et à corriger un forfait mal
// compté. Une lecture fausse faisait donc trois dégâts d'un coup, dont
// l'inversion à tort du résultat d'un match. Or une lecture peut être
// fausse : la ligne lue est le MMR du CHEF DE GROUPE (« PartyLeaderMMR »),
// en groupe ce n'est peut-être pas le tien.
//
// Le principe : tes matchs enregistrés depuis la dernière ancre disent à peu
// près où ton MMR doit être. Une lecture trop loin de ça est mise de côté,
// pas jetée : si la lecture suivante la confirme (elle est cohérente avec
// elle, compte tenu des matchs joués entre les deux), c'était un vrai saut
// et on l'accepte. Si la suivante retombe sur la trajectoire habituelle,
// c'était elle l'intruse.
//
// Module pur : aucune lecture de fichier, tout arrive en paramètres.

// Au-delà de 30 minutes sans aucun match enregistré, un saut s'explique très
// bien (parties sur un autre PC, une console, ou l'application fermée) : on
// l'accepte tel quel. En deçà, rien ne peut l'expliquer.
const IDLE_MS = 30 * 60 * 1000;

// Écart toléré entre la lecture et ce que les matchs enregistrés prévoient.
//  • 3 gains moyens de base : la correction d'un forfait repose justement
//    sur un écart de DEUX gains, il ne faut pas le bloquer ;
//  • +4 par match décidé : les vrais gains varient d'un match à l'autre
//    (environ 6 à 12), l'erreur s'accumule avec le nombre de matchs ;
//  • +1,5 gain par match sans verdict : il a bougé le MMR sans qu'on sache
//    dans quel sens.
function tolerance(step, decided) {
  const s = Number(step) > 0 ? Number(step) : 9;
  const d = decided || {};
  const games = (d.wins || 0) + (d.losses || 0);
  return Math.max(25, 3 * s) + 4 * games + 1.5 * s * (d.unmatched || 0);
}

function expectedFrom(anchorValue, step, decided) {
  return anchorValue + ((decided && decided.net) || 0) * step;
}

// Rend { action, expected, tolerance, reason } :
//  • 'accept'         : lecture crédible, à ancrer normalement ;
//  • 'accept-pending' : la lecture confirme celle mise de côté, qui était un
//                       vrai saut : ancrer d'abord celle-là, puis celle-ci ;
//  • 'hold'           : lecture mise de côté en attendant confirmation.
// Paramètres :
//   prev            : dernière ancre du mode { t, v } (ou null)
//   reading         : { mode, mmr }
//   now             : horodatage de la lecture
//   step            : gain moyen par match du mode
//   decided         : bilan des matchs depuis `prev` { wins, losses, unmatched, net }
//   pending         : lecture mise de côté pour ce mode { mmr, at } (ou null)
//   decidedPending  : bilan des matchs depuis `pending.at`
function judge(o) {
  const prev = o.prev;
  const r = o.reading;
  if (!prev || !Number.isFinite(prev.v)) {
    return { action: 'accept', reason: 'première lecture de ce mode' };
  }
  const step = Number(o.step) > 0 ? Number(o.step) : 9;
  const decided = o.decided || { wins: 0, losses: 0, unmatched: 0, net: 0 };
  const expected = expectedFrom(prev.v, step, decided);
  const tol = tolerance(step, decided);
  const fits = Math.abs(r.mmr - expected) <= tol;

  if (o.pending && Number.isFinite(o.pending.mmr)) {
    if (fits) {
      return { action: 'accept', expected, tolerance: tol,
        reason: 'retour sur la trajectoire : la lecture mise de côté était l’intruse' };
    }
    const dp = o.decidedPending || { wins: 0, losses: 0, unmatched: 0, net: 0 };
    const expP = expectedFrom(o.pending.mmr, step, dp);
    const tolP = tolerance(step, dp);
    if (Math.abs(r.mmr - expP) <= tolP) {
      return { action: 'accept-pending', expected: expP, tolerance: tolP,
        reason: 'confirme la lecture mise de côté : vrai saut' };
    }
    return { action: 'hold', expected, tolerance: tol,
      reason: 'ni sur la trajectoire, ni cohérente avec la lecture mise de côté' };
  }

  if (fits) return { action: 'accept', expected, tolerance: tol, reason: 'cohérente avec les matchs' };

  const games = (decided.wins || 0) + (decided.losses || 0) + (decided.unmatched || 0);
  if (!games && Number.isFinite(prev.t) && o.now - prev.t >= IDLE_MS) {
    return { action: 'accept', expected, tolerance: tol,
      reason: 'aucun match enregistré depuis longtemps : parties jouées ailleurs' };
  }
  return { action: 'hold', expected, tolerance: tol, reason: 'trop loin de ce que tes matchs prévoient' };
}

module.exports = { judge, tolerance, IDLE_MS };
