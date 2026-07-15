// Dashboard gestionale: KPI, tab turni, lista prenotazioni con azioni di
// stato, mappa tavoli e inserimento manuale. Aggiornamento live via Supabase
// Realtime sulla tabella reservations.
import {
  supabase, requireSession, confirmSignOut, loadCurrentVenue,
  todayISO, addDays, isoDow, formatLong, hhmm, escapeHtml, toast,
  STATUS_LABEL,
} from './app.js';
import {
  createPartySizeUpdater, statusRank, reservationCardHtml, wirePartySizeEditing, wireReservationQuickActions, wireReservationTimers, wireRowActions, wireTableAssignment,
  waitlistCardHtml, wireWaitlistActions,
} from './resui.js';
import { createSharedCalendar } from '../assets/js/shared-calendar.js';

const $ = (id) => document.getElementById(id);
let dateCalendar = null;

const state = {
  session: null,
  venue: null,
  role: null,
  date: todayISO(),
  shiftId: null,
  slotKey: null,
  shifts: [],          // service_shifts attivi
  tables: [],          // restaurant_tables attivi (con zona)
  tablesById: new Map(),
  reservations: [],    // prenotazioni del giorno (tutti i turni)
  tableAssignments: new Map(),
  waitlist: [],        // voci in coda del giorno (status in_coda, tutti i turni)
  capacity: 0,         // somma seats_max tavoli attivi
  lastUpdatedAt: null,
};

const updatePartySize = createPartySizeUpdater({
  supabase,
  toast,
  getReservations: () => state.reservations,
  reload: loadDay,
  rerender: render,
});

// ---------------------------------------------------------------------------
// Avvio
// ---------------------------------------------------------------------------
async function init() {
  state.session = await requireSession();
  if (!state.session) return;

  $('logoutBtn').addEventListener('click', confirmSignOut);

  try {
    const current = await loadCurrentVenue();
    if (!current) {
      document.body.innerHTML = '<div class="login-wrap"><div class="login-card"><h1>Nessun locale</h1>' +
        '<p class="sub">Il tuo account non è collegato ad alcun locale. Contatta l\'amministratore.</p>' +
        '<button class="btn btn--ghost btn--block" onclick="location.href=\'index.html\'">Esci</button></div></div>';
      return;
    }
    state.venue = current.venue;
    state.role = current.role;
    $('venueName').textContent = current.venue.name;
    $('userRole').textContent = (current.role === 'owner' ? 'Titolare' : 'Staff') + ' · ' + (state.session.user.email || '');

    await loadConfig();
    wireControls();
    subscribeRealtime();
    await loadDay();

    $('pageSpinner').hidden = true;
    $('page').hidden = false;
  } catch (err) {
    console.error(err);
    $('pageSpinner').hidden = true;
    toast('Errore di caricamento. Ricarica la pagina.', true);
  }
}

// Config (turni + tavoli): cambia raramente, la carichiamo una volta.
async function loadConfig() {
  const [{ data: venue, error: e0 }, { data: shifts, error: e1 }, { data: tables, error: e2 }] = await Promise.all([
    supabase.from('venues').select('*').eq('id', state.venue.id).maybeSingle(),
    supabase.from('service_shifts').select('id, code, name, start_time, end_time, days_of_week, sort_order')
      .eq('venue_id', state.venue.id).eq('active', true).order('sort_order'),
    supabase.from('restaurant_tables').select('id, code, seats_max, zone:zones(id, name, sort_order)')
      .eq('venue_id', state.venue.id).eq('active', true),
  ]);
  if (e0) throw e0;
  if (e1) throw e1;
  if (e2) throw e2;

  if (venue) state.venue = { ...state.venue, ...venue };
  state.shifts = shifts || [];
  state.tables = (tables || []).sort((a, b) =>
    (a.zone?.sort_order - b.zone?.sort_order) || a.code.localeCompare(b.code, 'it', { numeric: true }));
  state.tablesById = new Map(state.tables.map((t) => [t.id, t]));
  state.capacity = state.tables.reduce((s, t) => s + (t.seats_max || 0), 0);

  ensureScheduleSelection();
  populateManualShiftSelect();
}

