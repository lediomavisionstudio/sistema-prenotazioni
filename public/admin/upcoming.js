// Vista "In arrivo": tutte le prenotazioni da oggi in avanti, raggruppate per
// data (e turno), con le stesse azioni di stato della dashboard. Aggiornamento
// live via Realtime così una nuova prenotazione dal widget compare da sola.
import {
  supabase, requireSession, signOut, loadCurrentVenue,
  todayISO, formatLong, hhmm, escapeHtml, toast, STATUS_LABEL,
} from './app.js';
import { statusRank, reservationCardHtml, wireRowActions } from './resui.js';

const $ = (id) => document.getElementById(id);

const state = {
  session: null, venue: null, role: null,
  shifts: [], shiftsById: new Map(),
  tablesById: new Map(),
  reservations: [],
  filter: 'attive',
};

const FILTERS = {
  attive: (r) => r.status === 'in_attesa' || r.status === 'confermata' || r.status === 'arrivato',
  in_attesa: (r) => r.status === 'in_attesa',
  tutte: () => true,
};

async function init() {
  state.session = await requireSession();
  if (!state.session) return;
  $('logoutBtn').addEventListener('click', signOut);

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
    supabase.from('restaurant_tables').select('id, code').eq('venue_id', state.venue.id),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  state.shifts = shifts || [];
  state.shiftsById = new Map(state.shifts.map((s) => [s.id, s]));
  state.tablesById = new Map((tables || []).map((t) => [t.id, t]));
}

async function load() {
  const today = todayISO();
  const { data, error } = await supabase
    .from('reservations')
    .select('id, reservation_date, shift_id, party_size, customer_first_name, customer_last_name, customer_phone, customer_email, notes, status, source, table_id, created_at')
    .eq('venue_id', state.venue.id)
    .gte('reservation_date', today)
    .order('reservation_date', { ascending: true });
  if (error) throw error;
  state.reservations = data || [];
  render();
}

function render() {
  // Contatore "da confermare" (su tutte le date future) sempre visibile.
  const pending = state.reservations.filter((r) => r.status === 'in_attesa').length;
  $('pendingCount').textContent = pending ? `${pending} da confermare` : 'nessuna da confermare';

  const rows = state.reservations.filter(FILTERS[state.filter]);
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
        tableCode: r.table_id ? state.tablesById.get(r.table_id)?.code : null,
        shiftName: shift ? shift.name : '',
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
}

async function changeStatus(id, to) {
  const res = state.reservations.find((r) => r.id === id);
  const { error } = await supabase.from('reservations').update({ status: to }).eq('id', id);
  if (error) { console.error(error); toast('Impossibile aggiornare lo stato.', true); return; }
  toast('Stato aggiornato: ' + STATUS_LABEL[to]);
  if (res) await notifyCustomerStatusEmail(res, to);
  await load();
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
      table_code: reservation.table_id ? (state.tablesById.get(reservation.table_id)?.code || null) : null,
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
  $('filters').querySelectorAll('[data-filter]').forEach((b) =>
    b.addEventListener('click', () => {
      state.filter = b.dataset.filter;
      $('filters').querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === b));
      render();
    }));
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
