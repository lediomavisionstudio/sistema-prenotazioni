(function () {
  'use strict';

  var DEFAULTS = {
    NOME_LOCALE: '{{NOME_LOCALE}}',
    RAGIONE_SOCIALE: '{{RAGIONE_SOCIALE}}',
    INDIRIZZO: '{{INDIRIZZO}}',
    EMAIL_LOCALE: '{{EMAIL_LOCALE}}',
    TELEFONO_LOCALE: '{{TELEFONO_LOCALE}}',
    PARTITA_IVA: '{{PARTITA_IVA}}',
    MESI_RETENTION: '24',
    ULTIMO_AGGIORNAMENTO: '9 luglio 2026'
  };

  var config = window.APP_CONFIG || {};
  var params = new URLSearchParams(location.search);
  var slug = params.get('locale') || config.DEFAULT_VENUE_SLUG;

  fill(DEFAULTS);

  if (slug && config.SUPABASE_URL && config.SUPABASE_ANON_KEY && window.supabase) {
    var client = window.supabase.createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
      auth: { persistSession: false }
    });

    client
      .from('venues')
      .select('*')
      .eq('slug', slug)
      .maybeSingle()
      .then(function (result) {
        if (!result || !result.data) return;
        var v = result.data;
        fill({
          NOME_LOCALE: v.name,
          RAGIONE_SOCIALE: v.legal_name || v.name,
          INDIRIZZO: v.address,
          EMAIL_LOCALE: v.contact_email,
          TELEFONO_LOCALE: v.phone,
          PARTITA_IVA: v.vat_number,
          MESI_RETENTION: v.data_retention_months,
          ULTIMO_AGGIORNAMENTO: DEFAULTS.ULTIMO_AGGIORNAMENTO
        });
      })
      .catch(function (e) {
        console.warn('[legal] dati locale non caricati:', e);
      });
  }

  function fill(map) {
    var merged = Object.assign({}, DEFAULTS, map || {});
    replaceIn(document.body, merged);

    if (document.title) {
      document.title = replaceText(document.title, merged, false);
    }

    document.querySelectorAll('meta[content]').forEach(function (el) {
      el.setAttribute('content', replaceText(el.getAttribute('content'), merged, false));
    });

    document.querySelectorAll('[data-mailto]').forEach(function (el) {
      var email = merged.EMAIL_LOCALE;
      if (email && email.indexOf('{{') === -1) el.setAttribute('href', 'mailto:' + email);
    });
  }

  function replaceIn(root, map) {
    if (!root) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(function (node) {
      node.nodeValue = replaceText(node.nodeValue, map, true);
    });
  }

  function replaceText(text, map, escapeMissing) {
    return String(text).replace(/\{\{(\w+)\}\}/g, function (match, key) {
      var value = map[key];
      if (value === null || value === undefined || value === '') return escapeMissing ? match : '';
      return String(value);
    });
  }
})();