// ---------------------------------------------------------------------------
// Caricamento giornata
// ---------------------------------------------------------------------------
async function loadDay() {
  const [{ data, error }, waitlist] = await Promise.all([
    supabase
      .from('reservations')
      .select('id, reservation_date, shift_id, party_size, customer_first_name, customer_last_name, customer_phone, customer_email, notes, status, source, table_id, client_request_id, created_at')
      .eq('venue_id', state.venue.id)
      .eq('reservation_date', state.date)
      .order('created_at', { ascending: true }),
    loadWaitlist(),
  ]);
  if (error) throw error;

  state.reservations = await withTableAssignments(await withEmailVerificationStatus(data || []));
  state.waitlist = waitlist;
  state.lastUpdatedAt = new Date();
  render();
}

async function withTableAssignments(rows) {
  if (!rows.length) {
    state.tableAssignments = new Map();
    return rows;
  }
  try {
    const { data, error } = await supabase
      .from('reservation_tables')
      .select('reservation_id, table_id')
      .in('reservation_id', rows.map((r) => r.id));
    if (error) throw error;
    const byReservation = new Map();
    (data || []).forEach((row) => {
      if (!byReservation.has(row.reservation_id)) byReservation.set(row.reservation_id, []);
      byReservation.get(row.reservation_id).push(row.table_id);
    });
    state.tableAssignments = byReservation;
    return rows.map((row) => {
      const ids = byReservation.get(row.id);
      return { ...row, table_ids: ids?.length ? ids : (row.table_id ? [row.table_id] : []) };
    });
  } catch (error) {
    console.warn('[tables] assegnazioni multiple non disponibili:', error.message || error);
    state.tableAssignments = new Map();
    return rows.map((row) => ({ ...row, table_ids: row.table_id ? [row.table_id] : [] }));
  }
}

async function withEmailVerificationStatus(rows) {
  const candidates = rows.filter((r) => r.customer_email && r.client_request_id);
  if (!candidates.length) return rows.map((r) => ({ ...r, email_verified: false }));
  try {
    const { data, error } = await supabase
      .from('email_verification_codes')
      .select('client_request_id, email, verified_at')
      .eq('venue_id', state.venue.id)
      .in('client_request_id', candidates.map((r) => r.client_request_id));
    if (error) throw error;
    const verified = new Set((data || [])
      .filter((row) => row.verified_at)
      .map((row) => `${row.client_request_id}|${String(row.email || '').toLowerCase()}`));
    return rows.map((r) => ({
      ...r,
      email_verified: !!(r.customer_email && r.client_request_id && verified.has(`${r.client_request_id}|${String(r.customer_email).toLowerCase()}`)),
    }));
  } catch (e) {
    console.warn('[email-verification] stato non disponibile:', e.message || e);
    return rows.map((r) => ({ ...r, email_verified: false }));
  }
}

// Coda del giorno (solo voci ancora in_coda). Tollerante: se la migration della
// lista d'attesa non è ancora applicata, la sezione resta vuota invece di
// rompere il caricamento della dashboard.
async function loadWaitlist() {
  try {
    const { data, error } = await supabase
      .from('waitlist')
      .select('id, reservation_date, shift_id, party_size, customer_first_name, customer_last_name, customer_phone, notes, status, created_at')
      .eq('venue_id', state.venue.id)
      .eq('reservation_date', state.date)
      .eq('status', 'in_coda')
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data || [];
  } catch (e) {
    console.warn('[waitlist] non disponibile (migration applicata?):', e.message || e);
    return [];
  }
}

function render() {
  ensureScheduleSelection();
  $('dateLabel').textContent = formatLong(state.date);
  renderOperationalBar();
  renderKpis();
  renderTabs();
  renderOccupancyHeatmap();
  renderList();
  renderWaitlist();
  renderMap();
  populateManualShiftSelect();
}

