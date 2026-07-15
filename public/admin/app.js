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
  clearLoginFormFields();
  await supabase.auth.signOut();
  clearSupabaseAuthStorage();
  location.replace('index.html');
}

function clearLoginFormFields() {
  document.querySelectorAll('input[type="email"], input[type="password"], input[name="email"], input[name="password"], #email, #password')
    .forEach((input) => { input.value = ''; });
}

function clearSupabaseAuthStorage() {
  try {
    const storages = [localStorage, sessionStorage].filter(Boolean);
    storages.forEach((storage) => {
      Object.keys(storage)
        .filter((key) => key.startsWith('sb-') || key.includes('supabase.auth'))
        .forEach((key) => storage.removeItem(key));
    });
  } catch (error) {
    console.warn('[auth] pulizia storage locale non riuscita:', error);
  }
}

let logoutModal;

export function confirmSignOut() {
  if (!logoutModal) {
    logoutModal = document.createElement('div');
    logoutModal.className = 'admin-confirm-modal';
    logoutModal.hidden = true;
    logoutModal.innerHTML = `
      <div class="admin-confirm-modal__overlay" data-logout-cancel></div>
      <section class="admin-confirm-modal__card" role="dialog" aria-modal="true" aria-labelledby="logoutConfirmTitle">
        <h2 class="admin-confirm-modal__title" id="logoutConfirmTitle">Uscire dal gestionale?</h2>
        <p class="admin-confirm-modal__text">Sei sicuro di voler uscire?</p>
        <div class="admin-confirm-modal__actions">
          <button class="btn btn--ghost" type="button" data-logout-cancel>Annulla</button>
          <button class="btn btn--primary admin-confirm-modal__danger" type="button" data-logout-confirm>Esci</button>
        </div>
      </section>
    `;
    document.body.appendChild(logoutModal);
    logoutModal.querySelectorAll('[data-logout-cancel]').forEach((node) =>
      node.addEventListener('click', closeLogoutConfirm));
    logoutModal.querySelector('[data-logout-confirm]')?.addEventListener('click', signOut);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && logoutModal && !logoutModal.hidden) closeLogoutConfirm();
    });
  }
  logoutModal.hidden = false;
  logoutModal.querySelector('[data-logout-cancel]')?.focus({ preventScroll: true });
}

function closeLogoutConfirm() {
  if (logoutModal) logoutModal.hidden = true;
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
  terminato: 'Terminato',
  no_show: 'Non presentato',
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

// --- Toast ----------------------------------------------------------------
let toastEl;
export function toast(msg, isError = false) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.toggle('toast--err', isError);
  toastEl.classList.add('is-show');
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.remove('is-show'), 2600);
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function initResponsiveAdminNav() {
  const toggle = document.getElementById('adminNavToggle');
  const menuButton = document.querySelector('.topbar__menu');
  const nav = document.querySelector('.topbar__nav');
  const venueName = document.getElementById('venueName');
  const userRole = document.getElementById('userRole');
  if (!toggle || !menuButton || !nav) return;

  const title = nav.querySelector('.topbar__nav-title');
  const role = nav.querySelector('.topbar__nav-role');
  const focusableSelector = 'a[href], button:not([disabled]), label[for], input:not([disabled]), [tabindex]:not([tabindex="-1"])';
  let lastFocus = null;

  menuButton.setAttribute('role', 'button');
  menuButton.setAttribute('tabindex', '0');
  menuButton.setAttribute('aria-controls', 'adminMobileNav');
  menuButton.setAttribute('aria-expanded', 'false');
  nav.id = nav.id || 'adminMobileNav';

  const syncDrawerHeader = () => {
    if (title) title.textContent = (venueName?.textContent || '').trim() || 'Gestionale';
    if (role) role.textContent = (userRole?.textContent || '').trim() || 'Amministratore';
  };

  const setOpenState = (isOpen) => {
    menuButton.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    document.body.classList.toggle('admin-nav-open', isOpen);
  };

  const openMenu = () => {
    lastFocus = document.activeElement;
    syncDrawerHeader();
    toggle.checked = true;
    setOpenState(true);
    window.setTimeout(() => {
      const first = nav.querySelector(focusableSelector);
      if (first) first.focus({ preventScroll: true });
    }, 30);
  };

  const closeMenu = ({ restoreFocus = true } = {}) => {
    if (!toggle.checked) return;
    toggle.checked = false;
    setOpenState(false);
    if (restoreFocus) {
      const target = lastFocus && document.contains(lastFocus) ? lastFocus : menuButton;
      target.focus({ preventScroll: true });
    }
  };

  const toggleMenu = () => {
    if (toggle.checked) closeMenu();
    else openMenu();
  };

  menuButton.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggleMenu();
    }
  });

  toggle.addEventListener('change', () => {
    if (toggle.checked) {
      lastFocus = document.activeElement;
      syncDrawerHeader();
      setOpenState(true);
    } else {
      setOpenState(false);
    }
  });

  nav.querySelectorAll('.topbar__link, #logoutBtn').forEach((item) => {
    item.addEventListener('click', () => closeMenu({ restoreFocus: false }));
  });

  nav.querySelectorAll('.topbar__nav-close').forEach((item) => {
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        closeMenu();
      }
    });
  });

  document.addEventListener('keydown', (event) => {
    if (!toggle.checked) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...nav.querySelectorAll(focusableSelector)]
      .filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  });

  [venueName, userRole].filter(Boolean).forEach((node) => {
    new MutationObserver(syncDrawerHeader).observe(node, { childList: true, subtree: true, characterData: true });
  });

  syncDrawerHeader();
  setOpenState(toggle.checked);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initResponsiveAdminNav, { once: true });
} else {
  initResponsiveAdminNav();
}
