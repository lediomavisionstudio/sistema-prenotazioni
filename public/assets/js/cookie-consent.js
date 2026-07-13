(function () {
  'use strict';

  var STORAGE_KEY = 'booking-cookie-consent-v1';
  var DEFAULTS = {
    necessary: true,
    statistics: false,
    marketing: false,
    updatedAt: null
  };

  window.CookieConsent = {
    get: readConsent,
    openPreferences: function () { showPreferences(); }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  function init() {
    try {
      injectStyle();
      if (!readConsent()) showBanner();
    } catch (e) {
      console.error('[cookie-consent] inizializzazione non riuscita:', e);
    }
  }

  function readConsent() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return normalizeConsent(JSON.parse(raw));
    } catch (e) {
      return null;
    }
  }

  function normalizeConsent(consent) {
    consent = consent || {};
    return {
      necessary: true,
      statistics: !!(consent.statistics || consent.functional),
      marketing: !!(consent.marketing || consent.thirdParty),
      updatedAt: consent.updatedAt || null
    };
  }

  function saveConsent(consent) {
    var payload = Object.assign({}, DEFAULTS, consent, {
      necessary: true,
      updatedAt: new Date().toISOString()
    });
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {
      console.error('[cookie-consent] impossibile salvare preferenze:', e);
    }
    closeBanner();
    closePreferences();
  }

  function showBanner() {
    if (!document.body) return;
    closeBanner();

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
          '<p>Usiamo cookie tecnici necessari al funzionamento del sito. Puoi accettare o gestire le categorie facoltative.</p>' +
        '</div>' +
        '<div class="cookie-consent__actions">' +
          '<button class="cookie-consent__btn cookie-consent__btn--ghost" type="button" id="cookieReject">Rifiuta</button>' +
          '<button class="cookie-consent__btn cookie-consent__btn--ghost" type="button" id="cookieCustomize">Personalizza</button>' +
          '<button class="cookie-consent__btn cookie-consent__btn--primary" type="button" id="cookieAccept">Accetta</button>' +
        '</div>' +
      '</div>';

    try {
      document.body.appendChild(overlay);
    } catch (e) {
      console.error('[cookie-consent] banner non mostrato:', e);
      return;
    }

    document.getElementById('cookieReject').addEventListener('click', function () {
      saveConsent({ statistics: false, marketing: false });
    });
    document.getElementById('cookieAccept').addEventListener('click', function () {
      saveConsent({ statistics: true, marketing: true });
    });
    document.getElementById('cookieCustomize').addEventListener('click', function () {
      showPreferences();
    });

    setTimeout(function () {
      var first = document.getElementById('cookieCustomize') || document.getElementById('cookieReject');
      if (first) first.focus();
    }, 0);
  }

  function showPreferences() {
    if (!document.body) return;
    closePreferences();
    injectStyle();

    var saved = readConsent() || DEFAULTS;
    var modal = document.createElement('div');
    modal.id = 'cookiePreferences';
    modal.className = 'cookie-preferences';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'cookiePrefsTitle');

    modal.innerHTML =
      '<div class="cookie-preferences__panel">' +
        '<div class="cookie-preferences__copy">' +
          '<p class="cookie-consent__kicker">Privacy</p>' +
          '<h2 id="cookiePrefsTitle">Gestisci preferenze cookie</h2>' +
          '<p>Scegli quali categorie autorizzare. Puoi modificare questa scelta dalle preferenze cookie.</p>' +
        '</div>' +
        '<div class="cookie-consent__prefs">' +
          optionHtml('Cookie necessari', 'Questi cookie sono indispensabili per il corretto funzionamento del sistema di prenotazione e non possono essere disattivati.', 'necessary', true, true, 'Sempre attivi') +
          optionHtml('Cookie statistici', "Consentono di raccogliere dati anonimi sull'utilizzo del sito per migliorarne prestazioni ed esperienza.", 'statistics', saved.statistics, false) +
          optionHtml('Cookie marketing', 'Consentono di personalizzare eventuali contenuti promozionali e campagne pubblicitarie.', 'marketing', saved.marketing, false) +
        '</div>' +
        '<div class="cookie-consent__actions">' +
          '<button class="cookie-consent__btn cookie-consent__btn--primary" type="button" id="cookieSavePrefs">Salva preferenze</button>' +
          '<button class="cookie-consent__btn cookie-consent__btn--ghost" type="button" id="cookieAcceptAllPrefs">Accetta tutto</button>' +
          '<button class="cookie-consent__btn cookie-consent__btn--ghost" type="button" id="cookieClosePrefs">Chiudi</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(modal);

    document.getElementById('cookieSavePrefs').addEventListener('click', function () {
      saveConsent({
        statistics: document.getElementById('cookieStatistics').checked,
        marketing: document.getElementById('cookieMarketing').checked
      });
    });
    document.getElementById('cookieAcceptAllPrefs').addEventListener('click', function () {
      saveConsent({ statistics: true, marketing: true });
    });
    document.getElementById('cookieClosePrefs').addEventListener('click', closePreferences);
    modal.addEventListener('click', function (event) {
      if (event.target === modal) closePreferences();
    });

    setTimeout(function () {
      var first = document.getElementById('cookieStatistics') || document.getElementById('cookieSavePrefs');
      if (first) first.focus();
    }, 0);
  }

  function closeBanner() {
    var existing = document.getElementById('cookieConsent');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
  }

  function closePreferences() {
    var existing = document.getElementById('cookiePreferences');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
  }

  function optionHtml(title, text, key, checked, disabled, badge) {
    var id = key === 'statistics' ? 'cookieStatistics' : key === 'marketing' ? 'cookieMarketing' : 'cookieNecessary';
    return '' +
      '<label class="cookie-consent__option" for="' + id + '">' +
        '<span><strong>' + title + '</strong>' +
          (badge ? '<em>' + badge + '</em>' : '') +
          '<small>' + text + '</small></span>' +
        '<input id="' + id + '" type="checkbox" ' + (checked ? 'checked' : '') + ' ' + (disabled ? 'disabled' : '') + ' />' +
      '</label>';
  }

  function injectStyle() {
    if (document.getElementById('cookieConsentStyle')) return;
    var css =
      '.cookie-consent{position:fixed;inset:auto 12px 12px;z-index:80;display:flex;justify-content:center;font-family:"Inter",system-ui,sans-serif;}' +
      '.cookie-consent__panel{width:min(100%,520px);background:#fffdf6;color:#3a2b23;border:1px solid #e3d6ba;border-radius:18px;box-shadow:0 10px 40px rgba(58,43,35,.22);padding:18px;}' +
      '.cookie-consent__kicker{font-size:.7rem;letter-spacing:.16em;text-transform:uppercase;color:#c8402a;font-weight:700;margin:0 0 4px;}' +
      '.cookie-consent h2,.cookie-preferences h2{font-family:"Bricolage Grotesque",system-ui,sans-serif;font-size:1.25rem;line-height:1.1;margin:0 0 6px;}' +
      '.cookie-consent p,.cookie-preferences p{margin:0;color:#7a6a5d;font-size:.9rem;line-height:1.45;}' +
      '.cookie-preferences{position:fixed;inset:0;z-index:90;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(58,43,35,.36);backdrop-filter:blur(6px);font-family:"Inter",system-ui,sans-serif;}' +
      '.cookie-preferences__panel{width:min(100%,560px);max-height:min(88vh,720px);overflow:auto;background:#fffdf6;color:#3a2b23;border:1px solid #e3d6ba;border-radius:18px;box-shadow:0 18px 50px rgba(58,43,35,.28);padding:18px;}' +
      '.cookie-consent__prefs{display:grid;gap:9px;margin-top:14px;}' +
      '.cookie-consent__option{display:flex;align-items:center;justify-content:space-between;gap:12px;background:#f7efdb;border:1px solid #e3d6ba;border-radius:12px;padding:11px 12px;}' +
      '.cookie-consent__option small{display:block;color:#7a6a5d;font-size:.78rem;line-height:1.35;margin-top:2px;}' +
      '.cookie-consent__option em{display:inline-block;margin-left:8px;color:#7a6a5d;font-size:.72rem;font-style:normal;font-weight:700;}' +
      '.cookie-consent__option input{width:20px;height:20px;accent-color:#c8402a;flex:none;}' +
      '.cookie-consent__actions{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;margin-top:15px;}' +
      '.cookie-consent__btn{border:1.5px solid #e3d6ba;border-radius:12px;cursor:pointer;font:inherit;font-weight:700;padding:10px 14px;}' +
      '.cookie-consent__btn:focus-visible{outline:none;box-shadow:0 0 0 3px #f7ddd5;border-color:#c8402a;}' +
      '.cookie-consent__btn--primary{background:#c8402a;color:#fff;border-color:#c8402a;}' +
      '.cookie-consent__btn--primary:hover{background:#a5321f;border-color:#a5321f;}' +
      '.cookie-consent__btn--ghost{background:transparent;color:#a5321f;}' +
      '@media(max-width:420px){.cookie-consent__actions{display:grid;grid-template-columns:1fr;}.cookie-consent__btn{width:100%;}.cookie-preferences{align-items:flex-end;padding:12px;}.cookie-preferences__panel{max-height:90vh;}}';
    var style = document.createElement('style');
    style.id = 'cookieConsentStyle';
    style.textContent = css;
    document.head.appendChild(style);
  }
})();