function renderOperationalBar() {
  const bar = $('operationalBar');
  if (!bar) return;
  const items = scheduleItemsForDate(state.date);
  const now = new Date();
  const today = state.date === todayISO();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const currentItem = today
    ? items.find((item) => nowMinutes >= minutesOf(item.start_time) && nowMinutes < minutesOf(item.end_time))
    : null;
  const selectedItem = currentShift();
  const isOpen = !!currentItem;
  const activeReservations = state.reservations.filter((r) => r.status === 'confermata' || r.status === 'arrivato');
  const occupiedTableIds = new Set(activeReservations.flatMap(reservationTableIds));
  const confirmedCovers = activeReservations.reduce((sum, r) => sum + Number(r.party_size || 0), 0);
  const pendingCount = state.reservations.filter((r) => r.status === 'in_attesa').length;
  const shift = currentItem || selectedItem;
  const shiftLabel = shift
    ? (isFreeHourShift(shift) ? hhmm(shift.start_time) : (shift.name || 'Turno'))
    : null;
  const updatedAt = state.lastUpdatedAt
    ? state.lastUpdatedAt.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
    : null;

  const metrics = [
    { label: 'Stato locale', value: isOpen ? 'Aperto' : 'Chiuso', tone: isOpen ? 'ok' : 'muted' },
    shiftLabel ? { label: currentItem ? 'Turno attuale' : 'Turno selezionato', value: shiftLabel } : null,
    { label: 'Tavoli occupati', value: `${occupiedTableIds.size}/${state.tables.length}` },
    { label: 'Coperti', value: confirmedCovers },
    { label: 'In attesa', value: pendingCount },
    updatedAt ? { label: 'Aggiornato alle', value: updatedAt } : null,
  ].filter(Boolean);

  bar.innerHTML = metrics.map((item) => `
    <div class="opsbar__item${item.tone ? ` opsbar__item--${item.tone}` : ''}">
      <span class="opsbar__label">${escapeHtml(item.label)}</span>
      <strong class="opsbar__value">${escapeHtml(item.value)}</strong>
    </div>
  `).join('');
}

// ---------------------------------------------------------------------------
// KPI (sull'intera giornata)
// ---------------------------------------------------------------------------
function renderKpis() {
  const active = state.reservations.filter((r) => !['annullata', 'no_show', 'terminato'].includes(r.status));
  const confirmed = state.reservations.filter((r) => r.status === 'confermata' || r.status === 'arrivato');
  const covers = confirmed.reduce((s, r) => s + r.party_size, 0);
  const pending = state.reservations.filter((r) => r.status === 'in_attesa').length;
  const noShows = state.reservations.filter((r) => r.status === 'no_show').length;
  const completedTotal = confirmed.length + noShows;
  const noShowRate = completedTotal > 0 ? Math.round((noShows / completedTotal) * 100) + '%' : '—';

  // Capienza teorica del giorno = posti a sedere × numero di turni.
  const denom = state.capacity * Math.max(1, scheduleItemsForDate(state.date).length);
  const occ = denom > 0 ? Math.round((covers / denom) * 100) : 0;

  $('kpiCovers').textContent = covers;
  $('kpiCount').textContent = active.length;
  $('kpiOcc').textContent = occ + '%';
  $('kpiNextArrival').textContent = nextArrivalLabel(active);
  $('kpiPending').textContent = pending;
  $('kpiNoShowDay').textContent = noShowRate;
}

function nextArrivalLabel(rows) {
  const candidates = rows
    .filter((r) => r.status === 'confermata' || r.status === 'in_attesa')
    .map((r) => ({ reservation: r, shift: state.shifts.find((shift) => shift.id === r.shift_id) }))
    .filter((item) => item.shift)
    .sort((a, b) => minutesOf(a.shift.start_time) - minutesOf(b.shift.start_time));
  if (!candidates.length) return '—';
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const next = state.date === todayISO()
    ? candidates.find((item) => minutesOf(item.shift.start_time) >= nowMinutes) || candidates[0]
    : candidates[0];
  const name = `${next.reservation.customer_first_name || ''} ${next.reservation.customer_last_name || ''}`.trim();
  return `${hhmm(next.shift.start_time)} ${name || 'Prenotazione'}`;
}

// ---------------------------------------------------------------------------
// Tab turni
// ---------------------------------------------------------------------------
function normalizeScheduleMode(mode) {
  return mode === 'free' ? 'free' : 'shifts';
}

function bookingModeForDate(date) {
  if (state.venue?.booking_same_mode_all_days !== false) {
    return normalizeScheduleMode(state.venue?.booking_mode);
  }
  const modes = state.venue?.booking_mode_by_weekday || {};
  return normalizeScheduleMode(modes[isoDow(date)]);
}

function minutesOf(time) {
  const [hours, minutes] = String(time || '00:00').split(':').map(Number);
  return (hours || 0) * 60 + (minutes || 0);
}

