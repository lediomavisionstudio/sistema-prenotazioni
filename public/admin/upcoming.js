// Vista "In arrivo": tutte le prenotazioni da oggi in avanti, raggruppate per
// data (e turno), con le stesse azioni di stato della dashboard. Aggiornamento
// live via Realtime così una nuova prenotazione dal widget compare da sola.
import {
  supabase, requireSession, confirmSignOut, loadCurrentVenue,
  todayISO, addDays, formatLong, hhmm, escapeHtml, toast, STATUS_LABEL,
} from './app.js';
import {
  createPartySizeUpdater, statusRank, reservationCardHtml,
  wirePartySizeEditing, wireReservationQuickActions, wireReservationTimers, wireRowActions, wireTableAssignment,
} from './resui.js';

const $ = (id) => document.getElementById(id);

const state = {
  session: null, venue: null, role: null,
  shifts: [], shiftsById: new Map(),
  tablesById: new Map(),
  tableAssignments: new Map(),
  reservations: [],
  filter: 'attive',
  search: '',
  dateFilter: 'all',
  statusFilter: 'all',
  shiftFilter: 'all',
  tableFilter: 'all',
};

const FILTERS = {
  attive: (r) => r.status === 'confermata' || r.status === 'arrivato',
  in_attesa: (r) => r.status === 'in_attesa',
  tutte: () => true,
};

const updatePartySize = createPartySizeUpdater({
  supabase,
  toast,
  getReservations: () => state.reservations,
  reload: load,
  rerender: render,
});

async function init() {
  state.session = await requireSession();
  if (!state.session) return;
  $('logoutBtn').addEventListener('click', confirmSignOut);

  try {
    const current = await loadCurrentVenue();
    if (!current) { location.replace('dashboard.html'); return; }
    state.venue = current.venue;
    state.role = current.role;
    $('venueName').textContent = current.venue.name;
    $('userRole').textContent = (current.role === 'owner' ? 'Titolare' : 'Staff') + ' · ' + (state.session.user.email || '');

    await loadConfig();
    wireFilters();
    subscribeRealtime();
    await load();

    $('pageSpinner').hidden = true;
    $('page').hidden = false;
  } catch (err) {
    console.error(err);
    $('pageSpinner').hidden = true;
    toast('Errore di caricamento.', true);
  }
}

