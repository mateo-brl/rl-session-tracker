// maps-browser.js — Le site bakkesplugins.com/maps, dans la fenêtre Cartes.
//
// Plutôt que de recopier le catalogue (et de le voir casser au moindre
// changement du site), on affiche le vrai site dans une vue intégrée, et on
// intercepte ses téléchargements : cliquer « Download » sur une fiche fait
// entrer la carte dans la bibliothèque, prête à charger. Le site garde ses
// recherches, ses filtres et ses notes ; l'application ne fait que la partie
// que le site ne peut pas faire, poser la carte dans le jeu.
//
// Garde-fous, puisqu'on affiche une page distante :
//  • session séparée (partition dédiée), sans preload ni Node, bac à sable ;
//  • navigation limitée à bakkesplugins.com : tout autre lien part dans le
//    navigateur de l'utilisateur ;
//  • seuls les .zip, .udk et .upk venant du site ou de son CDN sont acceptés
//    en téléchargement, et le contenu est encore vérifié à l'import (maps.js) ;
//  • toutes les permissions (micro, notifications, géolocalisation…) sont
//    refusées.

const { WebContentsView, session, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const HOME = 'https://bakkesplugins.com/maps';
const PARTITION = 'persist:rlst-maps';
const SITE_HOSTS = new Set(['bakkesplugins.com', 'www.bakkesplugins.com']);
const FILE_HOSTS = new Set(['cdn.bakkesplugins.com', 'bakkesplugins.com', 'www.bakkesplugins.com']);
const FILE_EXT = /\.(zip|udk|upk)$/i;
// Au-delà, ce n'est pas une carte.
const MAX_DOWNLOAD = 1024 * 1024 * 1024;

function parse(url) {
  try { return new URL(url); } catch (e) { return null; }
}
function isSite(url) {
  const u = parse(url);
  return !!(u && u.protocol === 'https:' && SITE_HOSTS.has(u.hostname));
}
function isMapFile(url) {
  const u = parse(url);
  return !!(u && u.protocol === 'https:' && FILE_HOSTS.has(u.hostname) && FILE_EXT.test(u.pathname));
}
function openOutside(url) {
  const u = parse(url);
  if (u && (u.protocol === 'https:' || u.protocol === 'http:')) {
    shell.openExternal(u.toString()).catch(() => {});
  }
}

// Titre, auteur et aperçu de la fiche ouverte au moment du téléchargement.
// Lus dans les balises og:/author de la fiche (celles que lisent Discord et
// les moteurs de recherche, donc les plus stables de la page). Aucune API du
// site n'est documentée : le jour où elles disparaissent, on retombe
// simplement sur le nom du fichier.
const META_SCRIPT = `(() => {
  const meta = (sel) => { const m = document.querySelector(sel); return m ? (m.content || '').trim() : ''; };
  const fiche = /^\\/maps\\/\\d+/.test(location.pathname);
  return {
    page: location.href,
    title: fiche ? meta('meta[property="og:title"]') : '',
    author: fiche ? meta('meta[name="author"]') : '',
    preview: fiche ? meta('meta[property="og:image"]') : '',
  };
})()`;

let wired = false;
let current = null;   // navigateur de la fenêtre ouverte (une seule à la fois)
let seq = 0;

function mapsSession() {
  const ses = session.fromPartition(PARTITION);
  if (wired) return ses;
  wired = true;
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  // Un seul écouteur pour toute la vie de l'application : la session
  // survit à la fenêtre, et le navigateur courant est relu à chaque fois.
  ses.on('will-download', (_e, item, wc) => {
    const b = current;
    const url = item.getURL();
    const name = item.getFilename() || path.basename(parse(url) ? parse(url).pathname : 'carte.zip');
    if (!b || !isMapFile(url) || !FILE_EXT.test(name) || item.getTotalBytes() > MAX_DOWNLOAD) {
      item.cancel();
      if (b) b.onDownload({ id: ++seq, name, state: 'refused' });
      return;
    }
    const id = ++seq;
    fs.mkdirSync(b.downloadDir, { recursive: true });
    const safe = name.replace(/[^\w.\- ]+/g, '_').slice(-120);
    const file = path.join(b.downloadDir, Date.now() + '-' + id + '-' + safe);
    item.setSavePath(file);
    // Les métadonnées se lisent MAINTENANT, pendant que la fiche est encore
    // affichée : à la fin du téléchargement, l'utilisateur est peut-être déjà
    // ailleurs sur le site.
    const metaP = (wc && !wc.isDestroyed() ? wc.executeJavaScript(META_SCRIPT, true) : Promise.resolve({}))
      .catch(() => ({}));
    b.onDownload({ id, name, state: 'progress', received: 0, total: item.getTotalBytes() });
    let last = 0;
    item.on('updated', () => {
      // Taille inconnue au départ (pas d'en-tête Content-Length) : le
      // plafond se vérifie aussi en cours de route.
      if (item.getReceivedBytes() > MAX_DOWNLOAD) { item.cancel(); return; }
      const now = Date.now();
      if (now - last < 200) return;   // la fenêtre n'a pas besoin de 60 messages par seconde
      last = now;
      b.onDownload({ id, name, state: 'progress',
        received: item.getReceivedBytes(), total: item.getTotalBytes() });
    });
    item.once('done', (_ev, st) => {
      if (st !== 'completed') {
        try { fs.rmSync(file, { force: true }); } catch (e) {}
        b.onDownload({ id, name, state: st === 'cancelled' ? 'cancelled' : 'failed' });
        return;
      }
      metaP.then((meta) => b.onComplete({ id, name, file, meta: meta || {} }));
    });
  });
  return ses;
}

// Aperçu de la carte : téléchargé par la même session, uniquement depuis le
// CDN du site, plafonné. Rend un Buffer, ou null.
async function fetchPreview(url) {
  const u = parse(url);
  if (!u || u.protocol !== 'https:' || u.hostname !== 'cdn.bakkesplugins.com') return null;
  try {
    const res = await mapsSession().fetch(u.toString());
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length && buf.length <= 3 * 1024 * 1024 ? buf : null;
  } catch (e) { return null; }
}

// Attache la vue à une fenêtre. `opts` :
//   downloadDir, onNav(état), onDownload(progression), onComplete(fichier + méta)
function attach(win, opts) {
  const o = opts || {};
  const view = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
    },
  });
  mapsSession();
  const wc = view.webContents;
  win.contentView.addChildView(view);
  view.setVisible(false);

  const b = {
    view,
    downloadDir: o.downloadDir,
    onDownload: o.onDownload || (() => {}),
    onComplete: o.onComplete || (() => {}),
  };
  current = b;

  // Dernière panne de chargement de la page principale. Tenue ici et non
  // déduite des évènements : la page d'erreur de Chromium déclenche elle
  // aussi un did-navigate, qui effaçait la panne à peine signalée.
  let lastError = null;
  const nav = (extra) => {
    if (wc.isDestroyed()) return;
    const h = wc.navigationHistory;
    (o.onNav || (() => {}))(Object.assign({
      url: wc.getURL(),
      canBack: h ? h.canGoBack() : false,
      canForward: h ? h.canGoForward() : false,
      loading: wc.isLoading(),
      error: lastError,
    }, extra || {}));
  };

  // Liens vers l'extérieur : jamais ouverts d'office. Les pubs du site
  // naviguent et ouvrent des fenêtres sans qu'on ait cliqué (constaté en
  // test : une redirection doubleclick lançait le navigateur de
  // l'utilisateur). On bloque, on prévient la fenêtre, et seul un clic sur
  // « Ouvrir » dans l'application laisse partir CE lien-là.
  const blocked = new Set();
  const block = (url) => {
    const u = parse(url);
    if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) return;
    blocked.add(u.toString());
    if (blocked.size > 20) blocked.delete(blocked.values().next().value);
    nav({ blocked: u.toString() });
  };

  wc.setWindowOpenHandler(({ url }) => {
    // « Download ZIP » s'ouvre dans un nouvel onglet : c'est ici qu'on le
    // rattrape pour en faire un téléchargement.
    if (isMapFile(url)) wc.downloadURL(url);
    else if (isSite(url)) wc.loadURL(url);
    else block(url);
    return { action: 'deny' };
  });
  // Seule la page principale est surveillée : les cadres de pub vivent leur
  // vie dans leur bac à sable, et les rediriger vers le navigateur de
  // l'utilisateur serait pire que les laisser faire.
  const guard = (e, url, isMain) => {
    if (isMain === false || isSite(url)) return;
    e.preventDefault();
    if (isMapFile(url)) wc.downloadURL(url);
    else block(url);
  };
  wc.on('will-navigate', (e, url) => guard(e, url, true));
  wc.on('will-redirect', (e, url, _inPlace, isMain) => guard(e, url, isMain));
  wc.on('did-start-navigation', (_e, _url, inPage, isMain) => {
    if (isMain && !inPage) lastError = null;
  });
  wc.on('did-start-loading', () => nav());
  wc.on('did-stop-loading', () => nav());
  wc.on('did-navigate', () => nav());
  wc.on('did-navigate-in-page', () => nav());
  wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
    // -3 : navigation annulée (par nous, ou par un clic rapide), pas une panne.
    if (!isMain || code === -3) return;
    lastError = desc || ('erreur ' + code);
    nav({ failedUrl: url });
  });

  wc.loadURL(HOME).catch(() => {});

  return {
    setBounds(r) {
      if (!r || !(r.width > 0) || !(r.height > 0)) { view.setVisible(false); return; }
      view.setBounds({ x: Math.round(r.x), y: Math.round(r.y),
        width: Math.round(r.width), height: Math.round(r.height) });
      view.setVisible(true);
    },
    command(cmd) {
      if (wc.isDestroyed()) return;
      const h = wc.navigationHistory;
      if (cmd === 'back' && h && h.canGoBack()) h.goBack();
      else if (cmd === 'forward' && h && h.canGoForward()) h.goForward();
      else if (cmd === 'reload') wc.reload();
      else if (cmd === 'home') wc.loadURL(HOME).catch(() => {});
      else if (cmd === 'external') openOutside(wc.getURL() || HOME);
      // Lien extérieur bloqué, que l'utilisateur a choisi d'ouvrir.
      else if (cmd.startsWith('open-blocked:') && blocked.has(cmd.slice(13))) {
        blocked.delete(cmd.slice(13));
        openOutside(cmd.slice(13));
      }
      // Fiche d'une carte de la bibliothèque, rouverte dans le site.
      else if (cmd.startsWith('goto:') && isSite(cmd.slice(5))) wc.loadURL(cmd.slice(5)).catch(() => {});
    },
    destroy() {
      if (current === b) current = null;
      try { win.contentView.removeChildView(view); } catch (e) {}
      try { if (!wc.isDestroyed()) wc.close(); } catch (e) {}
    },
  };
}

module.exports = { attach, fetchPreview, isSite, isMapFile, HOME };
