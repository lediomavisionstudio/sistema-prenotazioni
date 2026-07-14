// Impostazioni: gestione zone, tavoli, orari turni e chiusura settimanale.
// Le scritture su queste tabelle sono consentite dalla RLS solo al ruolo
// 'owner'; per lo staff la pagina è in sola lettura.
import {
  supabase, requireSession, signOut, loadCurrentVenue,
  hhmm, escapeHtml, toast, WEEKDAYS,
} from './app.js';

const $ = (id) => document.getElementById(id);

const state = {
  session: null,
  venue: null,
  role: null,
  zones: [],
  tables: [],
  shifts: [],
  canEdit: false,
  dirtyTables: new Set(),
  scheduleConfig: null,
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
    state.canEdit = current.role === 'owner';
    $('venueName').textContent = current.venue.name;
    $('userRole').textContent = (current.role === 'owner' ? 'Titolare' : 'Staff') + ' · ' + (state.session.user.email || '');
    $('readonlyBanner').hidden = state.canEdit;

    await loadVenueDetails();
    await reloadAll();
    renderVenueForm();
    renderWeekdays();
    renderScheduleConfig();
    wire();

    $('pageSpinner').hidden = true;
    $('page').hidden = false;
  } catch (err) {
    console.error(err);
    $('pageSpinner').hidden = true;
    toast('Errore di caricamento.', true);
  }
}

async function reloadAll() {
  const [z, t, s] = await Promise.all([
    supabase.from('zones').select('id, name, sort_order').eq('venue_id', state.venue.id).order('sort_order'),
    supabase.from('restaurant_tables').select('id, code, seats_max, zone_id, active').eq('venue_id', state.venue.id).order('code'),
    supabase.from('service_shifts').select('id, code, name, start_time, end_time, days_of_week, sort_order').eq('venue_id', state.venue.id).order('sort_order'),
  ]);
  if (z.error) throw z.error; if (t.error) throw t.error; if (s.error) throw s.error;
  state.zones = z.data || [];
  state.tables = t.data || [];
  state.shifts = s.data || [];
  renderZones(); renderTables(); renderShifts(); renderFreeHours(); fillZoneSelect();
}

function dis() { return state.canEdit ? '' : 'disabled'; }

// --- Dati locale ----------------------------------------------------------
// loadCurrentVenue() carica solo pochi campi; qui prendiamo la riga completa
// (indirizzo, telefono, branding, email privacy) per la sezione modificabile.
// select('*') così non si rompe se qualche colonna opzionale non esiste.
async function loadVenueDetails() {
  const { data, error } = await supabase
    .from('venues').select('*').eq('id', state.venue.id).maybeSingle();
  if (error) throw error;
  if (data) state.venue = { ...state.venue, ...data };
}

function renderVenueForm() {
  const v = state.venue;
  $('vName').value = v.name || '';
  $('vPhone').value = v.phone || '';
  $('vAddress').value = v.address || '';
  $('vEmail').value = v.contact_email || '';
  $('vBrand').value = v.brand_primary || '';
  $('vBrandPick').value = /^#[0-9a-fA-F]{6}$/.test(v.brand_primary || '') ? v.brand_primary : '#c8402a';
  $('vLogo').value = v.logo_url || '';
  $('vRetention').value = v.data_retention_months ?? '';

  const off = !state.canEdit;
  ['vName', 'vPhone', 'vAddress', 'vEmail', 'vBrand', 'vBrandPick', 'vLogo', 'vRetention', 'saveVenue']
    .forEach((id) => { $(id).disabled = off; });
}