function timeOf(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`;
}

function shiftsForDate(date) {
  const dow = isoDow(date);
  return state.shifts.filter((shift) => !Array.isArray(shift.days_of_week) || shift.days_of_week.includes(dow));
}

function scheduleItemsForDate(date) {
  const mode = bookingModeForDate(date);
  const shifts = shiftsForDate(date).filter((shift) => mode === 'free' ? isFreeHourShift(shift) : !isFreeHourShift(shift));
  if (bookingModeForDate(date) !== 'free') {
    return shifts.map((shift) => ({ ...shift, key: shift.id, shift_id: shift.id, mode: 'shifts' }));
  }
  return shifts.map((shift) => ({ ...shift, key: shift.id, shift_id: shift.id, mode: 'free' }));
}

function isFreeHourShift(shift) {
  return String(shift?.code || '').startsWith('free_');
}

function ensureScheduleSelection() {
  const items = scheduleItemsForDate(state.date);
  if (!items.length) {
    state.shiftId = null;
    state.slotKey = null;
    return;
  }
  const current = items.find((item) => item.key === state.slotKey && item.shift_id === state.shiftId);
  if (current) return;
  const sameShift = items.find((item) => item.shift_id === state.shiftId);
  const next = sameShift || items[0];
  state.shiftId = next.shift_id;
  state.slotKey = next.key;
}

function renderTabs() {
  const box = $('shiftTabs');
  box.innerHTML = '';
  for (const s of scheduleItemsForDate(state.date)) {
    const n = state.reservations.filter((r) => r.shift_id === s.shift_id && !['annullata', 'terminato'].includes(r.status)).length;
    const btn = document.createElement('button');
    btn.className = 'tab' + (s.key === state.slotKey ? ' is-active' : '');
    btn.innerHTML = isFreeHourShift(s)
      ? `<span class="tab__name">${hhmm(s.start_time)}</span>` +
        `<span class="tab__meta">${n} pren.</span>`
      : `<span class="tab__name">${escapeHtml(s.name)}</span>` +
        `<span class="tab__meta">${hhmm(s.start_time)}–${hhmm(s.end_time)} · ${n} pren.</span>`;
    btn.addEventListener('click', () => { state.shiftId = s.shift_id; state.slotKey = s.key; render(); });
    box.appendChild(btn);
  }
}

function currentShift() { return scheduleItemsForDate(state.date).find((s) => s.key === state.slotKey) || state.shifts.find((s) => s.id === state.shiftId); }

function renderOccupancyHeatmap() {
  const box = $('occupancyHeatmap');
  if (!box) return;
  const items = scheduleItemsForDate(state.date);
  if (!items.length) {
    box.innerHTML = '<div class="res-empty">Nessun turno configurato per questa data.</div>';
    return;
  }
  const capacity = Math.max(1, state.capacity);
  box.innerHTML = items.map((item) => {
    const covers = state.reservations
      .filter((r) => r.shift_id === item.shift_id && (r.status === 'confermata' || r.status === 'arrivato'))
      .reduce((sum, r) => sum + Number(r.party_size || 0), 0);
    const ratio = covers / capacity;
    const level = ratio >= 1 ? 'full' : ratio >= .75 ? 'high' : ratio >= .4 ? 'medium' : 'low';
    const label = isFreeHourShift(item) ? hhmm(item.start_time) : item.name;
    return `<button class="occupancy-cell occupancy-cell--${level}" type="button" data-shift="${escapeHtml(item.shift_id)}">
      <span>${escapeHtml(label)}</span>
      <strong>${covers}/${capacity}</strong>
    </button>`;
  }).join('');
  box.querySelectorAll('[data-shift]').forEach((button) =>
    button.addEventListener('click', () => {
      state.shiftId = button.dataset.shift;
      state.slotKey = button.dataset.shift;
      render();
    }));
}

// ---------------------------------------------------------------------------
// Lista prenotazioni del turno selezionato
// ---------------------------------------------------------------------------
function renderList() {
  const list = $('resList');
  const shift = currentShift();
  const rows = state.reservations
    .filter((r) => r.shift_id === state.shiftId)
    .sort((a, b) => statusRank(a.status) - statusRank(b.status) || a.customer_last_name.localeCompare(b.customer_last_name, 'it'));

  if (rows.length === 0) {
    list.innerHTML = '<div class="res-empty">Nessuna prenotazione per questo turno.</div>';
    return;
  }

  list.innerHTML = rows.map((r) => reservationCardHtml(r, {
    timeLabel: shift ? hhmm(shift.start_time) : '',
    tableCode: tableCodes(r),
    tableOptions: tableOptionsForReservation(r),
    canEditPartySize: true,
    capacityWarning: hasInsufficientAssignedCapacity(r),
  })).join('');

  wireRowActions(list, changeStatus);
  wireReservationQuickActions(list);
  wireReservationTimers(list);
  wirePartySizeEditing(list, updatePartySize);
  wireTableAssignment(list, assignTable);
}

async function changeStatus(id, to) {
  const res = state.reservations.find((r) => r.id === id);
  if (to === 'confermata' && res && !reservationTableIds(res).length) {
    toast('Assegna un tavolo prima di confermare la prenotazione.', true);
    return;
  }
  if (to === 'confermata' && res && hasInsufficientAssignedCapacity(res)) {
    toast('La capienza dei tavoli assegnati non è più sufficiente. Modifica l’assegnazione dei tavoli.', true);
    return;
  }
  const { error } = await supabase.from('reservations').update({ status: to }).eq('id', id);
  if (error) { console.error(error); toast('Impossibile aggiornare lo stato.', true); return; }
  toast('Stato aggiornato: ' + STATUS_LABEL[to]);
  if (res) await notifyCustomerStatusEmail(res, to);

  // Turno liberato: promuovi automaticamente il primo in lista d'attesa.
  if ((to === 'annullata' || to === 'no_show' || to === 'terminato') && res) {
    try {
      const { data, error: pe } = await supabase.rpc('promote_next_waitlist', {
        p_venue_id: state.venue.id, p_date: res.reservation_date, p_shift_id: res.shift_id,
      });
      if (pe) throw pe;
      notifyPromotion(Array.isArray(data) ? data[0] : data);
    } catch (e) { console.warn('[waitlist] promozione automatica non riuscita:', e.message || e); }
  }

  await loadDay(); // realtime aggiornerà anche gli altri dispositivi
}

function tableOptionsForReservation(reservation) {
  const occupied = new Set(state.reservations
    .filter((r) =>
      r.id !== reservation.id &&
      r.reservation_date === reservation.reservation_date &&
      r.shift_id === reservation.shift_id &&
      r.status !== 'annullata' &&
      r.status !== 'no_show' &&
      r.status !== 'terminato')
    .flatMap(reservationTableIds));
  const selected = new Set(reservationTableIds(reservation));

  return state.tables.map((table) => {
    const busy = occupied.has(table.id);
    return {
      id: table.id,
      code: table.code,
      seatsMax: table.seats_max,
      busy,
      disabled: busy && !selected.has(table.id),
      label: `${table.code} (${table.seats_max})${busy ? ' - occupato' : ''}`,
    };
  });
}

async function assignTable(id, tableIds) {
  try {
    const ids = Array.isArray(tableIds) ? tableIds : (tableIds ? [tableIds] : []);
    const { error } = await supabase.rpc('assign_reservation_tables', {
      p_reservation_id: id,
      p_table_ids: ids,
    });
    if (error) throw error;
    toast(ids.length > 1 ? 'Tavoli assegnati' : ids.length ? 'Tavolo assegnato' : 'Tavolo rimosso');
    await loadDay();
  } catch (error) {
    console.error('[tables] assegnazione tavolo fallita:', error);
    toast(tableAssignmentError(error), true);
  }
}

function tableAssignmentError(error) {
  const raw = `${error?.message || ''} ${error?.details || ''}`;
  if (raw.includes('CAPIENZA_INSUFFICIENTE')) return 'Seleziona altri tavoli: la capienza attuale non è sufficiente.';
  if (raw.includes('TAVOLO_NON_COMPATIBILE')) return 'Il tavolo non è compatibile con il numero di persone.';
  if (raw.includes('TAVOLO_GIA_ASSEGNATO')) return 'Questo tavolo è già assegnato nello stesso turno.';
  if (raw.includes('TAVOLO_NON_VALIDO')) return 'Tavolo non valido.';
  return 'Impossibile assegnare il tavolo.';
}

function assignedCapacity(reservation) {
  return reservationTableIds(reservation).reduce((sum, tableId) =>
    sum + Number(state.tablesById.get(tableId)?.seats_max || 0), 0);
}

function hasInsufficientAssignedCapacity(reservation) {
  return reservationTableIds(reservation).length > 0 && assignedCapacity(reservation) < Number(reservation.party_size || 0);
}

function reservationTableIds(reservation) {
  if (Array.isArray(reservation.table_ids) && reservation.table_ids.length) return reservation.table_ids;
  return reservation.table_id ? [reservation.table_id] : [];
}

function tableCodes(reservation) {
  const codes = reservationTableIds(reservation).map((id) => state.tablesById.get(id)?.code).filter(Boolean);
  return codes.length ? codes.join(' + ') : null;
}

async function notifyCustomerStatusEmail(reservation, status) {
  const emailStatus = status === 'confermata'
    ? 'confirmed'
    : status === 'annullata'
      ? 'rejected'
      : null;
  if (!emailStatus || !supabase.functions) {
    console.info('[notifications] send-customer-email non invocata per cambio stato:', {
      reservation_id: reservation?.id,
      status,
      hasFunctions: !!supabase.functions,
    });
    return;
  }
  try {
    const payload = {
      reservation_id: reservation.id,
      status: emailStatus,
      customer_email: reservation.customer_email || null,
      customer_first_name: reservation.customer_first_name || null,
      customer_last_name: reservation.customer_last_name || null,
      reservation_status: emailStatus,
      venue_name: state.venue?.name || null,
      reservation_date: reservation.reservation_date,
      reservation_time: reservation.shift_id ? (state.shifts.find((s) => s.id === reservation.shift_id)?.start_time || null) : null,
      party_size: reservation.party_size,
      fallback_email: reservation.customer_email || null,
      fallback_customer_name: `${reservation.customer_first_name || ''} ${reservation.customer_last_name || ''}`.trim(),
      fallback_notes: reservation.notes || null,
      fallback_phone: reservation.customer_phone || null,
    };
    console.info('[notifications] invoco send-customer-email per cambio stato:', payload);
    const { data, error } = await supabase.functions.invoke('send-customer-email', {
      body: payload,
    });
    if (error || data?.error || data?.sent === false) {
      console.error('[notifications] email cliente non inviata:', error || data);
      toast('Stato aggiornato, ma email cliente non inviata.', true);
      return;
    }
    console.info('[notifications] email cliente inviata:', { reservation_id: reservation.id, status: emailStatus, recipient: reservation.customer_email || data?.recipient, response: data });
  } catch (err) {
    console.error('[notifications] email cliente non inviata:', err);
    toast('Stato aggiornato, ma email cliente non inviata.', true);
  }
}

// ---------------------------------------------------------------------------
// Lista d'attesa
// ---------------------------------------------------------------------------
function renderWaitlist() {
  const list = $('wlList');
  const shift = currentShift();
  const rows = state.waitlist
    .filter((w) => w.shift_id === state.shiftId)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  $('wlCount').textContent = rows.length;

  if (rows.length === 0) {
    list.innerHTML = '<div class="res-empty">Nessuno in lista d\'attesa per questo turno.</div>';
    return;
  }

  list.innerHTML = rows.map((w, i) => waitlistCardHtml(w, i + 1, {
    shiftName: shift ? shift.name : '',
  })).join('');

  wireWaitlistActions(list, promoteWaitlist, removeWaitlist);
}

// Placeholder notifica: quando qualcuno viene promosso dalla coda, per ora
// logghiamo soltanto (in futuro qui parte un SMS/email di conferma al cliente).
function notifyPromotion(p) {
  if (!p) return;
  console.log(`NOTIFICA: ${p.first_name} ${p.last_name} promosso dalla lista d'attesa, tavolo da assegnare`);
  toast(`${p.first_name} promosso dalla lista d'attesa`);
}

