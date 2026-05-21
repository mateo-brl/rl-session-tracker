// scripts/build-web.mjs — Pré-compilation du dashboard web.
//
// Objectif : supprimer le CDN unpkg (React, ReactDOM, @babel/standalone) et la
// compilation JSX dans le navigateur, pour qu'une CSP stricte `script-src 'self'`
// soit possible. On produit un bundle unique `public/dist/app.js` minifié.
//
// Méthode : « concaténer puis compiler ».
//  1) React + ReactDOM sont bundlés via esbuild en un IIFE qui les expose en
//     globales (window.React / window.ReactDOM) — exactement comme le faisaient
//     les UMD du CDN.
//  2) Les fichiers applicatifs (data.js, i18n.js, *.jsx) partagent un scope
//     global (window.RL, fonctions globales). On transforme donc leur JSX
//     individuellement (esbuild transform, sans wrapping module) et on les
//     concatène dans l'ordre de chargement d'origine — le scope global est
//     préservé à l'identique.
//  3) L'ensemble est minifié en un seul fichier.
//
//   npm run build:web

import { build, transform } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const distDir = path.join(publicDir, 'dist');

fs.mkdirSync(distDir, { recursive: true });

// ───────── 1) React + ReactDOM → globales (remplace les UMD du CDN) ─────────
// Un mini-module qui importe React et le client ReactDOM puis les pose sur
// window, reproduisant l'API attendue par le code applicatif :
//   - window.React
//   - window.ReactDOM.createRoot
const reactShim = `
import * as React from 'react';
import * as ReactDOMClient from 'react-dom/client';
const g = typeof window !== 'undefined' ? window : globalThis;
g.React = React.default || React;
g.ReactDOM = { ...ReactDOMClient, createRoot: ReactDOMClient.createRoot };
`;

const reactBundle = await build({
  stdin: {
    contents: reactShim,
    resolveDir: root,
    sourcefile: 'react-shim.js',
    loader: 'js',
  },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2018',
  write: false,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const reactCode = reactBundle.outputFiles[0].text;
console.log('  [1/3] React + ReactDOM bundlés (' +
  Math.round(reactCode.length / 1024) + ' Ko)');

// ───────── 2) Code applicatif — JSX transformé, scope global conservé ─────────
// Ordre identique à l'ancien index.html : la couche données d'abord, puis i18n,
// puis les modules JSX, puis variants (qui définit AppShell et monte l'app).
const APP_FILES = [
  'data.js',
  'i18n.js',
  'tweaks-panel.jsx',
  'modules.jsx',
  'variants.jsx',
];

const appParts = [];
for (const file of APP_FILES) {
  const src = fs.readFileSync(path.join(publicDir, file), 'utf8');
  const isJsx = file.endsWith('.jsx');
  // transform (et non bundle) : aucun wrapping module, le code reste au
  // niveau global comme avec les anciens <script>. JSX → React.createElement,
  // 'React' restant une référence à la globale posée à l'étape 1.
  const out = await transform(src, {
    loader: isJsx ? 'jsx' : 'js',
    jsx: 'transform',
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
    target: 'es2018',
    legalComments: 'none',
  });
  appParts.push('// ===== ' + file + ' =====\n' + out.code);
}
console.log('  [2/3] ' + APP_FILES.length + ' fichiers applicatifs transformés');

// ───────── 3) Concaténation + minification → public/dist/app.js ─────────
const combined = [reactCode, ...appParts].join('\n;\n');
const minified = await transform(combined, {
  loader: 'js',
  minify: true,
  target: 'es2018',
  legalComments: 'none',
});

const outPath = path.join(distDir, 'app.js');
fs.writeFileSync(outPath, minified.code);
console.log('  [3/3] Bundle écrit : public/dist/app.js (' +
  Math.round(minified.code.length / 1024) + ' Ko)');
console.log('\n  ✓ Build web terminé');