async function saveVenue() {
  const name = $('vName').value.trim();
  if (!name) { toast('Il nome del locale è obbligatorio.', true); return; }

  const brand = $('vBrand').value.trim();
  if (brand && !/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(brand)) {
    toast('Colore non valido: usa il formato #rrggbb (o vuoto per il tema predefinito).', true); return;
  }

  const retentionRaw = $('vRetention').value.trim();
  const retention = retentionRaw === '' ? null : parseInt(retentionRaw, 10);
  if (retention !== null && (!Number.isFinite(retention) || retention < 1 || retention > 120)) {
    toast('Mesi di conservazione non validi (1–120).', true); return;
  }

  const patch = {
    name,
    phone: $('vPhone').value.trim() || null,
    address: $('vAddress').value.trim() || null,
    contact_email: $('vEmail').value.trim() || null,
    brand_primary: brand || null,
    // Ricavato dal widget da brand_primary: azzerando qui evitiamo un "dark"
    // rimasto dal colore precedente e non più coerente.
    brand_primary_dark: null,
    logo_url: $('vLogo').value.trim() || null,
  };
  // data_retention_months è NOT NULL: includilo solo se valorizzato, altrimenti
  // lascialo com'è (inviare null farebbe fallire tutto il salvataggio).
  if (retention !== null) patch.data_retention_months = retention;

  // .select() così sappiamo quante righe sono state aggiornate: con la RLS un
  // update non autorizzato non dà errore ma tocca 0 righe.
  const { data, error } = await supabase
    .from('venues').update(patch).eq('id', state.venue.id).select('id');
  if (error) {
    console.error(error);
    toast(error.message?.includes('row-level') ? 'Permesso negato (solo il titolare può modificare).' : 'Salvataggio non riuscito: ' + (error.message || 'errore'), true);
    return;
  }
  if (!data || data.length === 0) {
    toast('Nessuna modifica salvata: permesso negato (serve il ruolo titolare).', true);
    return;
  }
  Object.assign(state.venue, patch);
  $('venueName').textContent = name;
  toast('Dati locale salvati.');
}

async function run(promise, okMsg) {
  const { error } = await promise;
  if (error) { console.error(error); toast(error.message?.includes('row-level') ? 'Permesso negato (solo titolare).' : 'Operazione non riuscita.', true); return false; }
  if (okMsg) toast(okMsg);
  await reloadAll();
  return true;
}

// --- Zone -----------------------------------------------------------------
function renderZones() {
  $('zoneRows').innerHTML = state.zones.map((z) => `
    <div class="row-item">
      <input class="row-item__grow" value="${escapeHtml(z.name)}" data-zid="${z.id}" ${dis()} maxlength="60" />
      <button class="btn btn--ghost btn--sm" data-save-zone="${z.id}" ${dis()}>Salva</button>
      <button class="act act--warn" data-del-zone="${z.id}" ${dis()}>Elimina</button>
    </div>`).join('') || '<div class="res-empty">Nessuna zona.</div>';

  $('zoneRows').querySelectorAll('[data-save-zone]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.saveZone;
    const val = $('zoneRows').querySelector(`input[data-zid="${id}"]`).value.trim();
    if (val) run(supabase.from('zones').update({ name: val }).eq('id', id), 'Zona aggiornata');
  }));
  $('zoneRows').querySelectorAll('[data-del-zone]').forEach((b) => b.addEventListener('click', () => {
    if (confirm('Eliminare la zona? Deve essere priva di tavoli.'))
      run(supabase.from('zones').delete().eq('id', b.dataset.delZone), 'Zona eliminata');
  }));
}

// --- Tavoli ---------------------------------------------------------------
function fillZoneSelect() {
  $('tZone').innerHTML = state.zones.map((z) => `<option value="${z.id}">${escapeHtml(z.name)}</option>`).join('');
}

function renderTables() {
  state.dirtyTables = new Set([...state.dirtyTables].filter((id) => state.tables.some((table) => table.id === id)));
  const zoneName = (id) => escapeHtml(state.zones.find((z) => z.id === id)?.name || '—');
  $('tableRows').innerHTML = state.tables.map((t) => `
    <div class="row-item tables-grid table-row" data-table-row="${t.id}">
      <div class="table-cell" data-label="Codice">
        <input class="table-row__code" value="${escapeHtml(t.code)}" data-tid="${t.id}" data-f="code" ${dis()} maxlength="20" aria-label="Nome tavolo" />
      </div>
      <div class="table-cell" data-label="Zona">
        <select data-tid="${t.id}" data-f="zone_id" ${dis()} aria-label="Zona tavolo">
          ${state.zones.map((z) => `<option value="${z.id}" ${z.id === t.zone_id ? 'selected' : ''}>${escapeHtml(z.name)}</option>`).join('')}
        </select>
      </div>
      <div class="table-cell" data-label="Posti max">
        <input class="table-row__seats" type="number" min="1" value="${t.seats_max}" data-tid="${t.id}" data-f="seats_max" ${dis()} aria-label="Posti massimi" />
      </div>
      <div class="table-cell" data-label="Stato">
        <label class="pill table-row__active"><input type="checkbox" ${t.active ? 'checked' : ''} data-tid="${t.id}" data-f="active" ${dis()} /> attivo</label>
      </div>
      <div class="table-cell table-cell--actions" data-label="Azioni">
        <button class="act act--warn" data-del-table="${t.id}" ${dis()}>Elimina</button>
      </div>
    </div>`).join('') || '<div class="res-empty">Nessun tavolo.</div>';

  $('tableRows').querySelectorAll('[data-tid][data-f]').forEach((input) => {
    const eventName = input.type === 'checkbox' || input.tagName === 'SELECT' ? 'change' : 'input';
    input.addEventListener(eventName, () => markTableDirty(input.dataset.tid));
  });
  $('tableRows').querySelectorAll('[data-del-table]').forEach((b) => b.addEventListener('click', () => {
    if (confirm('Eliminare il tavolo?')) run(supabase.from('restaurant_tables').delete().eq('id', b.dataset.delTable), 'Tavolo eliminato');
  }));
  refreshTableDirtyUi();
}

