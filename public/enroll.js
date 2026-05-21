// enroll.js — Logique de la page d'inscription self-service.
//
// Fichier externe (et non script en ligne) : la CSP du serveur est stricte
// (script-src 'self'), un <script> inline serait bloqué.

(function () {
  'use strict';

  var form = document.getElementById('form');
  var submit = document.getElementById('submit');
  var errorBox = document.getElementById('error');
  var idInput = document.getElementById('id');
  var idHint = document.getElementById('idHint');

  // Aperçu en direct de l'adresse publique pendant la saisie de l'identifiant.
  function refreshHint() {
    var v = idInput.value.trim().toLowerCase();
    idHint.textContent = v
      ? '— ' + location.host + '/u/' + v
      : '— ton adresse publique';
  }
  idInput.addEventListener('input', refreshHint);

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.className = 'msg err';
  }
  function clearError() {
    errorBox.className = 'msg';
    errorBox.textContent = '';
  }

  function selectedPlatform() {
    var r = document.querySelector('input[name="platform"]:checked');
    return r ? r.value : 'epic';
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    clearError();

    var payload = {
      inviteCode: document.getElementById('invite').value.trim(),
      id: idInput.value.trim().toLowerCase(),
      name: document.getElementById('name').value.trim(),
      platform: selectedPlatform(),
      username: document.getElementById('username').value.trim()
    };

    submit.disabled = true;
    submit.textContent = 'Création…';

    fetch('/api/enroll/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (res) {
        return res.json().then(function (data) {
          return { ok: res.ok, data: data };
        });
      })
      .then(function (r) {
        if (!r.ok) {
          showError((r.data && r.data.error) || 'Inscription refusée.');
          return;
        }
        showSuccess(r.data);
      })
      .catch(function () {
        showError('Serveur injoignable. Vérifie ta connexion et réessaie.');
      })
      .then(function () {
        submit.disabled = false;
        submit.textContent = 'Créer mon accès';
      });
  });

  function showSuccess(data) {
    // Le code voyage dans le nom du fichier téléchargé : l'agent le lira
    // dans son propre nom et se configurera sans aucune saisie.
    var dl = document.getElementById('downloadLink');
    dl.href = '/download/agent?code=' + encodeURIComponent(data.setupCode);

    // Code affiché aussi en clair (repli si le fichier est renommé).
    document.getElementById('setupCode').textContent = data.setupCode;

    var link = document.getElementById('pageLink');
    link.textContent = location.host + '/u/' + data.id;
    link.href = data.pageUrl || ('/u/' + data.id);

    document.getElementById('step-form').classList.add('hidden');
    document.getElementById('step-done').classList.remove('hidden');
    window.scrollTo(0, 0);
  }

  // Copie du code de configuration dans le presse-papiers.
  var copyBtn = document.getElementById('copy');
  copyBtn.addEventListener('click', function () {
    var code = document.getElementById('setupCode').textContent;
    var done = function () {
      copyBtn.textContent = '✓ Copié';
      setTimeout(function () { copyBtn.textContent = 'Copier le code'; }, 2000);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(done, function () {
        copyBtn.textContent = 'Copie impossible — sélectionne le code';
      });
    } else {
      copyBtn.textContent = 'Sélectionne le code à la main';
    }
  });

  refreshHint();
})();