async function promoteWaitlist(id) {
  const { data, error } = await supabase.rpc('promote_from_waitlist', { p_waitlist_id: id });
  if (error) { console.error(error); toast('Impossibile promuovere.', true); return; }
  notifyPromotion(Array.isArray(data) ? data[0] : data);
  await loadDay();
}

async function removeWaitlist(id) {
  const { error } = await supabase.from('waitlist').update({ status: 'rimossa' }).eq('id', id);
  if (error) { console.error(error); toast('Impossibile rimuovere dalla lista.', true); return; }
  toast('Rimosso dalla lista d\'attesa');
  await loadDay();
}

// ---------------------------------------------------------------------------
// Mappa tavoli (turno selezionato)
// ---------------------------------------------------------------------------
function renderMap() {
  const shift = currentShift();
  $('mapShiftName').textContent = shift ? shift.name : '';

  // Per ogni tavolo, lo stato "più forte" tra le prenotazioni del turno.
  const rank = { arrivato: 3, confermata: 2, in_attesa: 1 };
  const occ = new Map(); // tableId -> { status, guest }
  const joinedGroups = [];
  const joinedTableIds = new Set();
  for (const r of state.reservations) {
    const ids = reservationTableIds(r);
    if (r.shift_id !== state.shiftId || !ids.length) continue;
    if (!rank[r.status]) continue;
    const tables = ids.map((id) => state.tablesById.get(id)).filter(Boolean);
    if (tables.length > 1) {
      joinedGroups.push({ reservation: r, tables });
      tables.forEach((table) => joinedTableIds.add(table.id));
    }
    for (const tableId of ids) {
      const prev = occ.get(tableId);
      if (!prev || rank[r.status] > rank[prev.status]) {
        occ.set(tableId, { status: r.status, guest: `${r.customer_first_name} ${r.customer_last_name}`.trim() });
      }
    }
  }

  // Raggruppa per zona.
  const byZone = new Map();
  for (const t of state.tables) {
    const zid = t.zone?.id || 'z';
    if (!byZone.has(zid)) byZone.set(zid, { name: t.zone?.name || 'Sala', order: t.zone?.sort_order || 0, tables: [] });
    byZone.get(zid).tables.push(t);
  }
  const zones = [...byZone.values()].sort((a, b) => a.order - b.order);

  const map = $('tableMap');
  if (state.tables.length === 0) {
    map.innerHTML = '<div class="res-empty">Nessun tavolo configurato. Aggiungili in Impostazioni.</div>';
    return;
  }

  map.innerHTML = zones.map((z) => `
    <div class="zone">
      <p class="zone__name">${escapeHtml(z.name)}</p>
      <div class="table-grid">
        ${joinedGroups.filter((group) => (group.tables[0]?.zone?.id || 'z') === (z.tables[0]?.zone?.id || 'z')).map((group) => {
          const r = group.reservation;
          const seats = group.tables.reduce((sum, table) => sum + (table.seats_max || 0), 0);
          const codes = group.tables.map((table) => table.code).join(' + ');
          const cls = r.status === 'arrivato' ? 'tbl--arrivato' : r.status === 'confermata' ? 'tbl--occupato' : 'tbl--attesa';
          return `<div class="tbl tbl--joined ${cls}" style="grid-column: span ${Math.min(group.tables.length, 4)}">
            <span class="tbl__code">${escapeHtml(codes)}</span>
            <span class="tbl__seats">${seats} posti</span>
            <span class="tbl__guest">${escapeHtml(`${r.customer_first_name} ${r.customer_last_name}`.trim())}</span>
            <span class="tbl__seats">${escapeHtml(STATUS_LABEL[r.status] || r.status)}</span>
          </div>`;
        }).join('')}
        ${z.tables.map((t) => {
          if (joinedTableIds.has(t.id)) return '';
          const o = occ.get(t.id);
          const cls = o ? (o.status === 'arrivato' ? 'tbl--arrivato' : o.status === 'confermata' ? 'tbl--occupato' : 'tbl--attesa') : 'tbl--libero';
          return `<div class="tbl ${cls}">
            <span class="tbl__code">${escapeHtml(t.code)}</span>
            <span class="tbl__seats">${t.seats_max} posti</span>
            <span class="tbl__guest">${o ? escapeHtml(o.guest) : 'Libero'}</span>
          </div>`;
        }).join('')}
      </div>
    </div>`).join('');
}