function tablePatchFromRow(id) {
  const g = (f) => $('tableRows').querySelector(`[data-tid="${id}"][data-f="${f}"]`);
  return {
    code: g('code').value.trim(),
    zone_id: g('zone_id').value,
    seats_max: parseInt(g('seats_max').value, 10),
    active: g('active').checked,
  };
}

function markTableDirty(id) {
  if (!state.canEdit || !id) return;
  const original = state.tables.find((table) => table.id === id);
  if (!original) return;
  const patch = tablePatchFromRow(id);
  const changed =
    patch.code !== original.code ||
    patch.zone_id !== original.zone_id ||
    patch.seats_max !== original.seats_max ||
    patch.active !== original.active;
  if (changed) state.dirtyTables.add(id);
  else state.dirtyTables.delete(id);
  refreshTableDirtyUi();
}

function refreshTableDirtyUi(saved = false) {
  $('tableRows').querySelectorAll('[data-table-row]').forEach((row) => {
    row.classList.toggle('is-dirty', state.dirtyTables.has(row.dataset.tableRow));
  });
  const bar = $('tableSaveBar');
  if (!bar) return;
  bar.hidden = state.dirtyTables.size === 0 && !saved;
  bar.classList.toggle('is-saved', saved);
  $('tableSaveHint').textContent = saved
    ? '✓ Modifiche salvate'
    : `${state.dirtyTables.size} ${state.dirtyTables.size === 1 ? 'riga modificata' : 'righe modificate'}.`;
}

function cancelTableChanges() {
  state.dirtyTables.clear();
  renderTables();
  refreshTableDirtyUi();
}

async function saveTableChanges() {
  if (!state.dirtyTables.size) return;
  const ids = [...state.dirtyTables];
  const patches = ids.map((id) => ({ id, patch: tablePatchFromRow(id) }));
  const invalid = patches.find(({ patch }) => !patch.code || !(patch.seats_max > 0));
  if (invalid) { toast('Dati tavolo non validi.', true); return; }

  $('saveTableChanges').disabled = true;
  $('cancelTableChanges').disabled = true;
  try {
    const results = await Promise.all(patches.map(({ id, patch }) =>
      supabase.from('restaurant_tables').update(patch).eq('id', id)));
    const failed = results.find((result) => result.error);
    if (failed) throw failed.error;
    state.dirtyTables.clear();
    await reloadAll();
    refreshTableDirtyUi(true);
    toast('Modifiche salvate');
    setTimeout(() => refreshTableDirtyUi(false), 1600);
  } catch (error) {
    console.error(error);
    toast(error.message?.includes('row-level') ? 'Permesso negato (solo titolare).' : 'Salvataggio modifiche non riuscito.', true);
  } finally {
    $('saveTableChanges').disabled = false;
    $('cancelTableChanges').disabled = false;
  }
}

