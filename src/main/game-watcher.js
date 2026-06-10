// game-watcher.js — Détecte si Rocket League tourne.
//
// La Stats API ne dit pas « le jeu est lancé », seulement « un match est en
// cours ». Pour ouvrir le dashboard dès l'écran d'accueil du jeu, on surveille
// le processus RocketLeague.exe (tasklist, toutes les 5 s).
//
// Anti-clignotement : il faut 2 relevés négatifs consécutifs pour déclarer le
// jeu fermé (un tasklist qui rate ne ferme pas le dashboard).

const { spawn } = require('child_process');
const EventEmitter = require('events');

const POLL_MS = 5000;
const EXE = 'RocketLeague.exe';

class GameWatcher extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this._missCount = 0;
    this._timer = null;
  }

  start() {
    if (process.platform !== 'win32') return;   // dev hors Windows : Stats API seule
    const tick = () => {
      this._check().then((found) => {
        if (found) {
          this._missCount = 0;
          this._set(true);
        } else {
          this._missCount++;
          if (this._missCount >= 2) this._set(false);
        }
      });
    };
    tick();
    this._timer = setInterval(tick, POLL_MS);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  _set(running) {
    if (this.running === running) return;
    this.running = running;
    this.emit('change', running);
  }

  _check() {
    return new Promise((resolve) => {
      let out = '';
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      try {
        const cp = spawn('tasklist',
          ['/FI', 'IMAGENAME eq ' + EXE, '/FO', 'CSV', '/NH'],
          { windowsHide: true });
        const timer = setTimeout(() => { try { cp.kill(); } catch (e) {} finish(this.running); }, 4000);
        cp.stdout.on('data', (d) => { out += d; });
        cp.on('error', () => { clearTimeout(timer); finish(this.running); });
        cp.on('exit', () => {
          clearTimeout(timer);
          finish(out.toLowerCase().includes(EXE.toLowerCase()));
        });
      } catch (e) {
        finish(this.running);
      }
    });
  }
}

module.exports = GameWatcher;