// ---------------------------------------------------------------------------
// Prenotazione manuale
// ---------------------------------------------------------------------------
function populateManualShiftSelect() {
  const sel = $('mShift');
  sel.innerHTML = scheduleItemsForDate(state.date).map((s) =>
    `<option value="${s.shift_id}">${isFreeHourShift(s)
      ? hhmm(s.start_time)
      : `${escapeHtml(s.name)} (${hhmm(s.start_time)}–${hhmm(s.end_time)})`
    }</option>`).join('');
}

async function refreshManualTableSelect() {
  const sel = $('mTable');
  const shiftId = $('mShift').value;
  const party = parseInt($('mParty').value, 10) || 1;

  // Suggerimento automatico del tavolo più piccolo adatto e libero.
  let suggestedId = null;
  try {
    const { data } = await supabase.rpc('suggest_table', {
      p_venue_id: state.venue.id, p_date: state.date, p_shift_id: shiftId, p_party_size: party,
    });
    suggestedId = data || null;
  } catch (err) {
    console.error('[dashboard] suggerimento tavolo non disponibile:', err);
  }

  const opts = ['<option value="">— nessun tavolo —</option>'];
  for (const t of state.tables) {
    const fit = party <= t.seats_max;
    const label = `${t.code} (${t.seats_max})${fit ? '' : ' · non adatto'}`;
    opts.push(`<option value="${t.id}" ${t.id === suggestedId ? 'selected' : ''}>${label}</option>`);
  }
  sel.innerHTML = opts.join('');
}