// --- Turni ----------------------------------------------------------------
function renderShifts() {
  $('shiftRows').innerHTML = state.shifts.map((s) => `
    <div class="card" style="padding:12px">
      <div class="row-item" style="border:none;padding:0;background:none">
        <input class="row-item__grow" value="${escapeHtml(s.name)}" data-sid="${s.id}" data-f="name" ${dis()} maxlength="40" />
        <input type="time" value="${hhmm(s.start_time)}" data-sid="${s.id}" data-f="start" ${dis()} />
        <input type="time" value="${hhmm(s.end_time)}" data-sid="${s.id}" data-f="end" ${dis()} />
        <button class="btn btn--ghost btn--sm" data-save-shift="${s.id}" ${dis()}>Salva</button>
        <button class="act act--warn" data-del-shift="${s.id}" ${dis()}>Elimina</button>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px">
        ${WEEKDAYS.map((d) => `<label class="pill" style="cursor:pointer">
          <input type="checkbox" data-sid="${s.id}" data-dow="${d.n}" ${(s.days_of_week || []).includes(d.n) ? 'checked' : ''} ${dis()} /> ${d.short}
        </label>`).join('')}
      </div>
    </div>`).join('') || '<div class="res-empty">Nessun turno.</div>';

  $('shiftRows').querySelectorAll('[data-save-shift]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.saveShift;
    const g = (f) => $('shiftRows').querySelector(`[data-sid="${id}"][data-f="${f}"]`);
    const days = [...$('shiftRows').querySelectorAll(`input[data-sid="${id}"][data-dow]`)].filter((c) => c.checked).map((c) => parseInt(c.dataset.dow, 10));
    const patch = { name: g('name').value.trim(), start_time: g('start').value, end_time: g('end').value, days_of_week: days };
    if (!patch.name || !(patch.end_time > patch.start_time)) { toast('Orari turno non validi (fine dopo inizio).', true); return; }
    run(supabase.from('service_shifts').update(patch).eq('id', id), 'Turno aggiornato');
  }));
  $('shiftRows').querySelectorAll('[data-del-shift]').forEach((b) => b.addEventListener('click', () => {
    if (confirm('Eliminare il turno? Non deve avere prenotazioni collegate.'))
      run(supabase.from('service_shifts').delete().eq('id', b.dataset.delShift), 'Turno eliminato');
  }));
}

// --- Orari ----------------------------------------------------------------
function normalizeScheduleMode(mode) {
  return mode === 'free' ? 'free' : 'shifts';
}

function defaultScheduleDays(mode = 'shifts') {
  return Object.fromEntries(WEEKDAYS.map((day) => [day.n, normalizeScheduleMode(mode)]));
}

function venueScheduleDays() {
  return {
    ...defaultScheduleDays(state.venue.booking_mode),
    ...(state.venue.booking_mode_by_weekday || {}),
  };
}

function renderScheduleConfig() {
  const sameMode = state.venue.booking_same_mode_all_days !== false;
  const mode = normalizeScheduleMode(state.venue.booking_mode);
  const days = venueScheduleDays();
  $('scheduleSameMode').checked = sameMode;
  $('scheduleModeShifts').checked = mode === 'shifts';
  $('scheduleModeFree').checked = mode === 'free';
  $('scheduleSameMode').disabled = !state.canEdit;
  $('scheduleModeShifts').disabled = !state.canEdit;
  $('scheduleModeFree').disabled = !state.canEdit;
  $('saveScheduleConfig').disabled = !state.canEdit;

  $('scheduleGlobalMode').hidden = !sameMode;
  $('scheduleDayModes').hidden = sameMode;
  $('scheduleDayModes').innerHTML = WEEKDAYS.map((day) => {
    const dayMode = normalizeScheduleMode(days[day.n]);
    return `
      <div class="row-item schedule-day">
        <strong>${escapeHtml(day.long)}</strong>
        <select data-schedule-day="${day.n}" ${dis()} aria-label="Modalità ${escapeHtml(day.long)}">
          <option value="shifts" ${dayMode === 'shifts' ? 'selected' : ''}>Turni</option>
          <option value="free" ${dayMode === 'free' ? 'selected' : ''}>Orari liberi</option>
        </select>
      </div>`;
  }).join('');

  setScheduleTab('shifts');
}

function renderFreeHours() {
  const rows = $('freeHoursRows');
  if (!rows) return;
  rows.innerHTML = `
    <div class="card" style="padding:12px">
      <div class="row-item" style="border:none;padding:0;background:none">
        <input class="row-item__grow" value="Orari liberi" disabled />
        <input type="time" value="19:00" disabled />
        <input type="time" value="23:00" disabled />
        <button class="btn btn--ghost btn--sm" type="button" disabled>Salva</button>
        <button class="act act--warn" type="button" disabled>Elimina</button>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px">
        ${WEEKDAYS.map((d) => `<label class="pill"><input type="checkbox" disabled /> ${d.short}</label>`).join('')}
      </div>
    </div>`;
}

function setScheduleTab(tab) {
  const active = tab === 'free' ? 'free' : 'shifts';
  $('scheduleTabShifts').classList.toggle('is-active', active === 'shifts');
  $('scheduleTabFree').classList.toggle('is-active', active === 'free');
  $('schedulePanelShifts').hidden = active !== 'shifts';
  $('schedulePanelFree').hidden = active !== 'free';
}

