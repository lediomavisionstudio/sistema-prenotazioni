// Copia questo file in `config.js` (stessa cartella) e inserisci i valori del
// tuo progetto Supabase (Project Settings -> API). config.js e' in .gitignore.
//
// La ANON KEY e' pubblica per natura (viaggia nel browser): la sicurezza e'
// garantita dalle RLS policy, non dal tenerla segreta. Non inserire MAI qui
// la service_role key.
window.APP_CONFIG = {
  SUPABASE_URL: 'https://xxxxxxxxxxxx.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOi...',
  ONESIGNAL_APP_ID: '',

  // Slug del locale di default se non presente ?locale= nell'URL.
  // In produzione ogni locale riceve un link tipo: https://.../?locale=pizzeria-da-mario
  DEFAULT_VENUE_SLUG: 'pizzeria-da-mario',

  // Link alla privacy policy usata dalla checkbox obbligatoria del form.
  // Le pagine legali leggono da Supabase, quando disponibili: name,
  // legal_name, address, vat_number, contact_email, phone,
  // data_retention_months. I placeholder restano visibili se un dato manca.
  PRIVACY_URL: 'privacy-policy.html',
};
