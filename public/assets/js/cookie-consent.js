(function () {
  'use strict';

  var STORAGE_KEY = 'booking-cookie-consent-v1';
  var DEFAULTS = {
    necessary: true,
    functional: false,
    thirdParty: false,
    updatedAt: null
  };

  window.CookieConsent = {
    get: readConsent,
    openPreferences: function () { showBanner(true); }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  function init() {
    injectStyle();
    if (!readConsent()) showBanner(false);
  }

  function readConsent() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function saveConsent(consent) {
    var payload = Object.assign({}, DEFAULTS, consent, {
      necessary: true,
      updatedAt: new Date().toISOString()
    });
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(payload)); } catch (e) {}
    closeBanner();
  }

  function showBanner(preferences) {
    closeBanner();

    var saved = readConsent() || DEFAULTS;
    var overlay = document.createElement('div');
    overlay.id = 'cookieConsent';
    overlay.className = 'cookie-consent';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'cookieTitle');

    overlay.innerHTML =
      '<div class="cookie-consent__panel">' +
        '<div class="cookie-consent__copy">' +
          '<p class="cookie-consent__kicker">Privacy</p>' +
          '<h2 id="cookieTitle">Preferenze cookie</h2>' +
          '<p>Usiamo cookie tecnici necessari al funzionamento del sito. Puoi accettare o rifiutare le categorie facoltative.</p>' +
        '</div>' +
        '<div class="cookie-consent__prefs" id="cookiePrefs" ' + (preferences ? '' : 'hidden') + '>' +
          optionHtml('Cookie tecnici', 'Necessari per prenotazione, sicurezza e salvataggio delle preferenze.', 'necessary', true, true) +
          optionHtml('Cookie funzionali', 'Ricordano scelte utili per migliorare l’esperienza.', 'functional', saved.functional, false) +
          optionHtml('Cookie di terze parti', 'Permettono servizi esterni, se attivati dal sito.', 'thirdParty', saved.thirdParty, false) +
        '</div>' +
        '<div class="cookie-consent__actions">' +
          '<button class="cookie-consent__btn cookie-consent__btn--ghost" type="button" id="cookieReject">Rifiuta</button>' +
          '<button class="cookie-consent__btn cookie-consent__btn--ghost" type="button" id="cookieCustomize">' + (preferences ? 'Nascondi' : 'Personalizza') + '</button>' +
          '<button class="cookie-consent__btn cookie-consent__btn--primary" type="button" id="cookieAccept">Accetta</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);

    document.getElementById('cookieReject').addEventListener('click', function () {
      saveConsent({ functional: false, thirdParty: false });
    });
    document.getElementById('cookieAccept').addEventListener('click', function () {
      var prefs = document.getElementById('cookiePrefs');
      if (prefs.hidden) {
        saveConsent({ functional: true, thirdParty: true });
        return;
      }
      saveConsent({
        functional: document.getElementById('cookieFunctional').checked,
        thirdParty: document.getElementById('cookieThirdParty').checked
      });
    });
    document.getElementById('cookieCustomize').addEventListener('click', function () {
      var prefs = document.getElementById('cookiePrefs');
      prefs.hidden = !prefs.hidden;
      this.textContent = prefs.hidden ? 'Personalizza' : 'Nascondi';
    });

    setTimeout(function () {
      var first = document.getElementById(preferences ? 'cookieFunctional' : 'cookieReject');
      if (first) first.focus();
    }, 0);
  }

  function closeBanner() {
    var existing = document.getElementById('cookieConsent');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
  }

  function optionHtml(title, text, key, checked, disabled) {
    var id = key === 'functional' ? 'cookieFunctional' : key === 'thirdParty' ? 'cookieThirdParty' : 'cookieNecessary';
    return '' +
      '<label class="cookie-consent__option" for="' + id + '">' +
        '<span><strong>' + title + '</strong><small>' + text + '</small></span>' +
        '<input id="' + id + '" type="checkbox" ' + (checked ? 'checked' : '') + ' ' + (disabled ? 'disabled' : '') + ' />' +
      '</label>';
  }

  function injectStyle() {
    if (document.getElementById('cookieConsentStyle')) return;
    var css =
      '.cookie-consent{position:fixed;inset:auto 12px 12px;z-index:80;display:flex;justify-content:center;font-family:"Inter",system-ui,sans-serif;}' +
      '.cookie-consent__panel{width:min(100%,520px);background:#fffdf6;color:#3a2b23;border:1px solid #e3d6ba;border-radius:18px;box-shadow:0 10px 40px rgba(58,43,35,.22);padding:18px;}' +
      '.cookie-consent__kicker{font-size:.7rem;letter-spacing:.16em;text-transform:uppercase;color:#c8402a;font-weight:700;margin:0 0 4px;}' +
      '.cookie-consent h2{font-family:"Bricolage Grotesque",system-ui,sans-serif;font-size:1.25rem;line-height:1.1;margin:0 0 6px;}' +
      '.cookie-consent p{margin:0;color:#7a6a5d;font-size:.9rem;line-height:1.45;}' +
      '.cookie-consent__prefs{display:grid;gap:9px;margin-top:14px;}' +
      '.cookie-consent__option{display:flex;align-items:center;justify-content:space-between;gap:12px;background:#f7efdb;border:1px solid #e3d6ba;border-radius:12px;padding:11px 12px;}' +
      '.cookie-consent__option small{display:block;color:#7a6a5d;font-size:.78rem;line-height:1.35;margin-top:2px;}' +
      '.cookie-consent__option input{width:20px;height:20px;accent-color:#c8402a;flex:none;}' +
      '.cookie-consent__actions{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;margin-top:15px;}' +
      '.cookie-consent__btn{border:1.5px solid #e3d6ba;border-radius:12px;cursor:pointer;font:inherit;font-weight:700;padding:10px 14px;}' +
      '.cookie-consent__btn:focus-visible{outline:none;box-shadow:0 0 0 3px #f7ddd5;border-color:#c8402a;}' +
      '.cookie-consent__btn--primary{background:#c8402a;color:#fff;border-color:#c8402a;}' +
      '.cookie-consent__btn--primary:hover{background:#a5321f;border-color:#a5321f;}' +
      '.cookie-consent__btn--ghost{background:transparent;color:#a5321f;}' +
      '@media(max-width:420px){.cookie-consent__actions{display:grid;grid-template-columns:1fr;}.cookie-consent__btn{width:100%;}}';
    var style = document.createElement('style');
    style.id = 'cookieConsentStyle';
    style.textContent = css;
    document.head.appendChild(style);
  }
})();
