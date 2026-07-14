// Dashboard gestionale: KPI, tab turni, lista prenotazioni con azioni di
// stato, mappa tavoli e inserimento manuale. Aggiornamento live via Supabase
// Realtime sulla tabella reservations.
import {
  supabase, requireSession, signOut, loadCurrentVenue,
  todayISO, addDays, isoDow, formatLong, hhmm, escapeHtml, toast,
  STATUS_LABEL, notifyOperator, setRealtimeUpdating,
} from './app.js';
import {
  statusRank, reservationCardHtml, wireRowActions, wireTableAssignment,
  waitlistCardHtml, wireWaitlistActions,
} from './resui.js';
import { initCustomerCrm, wireCustomerCards } from './customer-crm.js';
import { initReservationCalendar, refreshReservationCalendar } from './reservation-calendar.js';
import { initPrintExport } from './print-export.js';

const $ = (id) => document.getElementById(id);
const LIVE_IMMINENT_MINUTES = 45;
const LIVE_TOO_LONG_MINUTES = 120;
let dayChartInstance = null;

const state = {
  session: null,
  venue: null,
  role: null,
  date: todayISO(),
  shiftId: null,
  shifts: [],          // service_shifts attivi
  tables: [],          // restaurant_tables attivi (con zona)
  tablesById: new Map(),
  reservations: [],    // prenotazioni del giorno (tutti i turni)
  waitlist: [],        // voci in coda del giorno (status in_coda, tutti i turni)
  capacity: 0,         // somma seats_max tavoli attivi
  search: '',
  selectedTableId: null,
};

