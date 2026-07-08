// Service worker — Sistema Prenotazioni (PWA)
//
// Strategia:
//  * Asset statici (HTML/CSS/JS same-origin, font e librerie da CDN):
//    CACHE-FIRST — caricamento istantaneo e funzionamento offline.
//  * Chiamate a Supabase (*.supabase.co): NETWORK-FIRST — i dati devono essere
//    freschi; la cache è solo un fallback se si è offline.
//  * Navigazioni: network-first con fallback alla pagina in cache.
//
// Per rilasciare un aggiornamento degli asset, incrementa CACHE_VERSION.

const CACHE_VERSION = 'v6';
const CACHE = 'prenotazioni-' + CACHE_VERSION;

// App shell: file che (quando presenti) precarichiamo all'installazione.
// Precache resiliente: un file mancante non fa fallire l'installazione.
const CORE = [
  './index.html',
  './privacy.html',
  './privacy-policy.html',
  './cookie-policy.html',
  './booking-terms.html',
  './manifest.json',
  './assets/css/legal.css',
  './assets/css/theme.css',
  './assets/css/panel.css',
  './assets/icons/icon.svg',
  './assets/js/cookie-consent.js',
  './assets/js/legal.js',
  './assets/js/pwa.js',
  './admin/index.html',
  './admin/dashboard.html',
  './admin/upcoming.html',
  './admin/settings.html',
  './admin/stats.html',
  './admin/manifest.json',
  './admin/app.js',
  './admin/resui.js',
  './admin/dashboard.js',
  './admin/upcoming.js',
  './admin/settings.js',
  './admin/stats.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // allSettled: se un file non esiste (es. config.js non committato) non blocca.
    await Promise.allSettled(CORE.map((url) => cache.add(url)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // POST/RPC (incl. scritture Supabase) passano diretti

  const url = new URL(req.url);

  // Supabase: dati sempre freschi, cache solo come fallback offline.
  if (url.hostname.endsWith('supabase.co')) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Navigazioni tra pagine: prova la rete, altrimenti la versione in cache.
  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req));
    return;
  }

  // Tutto il resto (asset statici, font, librerie CDN): cache-first.
  event.respondWith(cacheFirst(req));
});

// Cache-first: se in cache la servo subito, altrimenti rete + salvo.
async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    putSafe(req, res);
    return res;
  } catch (err) {
    return cached || Response.error();
  }
}

// Network-first: provo la rete, salvo la copia; se offline uso la cache.
async function networkFirst(req) {
  try {
    const res = await fetch(req);
    putSafe(req, res);
    return res;
  } catch (err) {
    const cached = await caches.match(req);
    if (cached) return cached;
    throw err;
  }
}

// Salva in cache solo risposte valide (ok oppure opache da CDN).
function putSafe(req, res) {
  if (!res || (res.status !== 0 && !res.ok)) return;
  const copy = res.clone();
  caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
}
