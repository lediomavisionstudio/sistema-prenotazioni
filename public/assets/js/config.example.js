// Copia questo file in `config.js` (stessa cartella) e inserisci i valori del
// tuo progetto Supabase (Project Settings → API). config.js è in .gitignore.
//
// La ANON KEY è pubblica per natura (viaggia nel browser): la sicurezza è
// garantita dalle RLS policy, non dal tenerla segreta. Non inserire MAI qui
// la service_role key.
window.APP_CONFIG = {
  SUPABASE_URL: 'https://xxxxxxxxxxxx.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOi...',

  // Slug del locale di default se non presente ?locale= nell'URL.
  // In produzione ogni locale riceve un link tipo:  https://.../?locale=pizzeria-da-mario
  DEFAULT_VENUE_SLUG: 'pizzeria-da-mario',

  // Link alla privacy policy mostrato sotto il form.
  // privacy-policy.html è il template GDPR: ricordati di sostituire i
  // placeholder ({{NOME_LOCALE}}, {{INDIRIZZO}}, {{EMAIL_LOCALE}},
  // {{MESI_RETENTION}}) con i dati del locale prima di pubblicare.
  PRIVACY_URL: 'privacy-policy.html',
};
