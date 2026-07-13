// Modulo condiviso del pannello gestionale: client Supabase (con sessione
// persistente, a differenza del widget pubblico), guardia di autenticazione,
// risoluzione del locale corrente e utility comuni.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const CONFIG = window.APP_CONFIG || {};
const hasSupabaseConfig = !!(
  CONFIG.SUPABASE_URL &&
  !CONFIG.SUPABASE_URL.includes('xxxx') &&
  CONFIG.SUPABASE_ANON_KEY &&
  !CONFIG.SUPABASE_ANON_KEY.includes('...')
);

if (!hasSupabaseConfig) {
  console.error('[config] Supabase non configurato: /assets/js/config.js mancante o incompleto.');
}

export const supabase = hasSupabaseConfig
  ? createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true },
    })
  : null;

// --- Guardia auth: reindirizza al login se non c'è sessione ----------------
export async function requireSession() {
  if (!supabase) {
    document.body.innerHTML = '<div class="login-wrap"><div class="login-card"><h1>Configurazione mancante</h1><p class="sub">Impossibile caricare la configurazione del gestionale. Ricarica la pagina o verifica il deploy.</p></div></div>';
    return null;
  }
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    location.replace('index.html');
    return null;
  }
  return session;
}

export async function signOut() {
  await supabase.auth.signOut();
  location.replace('index.html');
}

// --- Locale corrente -------------------------------------------------------
// Un utente staff può appartenere a più locali (venue_staff). Per la fase
// pilota selezioniamo il primo; se in futuro servirà, qui si aggancia un
// selettore locale.
export async function loadCurrentVenue() {
  const { data, error } = await supabase
    .from('venue_staff')
    .select('role, venue:venues(id, name, slug, timezone, closed_weekdays, active)')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data || !data.venue) return null;
  return { role: data.role, venue: data.venue };
}

// --- Date helpers (ISO locale, senza slittamenti di fuso) ------------------
export function todayISO() {
  const d = new Date();
  return toISO(d);
}
export function toISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
export function isoToDate(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d, 12); }
export function addDays(iso, n) { const d = isoToDate(iso); d.setDate(d.getDate() + n); return toISO(d); }
export function isoDow(iso) { const d = isoToDate(iso); const g = d.getDay(); return g === 0 ? 7 : g; } // 1=lun..7=dom

const dfLong = new Intl.DateTimeFormat('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
export function formatLong(iso) { return dfLong.format(isoToDate(iso)); }
export const hhmm = (t) => (t || '').slice(0, 5);

export const STATUS_LABEL = {
  in_attesa: 'In attesa di conferma',
  confermata: 'Confermata',
  arrivato: 'Arrivato',
  no_show: 'No-show',
  annullata: 'Annullata',
};

export const WEEKDAYS = [
  { n: 1, short: 'Lun', long: 'Lunedì' },
  { n: 2, short: 'Mar', long: 'Martedì' },
  { n: 3, short: 'Mer', long: 'Mercoledì' },
  { n: 4, short: 'Gio', long: 'Giovedì' },
  { n: 5, short: 'Ven', long: 'Venerdì' },
  { n: 6, short: 'Sab', long: 'Sabato' },
  { n: 7, short: 'Dom', long: 'Domenica' },
];

// --- Feedback operatore ----------------------------------------------------
let toastWrap;
let audioCtx;
let notificationPrimed = false;

export function toast(msg, isError = false, options = {}) {
  if (!toastWrap) {
    toastWrap = document.createElement('div');
    toastWrap.className = 'toast-stack';
    toastWrap.setAttribute('aria-live', 'polite');
    toastWrap.setAttribute('aria-atomic', 'false');
    document.body.appendChild(toastWrap);
  }
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' toast--err' : '');
  el.setAttribute('role', isError ? 'alert' : 'status');
  el.innerHTML = `
    <span class="toast__icon">${isError ? '!' : options.icon || '✓'}</span>
    <span class="toast__body">
      ${options.title ? `<strong>${escapeHtml(options.title)}</strong>` : ''}
      <span>${escapeHtml(msg)}</span>
    </span>`;
  toastWrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add('is-show'));
  clearTimeout(el._t);
  el._t = setTimeout(() => {
    el.classList.remove('is-show');
    setTimeout(() => el.remove(), 220);
  }, options.duration || 3200);
}

export function notifyOperator(title, body, options = {}) {
  toast(body || title, false, { title: body ? title : '', icon: options.icon || '•' });
  playAlert(options.tone || 'soft');
  showDesktopNotification(title, body, options);
}

export function setRealtimeUpdating(active) {
  document.body.classList.toggle('is-realtime-updating', !!active);
}

function playAlert(tone = 'soft') {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(tone === 'urgent' ? 740 : 520, now);
    osc.frequency.exponentialRampToValueAtTime(tone === 'urgent' ? 880 : 660, now + 0.12);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.06, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.24);
  } catch (error) {
    console.debug('[operator-feedback] audio non disponibile:', error);
  }
}

function showDesktopNotification(title, body, options = {}) {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    const n = new Notification(title, {
      body,
      tag: options.tag || 'restaurant-operator',
      renotify: true,
      silent: true,
    });
    setTimeout(() => n.close(), 7000);
    return;
  }
  if (Notification.permission === 'default') primeDesktopNotifications();
}

function primeDesktopNotifications() {
  if (notificationPrimed || !('Notification' in window)) return;
  notificationPrimed = true;
  const ask = () => {
    if (Notification.permission === 'default') {
      const request = Notification.requestPermission();
      if (request && typeof request.catch === 'function') request.catch(() => {});
    }
    window.removeEventListener('click', ask);
    window.removeEventListener('keydown', ask);
  };
  window.addEventListener('click', ask, { once: true });
  window.addEventListener('keydown', ask, { once: true });
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
