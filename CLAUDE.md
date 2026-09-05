# RL Session Tracker

Application Electron française de suivi de sessions Rocket League. Voir
`README.md` pour ce qu'elle fait, `src/main/` pour le processus principal et
`src/renderer/` pour les fenêtres.

Conventions du dépôt : tout en français (code, commentaires, interface), les
commentaires expliquent POURQUOI, aucune dépendance runtime hors
electron-updater, tests avec `node --test` (`npm test`).

<!-- antislop:start -->
## antislop

Pour tout travail d'interface, de copie, d'accessibilité, de mise en page
mobile ou de commentaires de code, charger le filtre antislop puis la
compétence correspondante. Elles sont fournies par le greffon installé, donc
invoquées par leur nom plutôt que par un chemin — aucun fichier n'a été
recopié dans le dépôt :

- Filtre principal : `antislop:antislop`
- Interface et visuel : `antislop:antislop-ui`
- Copie et texte : `antislop:antislop-copywriting`
- Accessibilité : `antislop:antislop-human`
- Mobile et responsive : `antislop:antislop-layoutmobile`
- Commentaires de code : `antislop:antislop-code`

Avant de commencer, demander quand antislop s'applique : pendant le travail,
ou en audit après coup. Les audits sont écrits dans `anti-slop/`.

Le serveur MCP `antislop-contrast` ne démarre pas sur cette machine : il
cherche `python`, qui n'existe pas ici (seulement `python3`). Mesurer les
contrastes à la main tant que ce n'est pas réglé.
<!-- antislop:end -->