async function loadConfig() {
  const [{ data: shifts, error: e1 }, { data: tables, error: e2 }] = await Promise.all([
    supabase.from('service_shifts').select('id, name, start_time, end_time, sort_order').eq('venue_id', state.venue.id).order('sort_order'),
    supabase.from('restaurant_tables').select('id, code, seats_max').eq('venue_id', state.venue.id),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  state.shifts = shifts || [];
  state.shiftsById = new Map(state.shifts.map((s) => [s.id, s]));
  state.tablesById = new Map((tables || []).map((t) => [t.id, t]));
  populateShiftFilter();
}

async function load() {
  const today = todayISO();
  const { data, error } = await supabase
    .from('reservations')
    .select('id, reservation_date, shift_id, party_size, customer_first_name, customer_last_name, customer_phone, customer_email, notes, status, source, table_id, client_request_id, created_at')
    .eq('venue_id', state.venue.id)
    .gte('reservation_date', today)
    .order('reservation_date', { ascending: true });
  if (error) throw error;
  state.reservations = await withEmailVerificationStatus(await withTableAssignments(data || []));
  render();
}

async function withTableAssignments(rows) {
  state.tableAssignments = new Map();
  const ids = rows.map((row) => row.id).filter(Boolean);
  if (!ids.length) return rows.map((row) => ({ ...row, table_ids: row.table_id ? [row.table_id] : [] }));
  try {
    const { data, error } = await supabase
      .from('reservation_tables')
      .select('reservation_id, table_id')
      .in('reservation_id', ids);
    if (error) throw error;
    const byReservation = new Map();
    for (const row of data || []) {
      if (!byReservation.has(row.reservation_id)) byReservation.set(row.reservation_id, []);
      byReservation.get(row.reservation_id).push(row.table_id);
    }
    state.tableAssignments = byReservation;
    return rows.map((row) => {
      const assignedIds = byReservation.get(row.id);
      return { ...row, table_ids: assignedIds?.length ? assignedIds : (row.table_id ? [row.table_id] : []) };
    });
  } catch (error) {
    console.warn('[tables] assegnazioni multiple non disponibili:', error.message || error);
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

function render() {
  // Contatore "da confermare" (su tutte le date future) sempre visibile.
  const pending = state.reservations.filter((r) => r.status === 'in_attesa').length;
  $('pendingCount').textContent = pending ? `${pending} da confermare` : 'nessuna da confermare';

  const rows = filteredReservations();
  const box = $('upcoming');

  if (rows.length === 0) {
    box.innerHTML = '<div class="res-empty">Nessuna prenotazione in arrivo per questo filtro.</div>';
    return;
  }

  // Raggruppa per data.
  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.reservation_date)) byDate.set(r.reservation_date, []);
    byDate.get(r.reservation_date).push(r);
  }
  const dates = [...byDate.keys()].sort();

  const shiftOrder = (id) => state.shiftsById.get(id)?.sort_order ?? 99;

  box.innerHTML = dates.map((iso) => {
    const dayRows = byDate.get(iso).sort((a, b) =>
      shiftOrder(a.shift_id) - shiftOrder(b.shift_id) ||
      statusRank(a.status) - statusRank(b.status) ||
      a.customer_last_name.localeCompare(b.customer_last_name, 'it'));

    const covers = dayRows
      .filter((r) => r.status === 'confermata' || r.status === 'arrivato')
      .reduce((s, r) => s + r.party_size, 0);

    const cards = dayRows.map((r) => {
      const shift = state.shiftsById.get(r.shift_id);
      return reservationCardHtml(r, {
        timeLabel: shift ? hhmm(shift.start_time) : '',
        tableCode: tableCodes(r),
        shiftName: shift ? shift.name : '',
        tableOptions: tableOptionsForReservation(r),
        canEditPartySize: true,
        capacityWarning: hasInsufficientAssignedCapacity(r),
      });
    }).join('');

    return `
      <section class="section">
        <div class="section__head">
          <h2 class="section__title" style="text-transform:capitalize">${escapeHtml(formatLong(iso))}</h2>
          <span class="pill">${dayRows.length} pren. · ${covers} coperti</span>
        </div>
        <div class="res-list">${cards}</div>
      </section>`;
  }).join('');

  wireRowActions(box, changeStatus);
  wireReservationQuickActions(box);
  wireReservationTimers(box);
  wirePartySizeEditing(box, updatePartySize);
  wireTableAssignment(box, assignTable);
}

function filteredReservations() {
  return state.reservations
    .filter(FILTERS[state.filter])
    .filter((r) => matchesDateFilter(r))
    .filter((r) => state.statusFilter === 'all' || r.status === state.statusFilter)
    .filter((r) => state.shiftFilter === 'all' || r.shift_id === state.shiftFilter)
    .filter((r) => {
      const hasTable = reservationTableIds(r).length > 0;
      if (state.tableFilter === 'assigned') return hasTable;
      if (state.tableFilter === 'unassigned') return !hasTable;
      return true;
    })
    .filter((r) => matchesSearch(r));
}

function matchesDateFilter(r) {
  const today = todayISO();
  if (state.dateFilter === 'today') return r.reservation_date === today;
  if (state.dateFilter === 'tomorrow') return r.reservation_date === addDays(today, 1);
  if (state.dateFilter === 'next7') return r.reservation_date >= today && r.reservation_date <= addDays(today, 6);
  return true;
}

function matchesSearch(r) {
  const term = state.search.trim().toLowerCase();
  if (!term) return true;
  const tableCode = tableCodes(r);
  const fields = [
    r.customer_first_name,
    r.customer_last_name,
    `${r.customer_first_name || ''} ${r.customer_last_name || ''}`,
    r.customer_phone,
    r.customer_email,
    tableCode,
  ];
  return fields.some((value) => String(value || '').toLowerCase().includes(term));
}

function populateShiftFilter() {
  const select = $('shiftFilter');
  if (!select) return;
  select.innerHTML = '<option value="all">Tutti</option>' + state.shifts.map((shift) =>
    `<option value="${escapeHtml(shift.id)}">${escapeHtml(shift.name)} (${hhmm(shift.start_time)})</option>`
  ).join('');
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
  await load();
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
  const codes = reservationTableIds(reservation)
    .map((id) => state.tablesById.get(id)?.code)
    .filter(Boolean);
  return codes.length ? codes.join(' + ') : null;
}

function tableOptionsForReservation(reservation) {
  const selected = new Set(reservationTableIds(reservation));
  const occupants = new Map();
  state.reservations
    .filter((r) =>
      r.id !== reservation.id &&
      r.reservation_date === reservation.reservation_date &&
      r.shift_id === reservation.shift_id &&
      r.status !== 'annullata' &&
      r.status !== 'no_show' &&
      r.status !== 'terminato')
    .forEach((row) => {
      reservationTableIds(row).forEach((tableId) => occupants.set(tableId, row));
    });

  return [...state.tablesById.values()].map((table) => {
    const occupant = occupants.get(table.id);
    const busy = !!occupant;
    const shift = occupant ? state.shiftsById.get(occupant.shift_id) : null;
    return {
      id: table.id,
      code: table.code,
      seatsMax: table.seats_max,
      zoneName: table.zone?.name || 'Sala',
      busy,
      disabled: busy && !selected.has(table.id),
      guestName: occupant ? `${occupant.customer_first_name || ''} ${occupant.customer_last_name || ''}`.trim() : '',
      guestDetail: occupant ? `${occupant.party_size} persone · ${shift ? hhmm(shift.start_time) + ' · ' : ''}${STATUS_LABEL[occupant.status] || occupant.status}` : '',
      guestPhone: occupant?.customer_phone || '',
      guestEmail: occupant?.customer_email || '',
      guestNotes: occupant?.notes || '',
      guestParty: occupant?.party_size || '',
      guestTime: shift?.start_time ? hhmm(shift.start_time) : '',
      guestStatus: occupant ? (STATUS_LABEL[occupant.status] || occupant.status) : '',
      label: `${table.code} (${table.seats_max})${busy ? ' - occupato' : ''}`,
    };
  });
}

async function assignTable(id, tableId) {
  try {
    const reservation = state.reservations.find((row) => row.id === id);
    const previousIds = reservation ? reservationTableIds(reservation) : [];
    const tableIds = Array.isArray(tableId) ? tableId : (tableId ? [tableId] : []);
    const { error } = Array.isArray(tableId)
      ? await supabase.rpc('assign_reservation_tables', {
          p_reservation_id: id,
          p_table_ids: tableIds,
        })
      : await supabase.rpc('assign_reservation_table', {
          p_reservation_id: id,
          p_table_id: tableId,
        });
    if (error) throw error;
    toast(tableAssignmentToast(previousIds, tableIds));
    await load();
    return true;
  } catch (error) {
    console.error('[tables] assegnazione tavolo fallita:', error);
    toast(tableAssignmentError(error), true);
    return false;
  }
}

function tableAssignmentToast(previousIds, nextIds) {
  if (!nextIds.length) return 'Tavolo liberato';
  if (previousIds.length) return 'Tavolo aggiornato';
  return 'Tavolo assegnato';
}

function tableAssignmentError(error) {
  const raw = `${error?.message || ''} ${error?.details || ''}`;
  if (raw.includes('CAPIENZA_INSUFFICIENTE')) return 'Seleziona altri tavoli: la capienza attuale non è sufficiente.';
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
      reservation_time: reservation.shift_id ? (state.shiftsById.get(reservation.shift_id)?.start_time || null) : null,
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

function wireFilters() {
  $('dateFilter').value = state.dateFilter;
  $('statusFilter').value = state.statusFilter;
  $('shiftFilter').value = state.shiftFilter;
  $('tableFilter').value = state.tableFilter;

  $('filters').querySelectorAll('[data-filter]').forEach((b) =>
    b.addEventListener('click', () => {
      state.filter = b.dataset.filter;
      $('filters').querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === b));
      render();
    }));

  let searchTimer;
  $('upcomingSearch').addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = event.target.value || '';
      render();
    }, 160);
  });

  $('dateFilter').addEventListener('change', (event) => {
    state.dateFilter = event.target.value;
    render();
  });
  $('statusFilter').addEventListener('change', (event) => {
    state.statusFilter = event.target.value;
    render();
  });
  $('shiftFilter').addEventListener('change', (event) => {
    state.shiftFilter = event.target.value;
    render();
  });
  $('tableFilter').addEventListener('change', (event) => {
    state.tableFilter = event.target.value;
    render();
  });
  $('resetFilters').addEventListener('click', () => {
    state.filter = 'attive';
    state.search = '';
    state.dateFilter = 'all';
    state.statusFilter = 'all';
    state.shiftFilter = 'all';
    state.tableFilter = 'all';
    $('upcomingSearch').value = '';
    $('dateFilter').value = state.dateFilter;
    $('statusFilter').value = state.statusFilter;
    $('shiftFilter').value = state.shiftFilter;
    $('tableFilter').value = state.tableFilter;
    $('filters').querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.filter === state.filter));
    render();
  });
}

let reloadTimer;
function subscribeRealtime() {
  supabase.channel('upcoming-' + state.venue.id)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'reservations', filter: `venue_id=eq.${state.venue.id}` },
      (payload) => {
        const rowDate = payload.new?.reservation_date || payload.old?.reservation_date;
        if (rowDate && rowDate >= todayISO()) {
          if (payload.eventType === 'INSERT' && payload.new?.source === 'widget') toast('Nuova prenotazione dal widget');
          clearTimeout(reloadTimer);
          reloadTimer = setTimeout(() => load().catch(console.error), 250);
        }
      })
    .subscribe();
}

init();