function openManual() {
  $('manualForm').hidden = false;
  $('mShift').value = state.shiftId || (state.shifts[0]?.id ?? '');
  $('mError').hidden = true;
  refreshManualTableSelect();
  $('mFirst').focus();
}
function closeManual() { $('manualForm').hidden = true; $('mForm').reset(); }

async function submitManual(e) {
  e.preventDefault();
  const err = $('mError'); err.hidden = true;
  const payload = {
    venue_id: state.venue.id,
    reservation_date: state.date,
    shift_id: $('mShift').value,
    party_size: parseInt($('mParty').value, 10),
    customer_first_name: $('mFirst').value.trim(),
    customer_last_name: $('mLast').value.trim(),
    customer_phone: $('mPhone').value.trim(),
    notes: $('mNotes').value.trim() || null,
    table_id: $('mTable').value || null,
    source: 'manuale',
    status: 'in_attesa',
    created_by: state.session.user.id,
  };
  if (!payload.customer_first_name || !payload.customer_last_name || !payload.customer_phone) {
    err.textContent = 'Compila nome, cognome e telefono.'; err.hidden = false; return;
  }
  if (!payload.shift_id) { err.textContent = 'Seleziona un turno.'; err.hidden = false; return; }

  const btn = $('mSubmit'); btn.disabled = true; btn.textContent = 'Salvo…';
  const { error } = await supabase.from('reservations').insert(payload);
  btn.disabled = false; btn.textContent = 'Salva prenotazione';
  if (error) {
    console.error(error);
    err.textContent = 'Salvataggio non riuscito. Controlla i dati e riprova.'; err.hidden = false; return;
  }
  toast('Prenotazione aggiunta');
  closeManual();
  await loadDay();
}

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------
let reloadTimer;
function scheduleReload() { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => loadDay().catch(console.error), 250); }