// ---------------------------------------------------------------------------
// Avvio
// ---------------------------------------------------------------------------
async function init() {
  state.session = await requireSession();
  if (!state.session) return;

  $('logoutBtn').addEventListener('click', signOut);

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

    initDashboardChrome();

    await loadConfig();
    initCustomerCrm({ supabase, state, toast });
    initReservationCalendar({ supabase, state, $, toast, escapeHtml, formatLong, hhmm, addDays, reloadDay: loadDay });
    initPrintExport({ state, $, toast, escapeHtml, formatLong, hhmm, STATUS_LABEL });
    wireControls();
    subscribeRealtime();
    setInterval(() => renderMap(), 60000);
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
  const [{ data: shifts, error: e1 }, { data: tables, error: e2 }] = await Promise.all([
    supabase.from('service_shifts').select('id, code, name, start_time, end_time, days_of_week, sort_order')
      .eq('venue_id', state.venue.id).eq('active', true).order('sort_order'),
    supabase.from('restaurant_tables').select('id, code, seats_min, seats_max, active, layout_x, layout_y, layout_width, layout_height, layout_rotation, layout_shape, layout_color, layout_locked, operational_status, operational_updated_at, service_group_id, zone:zones(id, name, sort_order)')
      .eq('venue_id', state.venue.id),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;

  state.shifts = shifts || [];
  state.tables = (tables || []).sort((a, b) =>
    (a.zone?.sort_order - b.zone?.sort_order) || a.code.localeCompare(b.code, 'it', { numeric: true }));
  state.tablesById = new Map(state.tables.map((t) => [t.id, t]));
  state.capacity = state.tables.filter((t) => t.active !== false).reduce((s, t) => s + (t.seats_max || 0), 0);

  if (!state.shiftId && state.shifts.length) state.shiftId = state.shifts[0].id;
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

  state.reservations = await withEmailVerificationStatus(data || []);
  state.waitlist = waitlist;
  render();
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
  $('dateLabel').textContent = formatLong(state.date);
  renderRestaurantHome();
  renderKpis();
  renderTabs();
  renderList();
  renderWaitlist();
  renderMap();
  refreshReservationCalendar();
}

// ---------------------------------------------------------------------------
// KPI (sull'intera giornata)
// ---------------------------------------------------------------------------
function renderKpis() {
  const active = state.reservations.filter((r) => r.status !== 'annullata');
  const confirmed = state.reservations.filter((r) => r.status === 'confermata' || r.status === 'arrivato');
  const covers = confirmed.reduce((s, r) => s + r.party_size, 0);

  // Capienza teorica del giorno = posti a sedere × numero di turni.
  const denom = state.capacity * Math.max(1, state.shifts.length);
  const occ = denom > 0 ? Math.round((covers / denom) * 100) : 0;

  $('kpiCovers').textContent = covers;
  $('kpiCount').textContent = active.length;
  $('kpiOcc').textContent = occ + '%';
}

function renderRestaurantHome() {
  const active = state.reservations.filter((r) => r.status !== 'annullata' && r.status !== 'no_show');
  const confirmed = state.reservations.filter((r) => r.status === 'confermata' || r.status === 'arrivato');
  const shiftRows = active.filter((r) => r.shift_id === state.shiftId);
  const occupiedTableIds = new Set(active.filter((r) => r.table_id).map((r) => r.table_id));
  const activeTables = state.tables.filter((t) => t.active !== false);
  const denom = state.capacity * Math.max(1, state.shifts.length);
  const coversToday = active.reduce((sum, r) => sum + (r.party_size || 0), 0);
  const coversShift = shiftRows.reduce((sum, r) => sum + (r.party_size || 0), 0);
  const coversConfirmed = confirmed.reduce((sum, r) => sum + (r.party_size || 0), 0);
  const occupancy = denom > 0 ? Math.round((coversConfirmed / denom) * 100) : 0;

  $('dashCoversToday').textContent = coversToday;
  $('dashCoversShift').textContent = coversShift;
  $('dashOccupancy').textContent = occupancy + '%';
  $('dashTablesFree').textContent = Math.max(0, activeTables.length - occupiedTableIds.size);
  $('dashTablesBusy').textContent = occupiedTableIds.size;
  $('dashPending').textContent = state.reservations.filter((r) => r.status === 'in_attesa').length;
  const confirmedMetric = $('dashConfirmed');
  if (confirmedMetric) confirmedMetric.textContent = confirmed.length;
  $('dashWaitlist').textContent = state.waitlist.length;

  renderNextArrival(active);
  renderDayChart(active);
  renderDayTimeline(active);
}

function renderNextArrival(activeRows) {
  const now = new Date();
  const today = todayISO();
  const rows = activeRows
    .map((r) => ({ ...r, shift: state.shifts.find((s) => s.id === r.shift_id) }))
    .filter((r) => r.shift)
    .sort((a, b) => (a.reservation_date + a.shift.start_time).localeCompare(b.reservation_date + b.shift.start_time));
  const next = rows.find((r) => {
    if (r.reservation_date > today) return true;
    if (r.reservation_date < today) return false;
    const [h, m] = String(r.shift.start_time || '00:00').split(':').map(Number);
    const d = new Date(); d.setHours(h || 0, m || 0, 0, 0);
    return d >= now;
  }) || rows[0];

  $('nextArrival').innerHTML = next
    ? `<div><strong>${escapeHtml(next.customer_last_name)} ${escapeHtml(next.customer_first_name || '')}</strong>
        <span>${escapeHtml(formatLong(next.reservation_date))} · ${hhmm(next.shift.start_time)} · ${next.party_size} coperti</span></div>
       <span class="badge badge--${next.status}">${escapeHtml(STATUS_LABEL[next.status] || next.status)}</span>`
    : '<div><strong>Nessun arrivo previsto</strong><span>La giornata è libera o non ci sono prenotazioni attive.</span></div>';
}

function renderDayChart(activeRows) {
  const target = $('dayChart');
  const rows = state.shifts.map((s) => ({
    label: s.name,
    covers: activeRows.filter((r) => r.shift_id === s.id).reduce((sum, r) => sum + (r.party_size || 0), 0),
  }));

  if (!rows.length) {
    if (dayChartInstance) dayChartInstance.destroy();
    dayChartInstance = null;
    target.innerHTML = '<div class="res-empty">Nessun turno configurato.</div>';
    return;
  }

  if (window.Chart) {
    if (dayChartInstance) dayChartInstance.destroy();
    target.innerHTML = '<canvas id="dayChartCanvas" aria-label="Grafico coperti per turno" role="img"></canvas>';
    const ctx = $('dayChartCanvas');
    dayChartInstance = new window.Chart(ctx, {
      type: 'bar',
      data: {
        labels: rows.map((row) => row.label),
        datasets: [{
          label: 'Coperti',
          data: rows.map((row) => row.covers),
          borderRadius: 12,
          borderSkipped: false,
          backgroundColor: ['#c8402a', '#2f8f72', '#2d74d6', '#e6a23c'],
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 260, easing: 'easeOutQuart' },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(18, 21, 19, .92)',
            padding: 12,
            cornerRadius: 12,
            displayColors: false,
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#7b8279', font: { weight: 700 } } },
          y: { beginAtZero: true, grid: { color: 'rgba(127, 135, 127, .14)' }, ticks: { precision: 0, color: '#7b8279' } },
        },
      },
    });
    return;
  }

  const max = Math.max(1, ...rows.map((row) => row.covers));
  target.innerHTML = rows.map((row) => `<div class="day-chart__row">
    <span>${escapeHtml(row.label)}</span>
    <div><i style="width:${Math.max(4, Math.round((row.covers / max) * 100))}%"></i></div>
    <strong>${row.covers}</strong>
  </div>`).join('');
}

function renderDayTimeline(activeRows) {
  const rows = activeRows
    .map((r) => ({ ...r, shift: state.shifts.find((s) => s.id === r.shift_id) }))
    .sort((a, b) => String(a.shift?.start_time || '').localeCompare(String(b.shift?.start_time || '')));
  $('dayTimeline').innerHTML = rows.length
    ? rows.map((r) => `<div class="timeline-item timeline-item--${escapeHtml(r.status)}">
        <time>${r.shift ? hhmm(r.shift.start_time) : '--:--'}</time>
        <div><strong>${escapeHtml(r.customer_last_name)} ${escapeHtml(r.customer_first_name || '')}</strong>
        <span>${r.party_size} coperti · ${escapeHtml(STATUS_LABEL[r.status] || r.status)}${r.table_id ? ' · Tavolo ' + escapeHtml(state.tablesById.get(r.table_id)?.code || '') : ''}</span></div>
      </div>`).join('')
    : '<div class="res-empty">Nessuna prenotazione attiva nella timeline.</div>';
}

// ---------------------------------------------------------------------------
// Tab turni
// ---------------------------------------------------------------------------
function renderTabs() {
  const box = $('shiftTabs');
  box.innerHTML = '';
  for (const s of state.shifts) {
    const n = state.reservations.filter((r) => r.shift_id === s.id && r.status !== 'annullata').length;
    const btn = document.createElement('button');
    btn.className = 'tab' + (s.id === state.shiftId ? ' is-active' : '');
    btn.innerHTML =
      `<span class="tab__name">${escapeHtml(s.name)}</span>` +
      `<span class="tab__meta">${hhmm(s.start_time)}–${hhmm(s.end_time)} · ${n} pren.</span>`;
    btn.addEventListener('click', () => { state.shiftId = s.id; state.selectedTableId = null; render(); });
    box.appendChild(btn);
  }
}

function currentShift() { return state.shifts.find((s) => s.id === state.shiftId); }

// ---------------------------------------------------------------------------
// Lista prenotazioni del turno selezionato
// ---------------------------------------------------------------------------
function renderList() {
  const list = $('resList');
  const shift = currentShift();
  const rows = state.reservations
    .filter((r) => r.shift_id === state.shiftId)
    .filter((r) => matchesReservationSearch(r, state.search))
    .sort((a, b) => statusRank(a.status) - statusRank(b.status) || a.customer_last_name.localeCompare(b.customer_last_name, 'it'));

  if (rows.length === 0) {
    list.innerHTML = state.search
      ? '<div class="res-empty">Nessuna prenotazione corrisponde alla ricerca.</div>'
      : '<div class="res-empty">Nessuna prenotazione per questo turno.</div>';
    return;
  }

  list.innerHTML = rows.map((r) => reservationCardHtml(r, {
    timeLabel: shift ? hhmm(shift.start_time) : '',
    tableCode: r.table_id ? state.tablesById.get(r.table_id)?.code : null,
    tableOptions: tableOptionsForReservation(r),
  })).join('');

  wireRowActions(list, changeStatus);
  wireTableAssignment(list, assignTable);
  wireCustomerCards(list, state.reservations);
}

function matchesReservationSearch(reservation, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const tableCode = reservation.table_id ? state.tablesById.get(reservation.table_id)?.code : '';
  return [
    reservation.customer_first_name,
    reservation.customer_last_name,
    reservation.customer_phone,
    reservation.customer_email,
    reservation.notes,
    reservation.status,
    tableCode,
  ].some((value) => String(value || '').toLowerCase().includes(q));
}

async function changeStatus(id, to) {
  const res = state.reservations.find((r) => r.id === id);
  if (to === 'confermata' && res && !res.table_id) {
    toast('Assegna un tavolo prima di confermare la prenotazione.', true);
    return;
  }
  const { error } = await supabase.from('reservations').update({ status: to }).eq('id', id);
  if (error) { console.error(error); toast('Impossibile aggiornare lo stato.', true); return; }
  toast('Stato aggiornato: ' + STATUS_LABEL[to]);
  if (res) await notifyCustomerStatusEmail(res, to);

  // Turno liberato: promuovi automaticamente il primo in lista d'attesa.
  if ((to === 'annullata' || to === 'no_show') && res) {
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
      r.table_id &&
      r.reservation_date === reservation.reservation_date &&
      r.shift_id === reservation.shift_id &&
      r.status !== 'annullata' &&
      r.status !== 'no_show')
    .map((r) => r.table_id));

  return state.tables.filter((table) => table.active !== false).map((table) => {
    const fits = reservation.party_size >= table.seats_min && reservation.party_size <= table.seats_max;
    const busy = occupied.has(table.id);
    return {
      id: table.id,
      disabled: (!fits || busy) && table.id !== reservation.table_id,
      label: `${table.code} (${table.seats_min}-${table.seats_max})${fits ? '' : ' - non adatto'}${busy ? ' - occupato' : ''}`,
    };
  });
}

async function assignTable(id, tableId) {
  try {
    const { error } = await supabase.rpc('assign_reservation_table', {
      p_reservation_id: id,
      p_table_id: tableId,
    });
    if (error) throw error;
    toast(tableId ? 'Tavolo assegnato' : 'Tavolo rimosso');
    await loadDay();
  } catch (error) {
    console.error('[tables] assegnazione tavolo fallita:', error);
    toast(tableAssignmentError(error), true);
  }
}

function tableAssignmentError(error) {
  const raw = `${error?.message || ''} ${error?.details || ''}`;
  if (raw.includes('TAVOLO_NON_COMPATIBILE')) return 'Il tavolo non è compatibile con il numero di persone.';
  if (raw.includes('TAVOLO_GIA_ASSEGNATO')) return 'Questo tavolo è già assegnato nello stesso turno.';
  if (raw.includes('TAVOLO_NON_VALIDO')) return 'Tavolo non valido.';
  return 'Impossibile assegnare il tavolo.';
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
function renderLegacyTableMap() {
  const shift = currentShift();
  $('mapShiftName').textContent = shift ? shift.name : '';

  // Per ogni tavolo, lo stato "più forte" tra le prenotazioni del turno.
  const rank = { arrivato: 3, confermata: 2, in_attesa: 1 };
  const occ = new Map(); // tableId -> { status, guest }
  for (const r of state.reservations) {
    if (r.shift_id !== state.shiftId || !r.table_id) continue;
    if (!rank[r.status]) continue;
    const prev = occ.get(r.table_id);
    if (!prev || rank[r.status] > rank[prev.status]) {
      occ.set(r.table_id, { status: r.status, guest: r.customer_last_name });
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
        ${z.tables.map((t) => {
          const o = occ.get(t.id);
          const cls = o ? (o.status === 'arrivato' ? 'tbl--arrivato' : o.status === 'confermata' ? 'tbl--occupato' : 'tbl--attesa') : 'tbl--libero';
          return `<div class="tbl ${cls}">
            <span class="tbl__code">${escapeHtml(t.code)}</span>
            <span class="tbl__seats">${t.seats_min}–${t.seats_max} posti</span>
            <span class="tbl__guest">${o ? escapeHtml(o.guest) : 'Libero'}</span>
          </div>`;
        }).join('')}
      </div>
    </div>`).join('');
}

// ---------------------------------------------------------------------------
// Sala operativa
// ---------------------------------------------------------------------------
function renderMap() {
  const shift = currentShift();
  $('mapShiftName').textContent = shift ? shift.name : '';

  const map = $('tableMap');
  if (state.tables.length === 0) {
    map.innerHTML = '<div class="res-empty">Nessun tavolo configurato. Aggiungili in Impostazioni.</div>';
    $('opsReservations').innerHTML = '';
    return;
  }

  const occupancy = tableOccupancy();
  renderReservationTray(occupancy);
  const positioned = state.tables.some((t) => t.layout_x !== null && t.layout_x !== undefined);
  map.className = positioned ? 'ops-map ops-map--floor' : 'ops-map';
  map.innerHTML = positioned
    ? `<div class="ops-floor">${state.tables.map((t, i) => liveTableHtml(t, occupancy.get(t.id), i)).join('')}</div>`
    : `<div class="table-grid">${state.tables.map((t, i) => liveTableHtml(t, occupancy.get(t.id), i)).join('')}</div>`;

  map.querySelectorAll('[data-table-id]').forEach((node) => {
    node.addEventListener('click', () => openTablePanel(node.dataset.tableId));
    node.addEventListener('dragover', (event) => {
      event.preventDefault();
      node.classList.add('is-drop');
    });
    node.addEventListener('dragleave', () => node.classList.remove('is-drop'));
    node.addEventListener('drop', (event) => {
      event.preventDefault();
      node.classList.remove('is-drop');
      const reservationId = event.dataTransfer.getData('text/reservation-id');
      if (reservationId) assignReservationToTable(reservationId, node.dataset.tableId);
    });
  });

  map.querySelectorAll('[data-live-status]').forEach((button) =>
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const table = state.tablesById.get(button.dataset.tableId);
      const reservation = occupancy.get(button.dataset.tableId);
      if (!table) return;
      const status = button.dataset.liveStatus || null;
      if (status === 'clear') clearTable(table, reservation);
      else setTableOperationalStatus(table.id, status, reservation);
    }));

  wireReservationDrag(map);
  renderTablePanel();
}

function tableOccupancy() {
  const rank = { arrivato: 3, confermata: 2, in_attesa: 1 };
  const occ = new Map();
  for (const r of state.reservations) {
    if (r.shift_id !== state.shiftId || !r.table_id || !rank[r.status]) continue;
    const prev = occ.get(r.table_id);
    if (!prev || rank[r.status] > rank[prev.status]) occ.set(r.table_id, r);
  }
  return occ;
}

function renderReservationTray(occupancy) {
  const assigned = new Set([...occupancy.values()].map((r) => r.id));
  const rows = state.reservations
    .filter((r) => r.shift_id === state.shiftId && r.status !== 'annullata' && r.status !== 'no_show')
    .sort((a, b) => statusRank(a.status) - statusRank(b.status) || a.customer_last_name.localeCompare(b.customer_last_name, 'it'));
  $('opsReservations').innerHTML = rows.length
    ? rows.map((r) => `<button class="ops-chip ${assigned.has(r.id) ? 'is-assigned' : ''}" draggable="true" data-res-drag="${escapeHtml(r.id)}" type="button">
        <strong>${escapeHtml(r.customer_last_name)} ${escapeHtml(r.customer_first_name || '')}</strong>
        <span>${r.party_size} pax${r.table_id ? ' · T ' + escapeHtml(state.tablesById.get(r.table_id)?.code || '') : ' · senza tavolo'}</span>
      </button>`).join('')
    : '<div class="res-empty">Nessuna prenotazione attiva per questo turno.</div>';
  wireReservationDrag($('opsReservations'));
}

function wireReservationDrag(container) {
  container.querySelectorAll('[data-res-drag]').forEach((node) => {
    node.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/reservation-id', node.dataset.resDrag);
      event.dataTransfer.effectAllowed = 'move';
    });
  });
}

function operationalTableHtml(table, reservation, index) {
  const layout = tableLayout(table, index);
  const status = tableOperationalStatus(table, reservation);
  const selected = table.id === state.selectedTableId ? ' is-selected' : '';
  const joined = table.service_group_id ? ' is-joined' : '';
  const style = layout.positioned
    ? `style="left:${layout.x}px;top:${layout.y}px;width:${layout.w}px;height:${layout.h}px;transform:rotate(${layout.rotation}deg);--table-color:${escapeHtml(table.layout_color || '#f4c7bb')}"`
    : `style="--table-color:${escapeHtml(table.layout_color || '#f4c7bb')}"`;
  return `<button class="ops-table ops-table--${status.key} ops-table--${escapeHtml(layout.shape)}${selected}${joined}" type="button" data-table-id="${escapeHtml(table.id)}" ${style}>
    <span class="ops-table__code">${escapeHtml(table.code)}</span>
    <span class="ops-table__seats">${table.seats_min}–${table.seats_max} posti</span>
    <span class="ops-table__state">${escapeHtml(status.label)}</span>
    ${reservation ? `<span class="ops-table__guest" draggable="true" data-res-drag="${escapeHtml(reservation.id)}">${escapeHtml(reservation.customer_last_name)} · ${reservation.party_size}</span>` : ''}
    ${table.service_group_id ? '<span class="ops-table__group">unito</span>' : ''}
  </button>`;
}

function liveTableHtml(table, reservation, index) {
  const layout = tableLayout(table, index);
  const status = tableOperationalStatus(table, reservation);
  const selected = table.id === state.selectedTableId ? ' is-selected' : '';
  const joined = table.service_group_id ? ' is-joined' : '';
  const style = layout.positioned
    ? `style="left:${layout.x}px;top:${layout.y}px;width:${layout.w}px;height:${layout.h}px;transform:rotate(${layout.rotation}deg);--table-color:${escapeHtml(table.layout_color || '#f4c7bb')}"`
    : `style="--table-color:${escapeHtml(table.layout_color || '#f4c7bb')}"`;
  const guestName = reservation ? `${reservation.customer_last_name || ''} ${reservation.customer_first_name || ''}`.trim() : 'Tavolo libero';
  const meta = reservation ? `${shiftTimeLabel(reservation)} · ${reservation.party_size} coperti` : `${table.seats_min}-${table.seats_max} posti`;
  return `<button class="ops-table ops-table--${status.key} ops-table--${escapeHtml(layout.shape)}${selected}${joined}" type="button" data-table-id="${escapeHtml(table.id)}" ${style}>
    <span class="ops-table__state">${escapeHtml(status.label)}</span>
    <span class="ops-table__code">${escapeHtml(table.code)}</span>
    <span class="ops-table__guest" ${reservation ? `draggable="true" data-res-drag="${escapeHtml(reservation.id)}"` : ''}>${escapeHtml(guestName)}</span>
    <span class="ops-table__meta">${escapeHtml(meta)}</span>
    <span class="ops-table__elapsed">${escapeHtml(status.elapsed)}</span>
    <span class="ops-table__quick" aria-label="Azioni rapide tavolo">
      <span data-live-status="seated" data-table-id="${escapeHtml(table.id)}">Seduto</span>
      <span data-live-status="paying" data-table-id="${escapeHtml(table.id)}">Paga</span>
      <span data-live-status="dirty" data-table-id="${escapeHtml(table.id)}">Sparecchia</span>
      <span data-live-status="clear" data-table-id="${escapeHtml(table.id)}">Libero</span>
    </span>
    ${table.service_group_id ? '<span class="ops-table__group">unito</span>' : ''}
  </button>`;
}

function tableLayout(table, index) {
  const positioned = table.layout_x !== null && table.layout_x !== undefined;
  const x = Number(table.layout_x ?? (80 + (index % 5) * 150));
  const y = Number(table.layout_y ?? (80 + Math.floor(index / 5) * 130));
  const rawW = Number(table.layout_width || 120);
  const rawH = Number(table.layout_height || 90);
  const shape = table.layout_shape || 'rectangle';
  const w = shape === 'square' ? Math.max(rawW, rawH) : rawW;
  const h = shape === 'square' ? w : rawH;
  return { positioned, x, y, w, h, rotation: Number(table.layout_rotation || 0), shape };
}

function tableOperationalStatus(table, reservation) {
  if (table.active === false) return { key: 'off', label: 'Fuori servizio', elapsed: 'Non operativo' };
  const elapsed = liveElapsed(table, reservation);
  if (table.operational_status === 'dirty') return { key: 'dirty', label: 'Da sparecchiare', elapsed };
  if (table.operational_status === 'paying') return { key: 'paying', label: 'Sta pagando', elapsed };
  if ((table.operational_status === 'seated' || reservation?.status === 'arrivato') && elapsedMinutes(table, reservation) >= LIVE_TOO_LONG_MINUTES) {
    return { key: 'too-long', label: 'Occupato troppo', elapsed };
  }
  if (table.operational_status === 'seated' || reservation?.status === 'arrivato') return { key: 'seated', label: 'Cliente seduto', elapsed };
  const until = reservation ? minutesUntilReservation(reservation) : Number.POSITIVE_INFINITY;
  if (reservation && until >= 0 && until <= LIVE_IMMINENT_MINUTES) return { key: 'imminent', label: 'Prenotazione imminente', elapsed };
  if (reservation) return { key: 'reserved', label: 'Prenotato', elapsed };
  return { key: 'free', label: 'Libero', elapsed: 'Disponibile ora' };
}

function shiftTimeLabel(reservation) {
  const shift = state.shifts.find((s) => s.id === reservation?.shift_id);
  return shift ? hhmm(shift.start_time) : '--:--';
}

function reservationDateTime(reservation) {
  const shift = state.shifts.find((s) => s.id === reservation?.shift_id);
  if (!reservation || !shift?.start_time) return null;
  const [h, m] = shift.start_time.split(':').map(Number);
  const [y, mo, d] = reservation.reservation_date.split('-').map(Number);
  return new Date(y, mo - 1, d, h || 0, m || 0, 0, 0);
}

function minutesUntilReservation(reservation) {
  const dt = reservationDateTime(reservation);
  if (!dt) return Number.POSITIVE_INFINITY;
  return Math.round((dt.getTime() - Date.now()) / 60000);
}

function elapsedMinutes(table, reservation) {
  const startedAt = table.operational_updated_at ? new Date(table.operational_updated_at) : reservationDateTime(reservation);
  if (!startedAt || Number.isNaN(startedAt.getTime())) return 0;
  return Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 60000));
}

function liveElapsed(table, reservation) {
  if (!reservation && !table.operational_status) return 'Disponibile ora';
  if (reservation && !['seated', 'paying', 'dirty'].includes(table.operational_status)) {
    const until = minutesUntilReservation(reservation);
    if (until > 0) return `Tra ${until} min`;
  }
  const mins = elapsedMinutes(table, reservation);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

function openTablePanel(tableId) {
  state.selectedTableId = tableId;
  renderMap();
}

function renderTablePanel() {
  const panel = $('opsPanel');
  const table = state.tablesById.get(state.selectedTableId);
  if (!table) { panel.hidden = true; return; }
  const occupancy = tableOccupancy();
  const reservation = occupancy.get(table.id);
  const activeRows = state.reservations
    .filter((r) => r.shift_id === state.shiftId && r.status !== 'annullata' && r.status !== 'no_show');
  const mergeOptions = state.tables
    .filter((t) => t.id !== table.id)
    .map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.code)}</option>`).join('');
  panel.hidden = false;
  panel.innerHTML = `
    <div class="ops-panel__head">
      <div><strong>Tavolo ${escapeHtml(table.code)}</strong><span>${table.seats_min}–${table.seats_max} posti</span></div>
      <button class="act act--mute" type="button" data-ops-close>Chiudi</button>
    </div>
    <div class="ops-panel__grid">
      <label class="field"><span>Prenotazione</span><select id="opsAssignSelect">
        <option value="">— nessuna —</option>
        ${activeRows.map((r) => `<option value="${escapeHtml(r.id)}" ${reservation?.id === r.id ? 'selected' : ''}>${escapeHtml(r.customer_last_name)} ${escapeHtml(r.customer_first_name || '')} · ${r.party_size} pax</option>`).join('')}
      </select></label>
      <button class="btn btn--primary btn--sm" type="button" data-ops-assign="${escapeHtml(table.id)}">Assegna</button>
      <button class="btn btn--ghost btn--sm" type="button" data-ops-status="seated">Cliente seduto</button>
      <button class="btn btn--ghost btn--sm" type="button" data-ops-status="paying">Sta pagando</button>
      <button class="btn btn--ghost btn--sm" type="button" data-ops-status="dirty">Da sparecchiare</button>
      <button class="btn btn--ghost btn--sm" type="button" data-ops-clear>Libero</button>
      <button class="btn btn--ghost btn--sm" type="button" data-ops-off>${table.active === false ? 'Rimetti in servizio' : 'Fuori servizio'}</button>
      <label class="field"><span>Unisci con</span><select id="opsMergeSelect">${mergeOptions}</select></label>
      <button class="btn btn--ghost btn--sm" type="button" data-ops-merge="${escapeHtml(table.id)}">Unisci</button>
      <button class="btn btn--ghost btn--sm" type="button" data-ops-split="${escapeHtml(table.id)}">Dividi</button>
    </div>`;
  wireTablePanel(panel, table, reservation);
}

function wireTablePanel(panel, table, reservation) {
  panel.querySelector('[data-ops-close]').addEventListener('click', () => { state.selectedTableId = null; renderMap(); });
  panel.querySelector('[data-ops-assign]').addEventListener('click', () => {
    const reservationId = $('opsAssignSelect').value;
    if (reservationId) assignReservationToTable(reservationId, table.id);
  });
  panel.querySelectorAll('[data-ops-status]').forEach((button) =>
    button.addEventListener('click', () => setTableOperationalStatus(table.id, button.dataset.opsStatus, reservation)));
  panel.querySelector('[data-ops-clear]').addEventListener('click', () => clearTable(table, reservation));
  panel.querySelector('[data-ops-off]').addEventListener('click', () => setTableOutOfService(table));
  panel.querySelector('[data-ops-merge]').addEventListener('click', () => mergeTables(table.id, $('opsMergeSelect').value));
  panel.querySelector('[data-ops-split]').addEventListener('click', () => splitTable(table.id));
}

async function assignReservationToTable(reservationId, tableId) {
  const reservation = state.reservations.find((r) => r.id === reservationId);
  if (!reservation) return;
  const { error } = await supabase.rpc('assign_reservation_table', {
    p_reservation_id: reservationId,
    p_table_id: tableId,
  });
  if (error) { console.error('[ops-room] assegnazione drag/drop fallita:', error); toast(tableAssignmentError(error), true); return; }
  toast('Prenotazione assegnata al tavolo');
  await setTableOperationalStatus(tableId, null, null, { silent: true });
  await loadDay();
}

async function setTableOperationalStatus(tableId, status, reservation, options = {}) {
  const patch = { operational_status: status, operational_updated_at: new Date().toISOString() };
  const { error } = await supabase.from('restaurant_tables').update(patch).eq('id', tableId);
  if (error) { console.error('[ops-room] stato tavolo non aggiornato:', error); toast('Impossibile aggiornare il tavolo.', true); return; }
  if (status === 'seated' && reservation && reservation.status !== 'arrivato') {
    await changeStatus(reservation.id, 'arrivato');
    return;
  }
  if (!options.silent) toast('Sala aggiornata');
  await loadConfig();
  render();
}

async function clearTable(table, reservation) {
  if (reservation) {
    const { error } = await supabase.rpc('assign_reservation_table', {
      p_reservation_id: reservation.id,
      p_table_id: null,
    });
    if (error) { console.error('[ops-room] rimozione tavolo fallita:', error); toast('Impossibile liberare il tavolo.', true); return; }
  }
  await setTableOperationalStatus(table.id, null, null);
}

async function setTableOutOfService(table) {
  const patch = {
    active: table.active === false,
    operational_status: null,
    operational_updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from('restaurant_tables').update(patch).eq('id', table.id);
  if (error) { console.error('[ops-room] fuori servizio fallito:', error); toast('Impossibile aggiornare il tavolo.', true); return; }
  toast(patch.active ? 'Tavolo rimesso in servizio' : 'Tavolo fuori servizio');
  await loadConfig();
  render();
}

async function mergeTables(tableId, otherTableId) {
  if (!tableId || !otherTableId) return;
  const first = state.tablesById.get(tableId);
  const second = state.tablesById.get(otherTableId);
  const group = first?.service_group_id || second?.service_group_id || randomId();
  const { error } = await supabase.from('restaurant_tables')
    .update({ service_group_id: group, operational_updated_at: new Date().toISOString() })
    .in('id', [tableId, otherTableId]);
  if (error) { console.error('[ops-room] unione tavoli fallita:', error); toast('Impossibile unire i tavoli.', true); return; }
  toast('Tavoli uniti');
  await loadConfig();
  render();
}

async function splitTable(tableId) {
  const { error } = await supabase.from('restaurant_tables')
    .update({ service_group_id: null, operational_updated_at: new Date().toISOString() })
    .eq('id', tableId);
  if (error) { console.error('[ops-room] divisione tavolo fallita:', error); toast('Impossibile dividere il tavolo.', true); return; }
  toast('Tavolo diviso');
  await loadConfig();
  render();
}

function randomId() {
  return crypto?.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// ---------------------------------------------------------------------------
// Prenotazione manuale
// ---------------------------------------------------------------------------
function populateManualShiftSelect() {
  const sel = $('mShift');
  sel.innerHTML = state.shifts.map((s) =>
    `<option value="${s.id}">${escapeHtml(s.name)} (${hhmm(s.start_time)}–${hhmm(s.end_time)})</option>`).join('');
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
    const fit = party >= t.seats_min && party <= t.seats_max;
    const label = `${t.code} (${t.seats_min}–${t.seats_max})${fit ? '' : ' · non adatto'}`;
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
function scheduleReload() {
  clearTimeout(reloadTimer);
  setRealtimeUpdating(true);
  reloadTimer = setTimeout(async () => {
    try { await loadDay(); }
    catch (error) { console.error(error); }
    finally { setRealtimeUpdating(false); }
  }, 250);
}
let configReloadTimer;
function scheduleConfigReload() {
  clearTimeout(configReloadTimer);
  setRealtimeUpdating(true);
  configReloadTimer = setTimeout(async () => {
    try {
      await loadConfig();
      await loadDay();
    } catch (error) {
      console.error('[ops-room] reload tavoli fallito:', error);
    } finally {
      setRealtimeUpdating(false);
    }
  }, 250);
}

function subscribeRealtime() {
  supabase.channel('res-' + state.venue.id)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'reservations', filter: `venue_id=eq.${state.venue.id}` },
      (payload) => {
        const rowDate = payload.new?.reservation_date || payload.old?.reservation_date;
        if (rowDate === state.date) {
          if (payload.eventType === 'INSERT' && payload.new?.source === 'widget') {
            notifyOperator('Nuova prenotazione', `${payload.new.customer_last_name || 'Cliente'} · ${payload.new.party_size || 0} coperti`, { icon: '+', tag: 'new-reservation' });
          }
          scheduleReload();
        }
      })
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'waitlist', filter: `venue_id=eq.${state.venue.id}` },
      (payload) => {
        const rowDate = payload.new?.reservation_date || payload.old?.reservation_date;
        if (rowDate === state.date) {
          if (payload.eventType === 'INSERT') {
            notifyOperator('Lista d\'attesa', `${payload.new.customer_last_name || 'Cliente'} · ${payload.new.party_size || 0} coperti`, { icon: '!', tone: 'urgent', tag: 'waitlist' });
          }
          scheduleReload();
        }
      })
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'restaurant_tables', filter: `venue_id=eq.${state.venue.id}` },
      () => scheduleConfigReload())
    .subscribe();
}