async function saveScheduleConfig() {
  if (!state.canEdit) return;
  const sameMode = $('scheduleSameMode').checked;
  const mode = normalizeScheduleMode(document.querySelector('input[name="scheduleMode"]:checked')?.value);
  const days = sameMode
    ? defaultScheduleDays(mode)
    : Object.fromEntries([...$('scheduleDayModes').querySelectorAll('[data-schedule-day]')]
      .map((select) => [select.dataset.scheduleDay, normalizeScheduleMode(select.value)]));
  const patch = {
    booking_same_mode_all_days: sameMode,
    booking_mode: mode,
    booking_mode_by_weekday: days,
  };
  const { data, error } = await supabase
    .from('venues')
    .update(patch)
    .eq('id', state.venue.id)
    .select('*')
    .maybeSingle();
  if (error) {
    console.error(error);
    toast(error.message?.includes('row-level') ? 'Permesso negato (solo titolare).' : 'Configurazione orari non salvata.', true);
    return;
  }
  state.venue = { ...state.venue, ...(data || patch) };
  renderScheduleConfig();
  toast('Configurazione orari salvata.');
}

// --- Chiusura settimanale -------------------------------------------------
function renderWeekdays() {
  const closed = new Set(state.venue.closed_weekdays || []);
  $('weekdayBoxes').innerHTML = WEEKDAYS.map((d) => `
    <label class="pill" style="cursor:pointer">
      <input type="checkbox" data-dow="${d.n}" ${closed.has(d.n) ? 'checked' : ''} ${dis()} /> ${d.long}
    </label>`).join('');
  $('saveClosure').disabled = !state.canEdit;
}

// --- Wiring ----------------------------------------------------------------
function wire() {
  $('vBrandPick').addEventListener('input', () => { $('vBrand').value = $('vBrandPick').value; });
  $('saveVenue').addEventListener('click', saveVenue);
  $('saveTableChanges').addEventListener('click', saveTableChanges);
  $('cancelTableChanges').addEventListener('click', cancelTableChanges);
  $('scheduleSameMode').addEventListener('change', () => {
    if (!state.canEdit) return;
    state.venue.booking_same_mode_all_days = $('scheduleSameMode').checked;
    renderScheduleConfig();
  });
  $('scheduleModeShifts').addEventListener('change', () => {
    if (state.canEdit) state.venue.booking_mode = 'shifts';
  });
  $('scheduleModeFree').addEventListener('change', () => {
    if (state.canEdit) state.venue.booking_mode = 'free';
  });
  $('saveScheduleConfig').addEventListener('click', saveScheduleConfig);
  document.querySelectorAll('[data-schedule-tab]').forEach((button) =>
    button.addEventListener('click', () => setScheduleTab(button.dataset.scheduleTab)));

  $('zoneAdd').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('zoneName').value.trim();
    if (!name) return;
    run(supabase.from('zones').insert({ venue_id: state.venue.id, name, sort_order: state.zones.length + 1 }), 'Zona aggiunta')
      .then((ok) => { if (ok) $('zoneName').value = ''; });
  });

  $('tableAdd').addEventListener('submit', (e) => {
    e.preventDefault();
    const patch = {
      venue_id: state.venue.id,
      code: $('tCode').value.trim(),
      zone_id: $('tZone').value,
      seats_max: parseInt($('tMax').value, 10),
    };
    if (!patch.code || !patch.zone_id) { toast('Inserisci codice e zona.', true); return; }
    if (!(patch.seats_max > 0)) { toast('Posti non validi.', true); return; }
    run(supabase.from('restaurant_tables').insert(patch), 'Tavolo aggiunto').then((ok) => { if (ok) $('tCode').value = ''; });
  });

  $('shiftAdd').addEventListener('submit', (e) => {
    e.preventDefault();
    const patch = {
      venue_id: state.venue.id,
      name: $('sName').value.trim(),
      code: $('sCode').value.trim(),
      start_time: $('sStart').value,
      end_time: $('sEnd').value,
      sort_order: state.shifts.length + 1,
    };
    if (!patch.name || !patch.code) { toast('Inserisci nome e codice.', true); return; }
    if (!(patch.end_time > patch.start_time)) { toast('La fine deve essere dopo l\'inizio.', true); return; }
    run(supabase.from('service_shifts').insert(patch), 'Turno aggiunto').then((ok) => { if (ok) { $('sName').value = ''; $('sCode').value = ''; } });
  });

  $('saveClosure').addEventListener('click', async () => {
    const days = [...$('weekdayBoxes').querySelectorAll('input[data-dow]')].filter((c) => c.checked).map((c) => parseInt(c.dataset.dow, 10));
    const ok = await run(supabase.from('venues').update({ closed_weekdays: days }).eq('id', state.venue.id), 'Chiusure salvate');
    if (ok) state.venue.closed_weekdays = days;
  });
}

init();
