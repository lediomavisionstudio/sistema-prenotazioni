import {
  supabase, requireSession, confirmSignOut, loadCurrentVenue, toast,
} from './app.js';

const $ = (id) => document.getElementById(id);

const state = {
  session: null,
  venue: null,
  role: null,
  canEdit: false,
};

function normalizeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function renderPreview(url = '') {
  const clean = normalizeUrl(url);
  const hasUrl = !!clean;
  $('menuPreviewTitle').textContent = hasUrl ? 'Menu collegato' : 'Menu non collegato';
  $('menuPreviewText').textContent = hasUrl
    ? 'Questo link sara visibile nella sezione Menu dell'interfaccia pubblica.'
    : 'Quando salvi un link, i clienti potranno aprirlo dal widget pubblico.';
  $('menuPreviewLink').hidden = !hasUrl;
  if (hasUrl) $('menuPreviewLink').href = clean;
}

function setReadonly() {
  const off = !state.canEdit;
  ['menuUrl', 'saveMenu', 'clearMenu'].forEach((id) => { $(id).disabled = off; });
}

async function loadMenu() {
  const { data, error } = await supabase
    .from('venues')
    .select('id, menu_url')
    .eq('id', state.venue.id)
    .maybeSingle();
  if (error) throw error;
  const url = data?.menu_url || '';
  $('menuUrl').value = url;
  renderPreview(url);
}

async function saveMenu(url) {
  if (!state.canEdit) {
    toast('Solo il titolare puo modificare il menu.', true);
    return;
  }
  const normalized = normalizeUrl(url);
  if (normalized === null) {
    toast('Inserisci un URL valido che inizi con http:// o https://.', true);
    return;
  }
  const { data, error } = await supabase
    .from('venues')
    .update({ menu_url: normalized || null })
    .eq('id', state.venue.id)
    .select('id');
  if (error) {
    console.error('[menu] salvataggio menu fallito:', error);
    toast('Salvataggio menu non riuscito.', true);
    return;
  }
  if (!data || !data.length) {
    toast('Nessuna modifica salvata: permesso negato.', true);
    return;
  }
  $('menuUrl').value = normalized;
  renderPreview(normalized);
  toast(normalized ? 'Menu salvato.' : 'Link menu rimosso.');
}

async function init() {
  state.session = await requireSession();
  if (!state.session) return;
  $('logoutBtn').addEventListener('click', confirmSignOut);

  try {
    const current = await loadCurrentVenue();
    if (!current) { location.replace('dashboard.html'); return; }
    state.venue = current.venue;
    state.role = current.role;
    state.canEdit = current.role === 'owner';
    $('venueName').textContent = current.venue.name;
    $('userRole').textContent = (current.role === 'owner' ? 'Titolare' : 'Staff') + ' · ' + (state.session.user.email || '');

    await loadMenu();
    setReadonly();

    $('menuUrl').addEventListener('input', () => renderPreview($('menuUrl').value));
    $('saveMenu').addEventListener('click', () => saveMenu($('menuUrl').value));
    $('clearMenu').addEventListener('click', () => saveMenu(''));

    $('pageSpinner').hidden = true;
    $('page').hidden = false;
  } catch (err) {
    console.error('[menu] caricamento pagina menu fallito:', err);
    $('pageSpinner').hidden = true;
    toast(err.message?.includes('menu_url')
      ? 'Applica prima la migration del database per attivare il menu.'
      : 'Errore di caricamento menu.', true);
  }
}

init();
