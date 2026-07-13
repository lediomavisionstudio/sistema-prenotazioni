// PWA: registrazione del service worker + banner d'installazione personalizzato.
// Script "classico" (nessun import): incluso sia dal widget cliente che dalle
// pagine del pannello. Inietta da solo il proprio stile, così non dipende dal
// CSS della pagina che lo ospita.
(function () {
  'use strict';

  // --- 1) Registrazione del service worker --------------------------------
  // sw.js è servito dalla root del sito: lo scope '/' copre widget e /admin.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      var registration = navigator.serviceWorker.register('/sw.js');
      var timeout = new Promise(function (_, reject) {
        setTimeout(function () { reject(new Error('SERVICE_WORKER_TIMEOUT')); }, 5000);
      });
      Promise.race([registration, timeout]).then(function (reg) {
        console.log('[pwa] service worker registrato');
        if (reg && reg.update) reg.update().catch(function (e) {
          console.warn('[pwa] aggiornamento service worker non riuscito:', e);
        });
      }).catch(function (e) {
        console.warn('[pwa] service worker non registrato:', e);
      });
    });
  }

  // --- 2) Prompt d'installazione personalizzato ---------------------------
  var deferredPrompt = null;
  var DISMISS_KEY = 'pwa-install-dismissed';
  var isAdmin = location.pathname.indexOf('/admin') !== -1;

  window.addEventListener('beforeinstallprompt', function (e) {
    // Blocca il mini-infobar di default e mostra il nostro banner.
    e.preventDefault();
    deferredPrompt = e;
    try {
      if (localStorage.getItem(DISMISS_KEY)) return; // l'utente l'ha già chiuso
    } catch (err) {
      console.warn('[pwa] localStorage non disponibile:', err);
    }
    showBanner();
  });

  window.addEventListener('appinstalled', function () {
    removeBanner();
    deferredPrompt = null;
  });

  function bannerText() {
    return isAdmin
      ? 'Aggiungi alla home per aprire il gestionale al volo'
      : 'Aggiungi alla home per prenotare più velocemente';
  }

  function showBanner() {
    if (document.getElementById('pwaBanner')) return;
    injectStyle();

    var bar = document.createElement('div');
    bar.id = 'pwaBanner';
    bar.className = 'pwa-banner';
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-label', "Installa l'app");
    bar.innerHTML =
      '<img class="pwa-banner__icon" src="' + iconPath() + '" alt="" />' +
      '<span class="pwa-banner__text">' + bannerText() + '</span>' +
      '<button class="pwa-banner__btn" id="pwaInstall" type="button">Installa</button>' +
      '<button class="pwa-banner__close" id="pwaClose" type="button" aria-label="Chiudi">&times;</button>';
    document.body.appendChild(bar);
    requestAnimationFrame(function () { bar.classList.add('is-show'); });

    document.getElementById('pwaInstall').addEventListener('click', doInstall);
    document.getElementById('pwaClose').addEventListener('click', dismiss);
  }

  function doInstall() {
    if (!deferredPrompt) { removeBanner(); return; }
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(function () {
      deferredPrompt = null;
      removeBanner();
    }, function (e) {
      console.warn('[pwa] scelta installazione non completata:', e);
      deferredPrompt = null;
      removeBanner();
    });
  }

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch (e) {
      console.error('[pwa] impossibile salvare preferenza installazione:', e);
    }
    removeBanner();
  }

  function removeBanner() {
    var bar = document.getElementById('pwaBanner');
    if (!bar) return;
    bar.classList.remove('is-show');
    setTimeout(function () { if (bar.parentNode) bar.parentNode.removeChild(bar); }, 250);
  }

  function iconPath() {
    return isAdmin ? '../assets/icons/icon.svg' : 'assets/icons/icon.svg';
  }

  function injectStyle() {
    if (document.getElementById('pwaBannerStyle')) return;
    var css =
      '.pwa-banner{position:fixed;left:12px;right:12px;bottom:12px;z-index:60;' +
      'max-width:460px;margin:0 auto;display:flex;align-items:center;gap:12px;' +
      'background:#fffdf6;color:#3a2b23;border:1px solid #e3d6ba;border-radius:14px;' +
      'box-shadow:0 10px 40px rgba(58,43,35,.18);padding:12px 14px;' +
      'font-family:"Inter",system-ui,sans-serif;' +
      'transform:translateY(140%);opacity:0;transition:transform .25s,opacity .25s;}' +
      '.pwa-banner.is-show{transform:translateY(0);opacity:1;}' +
      '.pwa-banner__icon{width:38px;height:38px;border-radius:9px;flex:none;}' +
      '.pwa-banner__text{flex:1;font-size:.86rem;line-height:1.3;font-weight:500;}' +
      '.pwa-banner__btn{flex:none;border:none;cursor:pointer;background:#c8402a;color:#fff;' +
      'font:inherit;font-weight:700;font-size:.85rem;padding:9px 14px;border-radius:9px;}' +
      '.pwa-banner__btn:hover{background:#a5321f;}' +
      '.pwa-banner__close{flex:none;border:none;background:transparent;color:#7a6a5d;' +
      'font-size:1.4rem;line-height:1;cursor:pointer;padding:0 4px;}';
    var style = document.createElement('style');
    style.id = 'pwaBannerStyle';
    style.textContent = css;
    document.head.appendChild(style);
  }
})();
