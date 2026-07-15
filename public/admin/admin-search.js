import { supabase, requireSession, loadCurrentVenue, hhmm, escapeHtml, formatLong } from './app.js';

const SEARCH_LIMIT = 160;
let cache = [];
let loadedAt = 0;
let venue = null;
let debounceTimer;

function normalize(value) {
  return String(value || '').toLowerCase().trim();
}

function tableCode(row) {
  return row.table_code || '';
}

function shiftLabel(row) {
  return `${row.shift_name || ''} ${hhmm(row.shift_start_time)}`.trim();
}

function searchableText(row) {
  return [
    row.customer_first_name,
    row.customer_last_name,
    `${row.customer_first_name || ''} ${row.customer_last_name || ''}`,
    row.customer_phone,
    row.customer_email,
    tableCode(row),
    row.notes,
    row.reservation_date,
    shiftLabel(row),
  ].map(normalize).join(' ');
}

async function ensureData() {
  const now = Date.now();
  if (cache.length && now - loadedAt < 60_000) return cache;
  if (!venue) {
    const current = await loadCurrentVenue();
    venue = current?.venue || null;
  }
  if (!venue) return [];
  const [reservations, shifts, tables] = await Promise.all([
    supabase
      .from('reservations')
      .select('id, reservation_date, shift_id, table_id, party_size, customer_first_name, customer_last_name, customer_phone, customer_email, notes, status')
      .eq('venue_id', venue.id)
      .order('reservation_date', { ascending: false })
      .limit(SEARCH_LIMIT),
    supabase
      .from('service_shifts')
      .select('id, name, start_time')
      .eq('venue_id', venue.id),
    supabase
      .from('restaurant_tables')
      .select('id, code')
      .eq('venue_id', venue.id),
  ]);
  if (reservations.error) throw reservations.error;
  if (shifts.error) throw shifts.error;
  if (tables.error) throw tables.error;
  const shiftsById = new Map((shifts.data || []).map((shift) => [shift.id, shift]));
  const tablesById = new Map((tables.data || []).map((table) => [table.id, table]));
  cache = (reservations.data || []).map((row) => {
    const shift = shiftsById.get(row.shift_id);
    const table = tablesById.get(row.table_id);
    return {
      ...row,
      shift_name: shift?.name || '',
      shift_start_time: shift?.start_time || '',
      table_code: table?.code || '',
    };
  });
  loadedAt = now;
  return cache;
}

function targetFor(row) {
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return row.reservation_date === todayIso ? 'dashboard.html' : 'upcoming.html';
}

function renderResults(root, rows, query) {
  const panel = root.querySelector('[data-global-search-results]');
  if (!query) {
    panel.hidden = true;
    panel.innerHTML = '';
    return;
  }
  if (!rows.length) {
    panel.hidden = false;
    panel.innerHTML = '<div class="global-search__empty">Nessun risultato trovato.</div>';
    return;
  }
  panel.hidden = false;
  panel.innerHTML = rows.slice(0, 8).map((row) => {
    const name = `${row.customer_last_name || ''} ${row.customer_first_name || ''}`.trim() || 'Prenotazione';
    const meta = [
      formatLong(row.reservation_date),
      shiftLabel(row),
      `${row.party_size || 0} persone`,
      tableCode(row) ? `Tavolo ${tableCode(row)}` : null,
    ].filter(Boolean).join(' · ');
    return `<a class="global-search__result" href="${targetFor(row)}" data-search-result="${escapeHtml(row.id)}">
      <strong>${escapeHtml(name)}</strong>
      <span>${escapeHtml(meta)}</span>
    </a>`;
  }).join('');
}

async function runSearch(root) {
  const input = root.querySelector('[data-global-search-input]');
  const query = normalize(input?.value);
  if (!query || query.length < 2) {
    renderResults(root, [], query);
    return;
  }
  try {
    const rows = await ensureData();
    renderResults(root, rows.filter((row) => searchableText(row).includes(query)), query);
  } catch (error) {
    console.error('[admin-search] ricerca non disponibile:', error);
    const panel = root.querySelector('[data-global-search-results]');
    panel.hidden = false;
    panel.innerHTML = '<div class="global-search__empty">Ricerca non disponibile.</div>';
  }
}

function mountSearch() {
  const inner = document.querySelector('.topbar__inner');
  const nav = document.querySelector('.topbar__nav');
  if (!inner || !nav || document.querySelector('[data-global-search]')) return;

  const root = document.createElement('div');
  root.className = 'global-search';
  root.dataset.globalSearch = '';
  root.innerHTML = `
    <label class="global-search__box">
      <span aria-hidden="true">⌕</span>
      <input data-global-search-input type="search" placeholder="Cerca prenotazioni" autocomplete="off" />
      <kbd>Ctrl K</kbd>
    </label>
    <div class="global-search__results" data-global-search-results hidden></div>
  `;
  inner.insertBefore(root, nav);

  const input = root.querySelector('[data-global-search-input]');
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => runSearch(root), 180);
  });
  input.addEventListener('focus', () => {
    if (input.value.trim().length >= 2) runSearch(root);
  });
  document.addEventListener('click', (event) => {
    if (!root.contains(event.target)) root.querySelector('[data-global-search-results]').hidden = true;
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') root.querySelector('[data-global-search-results]').hidden = true;
  });
}

(async function initGlobalSearch() {
  const session = await requireSession();
  if (!session) return;
  mountSearch();
})();