function subscribeRealtime() {
  supabase.channel('res-' + state.venue.id)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'reservations', filter: `venue_id=eq.${state.venue.id}` },
      (payload) => {
        const rowDate = payload.new?.reservation_date || payload.old?.reservation_date;
        if (rowDate === state.date) {
          if (payload.eventType === 'INSERT' && payload.new?.source === 'widget') toast('Nuova prenotazione dal widget');
          scheduleReload();
        }
      })
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'waitlist', filter: `venue_id=eq.${state.venue.id}` },
      (payload) => {
        const rowDate = payload.new?.reservation_date || payload.old?.reservation_date;
        if (rowDate === state.date) {
          if (payload.eventType === 'INSERT') toast('Nuova richiesta in lista d\'attesa');
          scheduleReload();
        }
      })
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'reservation_tables' },
      () => scheduleReload())
    .subscribe();
}

// ---------------------------------------------------------------------------
// Controlli
// ---------------------------------------------------------------------------
function wireControls() {
  $('prevDay').addEventListener('click', () => { state.date = addDays(state.date, -1); loadDay().catch(console.error); });
  $('nextDay').addEventListener('click', () => { state.date = addDays(state.date, +1); loadDay().catch(console.error); });
  $('goToday').addEventListener('click', () => { state.date = todayISO(); loadDay().catch(console.error); });
  dateCalendar = createSharedCalendar({
    anchor: $('dateLabel'),
    getDate: () => state.date,
    onSelect: (date) => {
      state.date = date;
      loadDay().catch(console.error);
    },
  });
  $('dateLabel').setAttribute('role', 'button');
  $('dateLabel').setAttribute('tabindex', '0');
  $('dateLabel').setAttribute('aria-label', 'Scegli data');
  $('dateLabel').style.cursor = 'pointer';
  $('dateLabel').addEventListener('click', () => dateCalendar.open());
  $('dateLabel').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      dateCalendar.open();
    }
  });

  $('addBtn').addEventListener('click', () => ($('manualForm').hidden ? openManual() : closeManual()));
  $('mCancel').addEventListener('click', closeManual);
  $('mForm').addEventListener('submit', submitManual);
  $('mShift').addEventListener('change', refreshManualTableSelect);
  $('mParty').addEventListener('change', refreshManualTableSelect);
}

init();