// ---------------------------------------------------------------------------
// Controlli
// ---------------------------------------------------------------------------
function wireControls() {
  $('prevDay').addEventListener('click', () => { state.date = addDays(state.date, -1); loadDay().catch(console.error); });
  $('nextDay').addEventListener('click', () => { state.date = addDays(state.date, +1); loadDay().catch(console.error); });
  $('goToday').addEventListener('click', () => { state.date = todayISO(); loadDay().catch(console.error); });

  $('addBtn').addEventListener('click', () => ($('manualForm').hidden ? openManual() : closeManual()));
  $('mCancel').addEventListener('click', closeManual);
  $('mForm').addEventListener('submit', submitManual);
  $('mShift').addEventListener('change', refreshManualTableSelect);
  $('mParty').addEventListener('change', refreshManualTableSelect);

  const search = $('resSearch');
  if (search) {
    search.addEventListener('input', () => {
      state.search = search.value;
      renderList();
    });
  }
}

function initDashboardChrome() {
  const profile = $('operatorProfileLabel');
  if (profile) {
    profile.textContent = state.session.user.email || (state.role === 'owner' ? 'Titolare' : 'Staff');
  }

  const root = document.documentElement;
  const themeToggle = $('themeToggle');
  const savedTheme = readAdminTheme();
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const initialTheme = savedTheme || (prefersDark ? 'dark' : 'light');
  root.dataset.adminTheme = initialTheme;

  if (themeToggle) {
    themeToggle.checked = initialTheme === 'dark';
    themeToggle.addEventListener('change', () => {
      const nextTheme = themeToggle.checked ? 'dark' : 'light';
      root.dataset.adminTheme = nextTheme;
      saveAdminTheme(nextTheme);
    });
  }

  const notificationToggle = $('notificationToggle');
  if (notificationToggle) {
    notificationToggle.addEventListener('click', async () => {
      if (!('Notification' in window)) {
        toast('Notifiche desktop non supportate da questo browser.', true);
        return;
      }
      if (Notification.permission === 'granted') {
        toast('Notifiche gia attive');
        return;
      }
      try {
        const permission = await Notification.requestPermission();
        toast(permission === 'granted' ? 'Notifiche attivate' : 'Notifiche non attivate', permission !== 'granted');
      } catch (error) {
        console.error('[dashboard-ui] permesso notifiche non disponibile:', error);
        toast('Non posso attivare le notifiche su questo dispositivo.', true);
      }
    });
  }
}

function readAdminTheme() {
  try {
    return localStorage.getItem('admin-theme');
  } catch (error) {
    console.warn('[dashboard-ui] preferenza tema non leggibile:', error);
    return null;
  }
}

function saveAdminTheme(theme) {
  try {
    localStorage.setItem('admin-theme', theme);
  } catch (error) {
    console.warn('[dashboard-ui] preferenza tema non salvata:', error);
  }
}

init();
