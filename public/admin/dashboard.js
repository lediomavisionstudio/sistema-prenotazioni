// Dashboard gestionale: KPI, tab turni, lista prenotazioni con azioni di
// stato, mappa tavoli e inserimento manuale. Aggiornamento live via Supabase
// Realtime sulla tabella reservations.
import {
  supabase, requireSession, signOut, loadCurrentVenue,
  todayISO, addDays, isoDow, formatLong, hhmm, escapeHtml, toast,
  STATUS_LABEL,
} from './app.js';
import {
  statusRank, reservationCardHtml, wireRowActions, wireTableAssignment,
  waitlistCardHtml, wireWaitlistActions,
} from './resui.js';

const $ = (id) => document.getElementById(id);

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
  const [{ data: shifts, error: e1 }, { data: tables, error: e2 }] = await Promise.all([
    supabase.from('service_shifts').select('id, code, name, start_time, end_time, days_of_week, sort_order')
      .eq('venue_id', state.venue.id).eq('active', true).order('sort_order'),
    supabase.from('restaurant_tables').select('id, code, seats_max, zone:zones(id, name, sort_order)')
      .eq('venue_id', state.venue.id).eq('active', true),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;

  state.shifts = shifts || [];
  state.tables = (tables || []).sort((a, b) =>
    (a.zone?.sort_order - b.zone?.sort_order) || a.code.localeCompare(b.code, 'it', { numeric: true }));
  state.tablesById = new Map(state.tables.map((t) => [t.id, t]));
  state.capacity = state.tables.reduce((s, t) => s + (t.seats_max || 0), 0);

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
  renderKpis();
  renderTabs();
  renderList();
  renderWaitlist();
  renderMap();
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
    btn.addEventListener('click', () => { state.shiftId = s.id; render(); });
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
    .sort((a, b) => statusRank(a.status) - statusRank(b.status) || a.customer_last_name.localeCompare(b.customer_last_name, 'it'));

  if (rows.length === 0) {
    list.innerHTML = '<div class="res-empty">Nessuna prenotazione per questo turno.</div>';
    return;
  }

  list.innerHTML = rows.map((r) => reservationCardHtml(r, {
    timeLabel: shift ? hhmm(shift.start_time) : '',
    tableCode: r.table_id ? state.tablesById.get(r.table_id)?.code : null,
    tableOptions: tableOptionsForReservation(r),
  })).join('');

  wireRowActions(list, changeStatus);
  wireTableAssignment(list, assignTable);
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

  return state.tables.map((table) => {
    const fits = reservation.party_size <= table.seats_max;
    const busy = occupied.has(table.id);
    return {
      id: table.id,
      disabled: (!fits || busy) && table.id !== reservation.table_id,
      label: `${table.code} (${table.seats_max})${fits ? '' : ' - non adatto'}${busy ? ' - occupato' : ''}`,
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
function renderMap() {
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
}

init();
