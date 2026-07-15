// Impostazioni: gestione zone, tavoli, orari turni e chiusura settimanale.
// Le scritture su queste tabelle sono consentite dalla RLS solo al ruolo
// 'owner'; per lo staff la pagina è in sola lettura.
import {
  supabase, requireSession, confirmSignOut, loadCurrentVenue,
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
  closures: [],
  canEdit: false,
  dirtyTables: new Set(),
  scheduleConfig: null,
};

const SCHEDULE_CONFIG_KEY = 'booking_admin_schedule_mode';

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
    $('readonlyBanner').hidden = state.canEdit;

    await loadVenueDetails();
    await reloadAll();
    renderThemeSettings();
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
  const [z, t, s, c] = await Promise.all([
    supabase.from('zones').select('id, name, sort_order').eq('venue_id', state.venue.id).order('sort_order'),
    supabase.from('restaurant_tables').select('id, code, seats_max, zone_id, active').eq('venue_id', state.venue.id).order('code'),
    supabase.from('service_shifts').select('id, code, name, start_time, end_time, days_of_week, sort_order').eq('venue_id', state.venue.id).order('sort_order'),
    supabase.from('venue_closures').select('id, closed_date, reason, created_at').eq('venue_id', state.venue.id).order('closed_date', { ascending: true }),
  ]);
  if (z.error) throw z.error; if (t.error) throw t.error; if (s.error) throw s.error; if (c.error) throw c.error;
  state.zones = z.data || [];
  state.tables = t.data || [];
  state.shifts = s.data || [];
  state.closures = c.data || [];
  renderZones(); renderTables(); renderShifts(); renderFreeHours(); renderClosures(); fillZoneSelect();
}

function dis() { return state.canEdit ? '' : 'disabled'; }

function renderThemeSettings() {
  const preference = window.AdminTheme?.getPreference?.() || 'system';
  document.querySelectorAll('input[name="adminTheme"]').forEach((input) => {
    input.checked = input.value === preference;
  });
}

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
  const rows = state.shifts.filter((s) => !isFreeHourShift(s));
  $('shiftRows').innerHTML = rows.map((s) => `
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
function isFreeHourShift(shift) {
  return String(shift?.code || '').startsWith('free_');
}

function freeHourCode(value) {
  const clean = String(value || '').trim().replace(/^free_/, '');
  return `free_${clean}`;
}

function displayFreeHourCode(value) {
  return String(value || '').replace(/^free_/, '');
}

function normalizeScheduleMode(mode) {
  return mode === 'free' ? 'free' : 'shifts';
}

function defaultScheduleDays(mode = 'shifts') {
  return Object.fromEntries(WEEKDAYS.map((day) => [day.n, normalizeScheduleMode(mode)]));
}

function defaultScheduleConfig() {
  return {
    sameMode: true,
    mode: 'shifts',
    days: defaultScheduleDays('shifts'),
  };
}

function scheduleStorageKey() {
  return `${SCHEDULE_CONFIG_KEY}:${state.venue?.id || 'default'}`;
}

function loadScheduleConfig() {
  if ('booking_mode' in (state.venue || {}) || 'booking_same_mode_all_days' in (state.venue || {})) {
    const mode = normalizeScheduleMode(state.venue.booking_mode);
    return {
      sameMode: state.venue.booking_same_mode_all_days !== false,
      mode,
      days: {
        ...defaultScheduleDays(mode),
        ...(state.venue.booking_mode_by_weekday || {}),
      },
    };
  }
  try {
    const parsed = JSON.parse(localStorage.getItem(scheduleStorageKey()) || 'null');
    const base = defaultScheduleConfig();
    if (!parsed || typeof parsed !== 'object') return base;
    return {
      sameMode: parsed.sameMode !== false,
      mode: normalizeScheduleMode(parsed.mode),
      days: {
        ...base.days,
        ...(parsed.days || {}),
      },
    };
  } catch (error) {
    console.warn('[settings] configurazione orari locale non valida:', error);
    return defaultScheduleConfig();
  }
}

function renderScheduleConfig() {
  state.scheduleConfig = state.scheduleConfig || loadScheduleConfig();
  const sameMode = state.scheduleConfig.sameMode !== false;
  const mode = normalizeScheduleMode(state.scheduleConfig.mode);
  const days = {
    ...defaultScheduleDays(mode),
    ...(state.scheduleConfig.days || {}),
  };
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
  const freeRows = state.shifts.filter(isFreeHourShift);
  rows.innerHTML = freeRows.map((s) => `
    <div class="card" style="padding:12px">
      <div class="row-item" style="border:none;padding:0;background:none">
        <input class="row-item__grow" value="${escapeHtml(s.name)}" data-fid="${s.id}" data-f="name" ${dis()} maxlength="40" />
        <input value="${escapeHtml(displayFreeHourCode(s.code))}" data-fid="${s.id}" data-f="code" ${dis()} maxlength="30" />
        <input type="time" value="${hhmm(s.start_time)}" data-fid="${s.id}" data-f="start" ${dis()} />
        <input type="time" value="${hhmm(s.end_time)}" data-fid="${s.id}" data-f="end" ${dis()} />
        <button class="btn btn--ghost btn--sm" data-save-free-hour="${s.id}" ${dis()}>Salva</button>
        <button class="act act--warn" data-del-free-hour="${s.id}" ${dis()}>Elimina</button>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px">
        ${WEEKDAYS.map((d) => `<label class="pill" style="cursor:pointer">
          <input type="checkbox" data-fid="${s.id}" data-dow="${d.n}" ${(s.days_of_week || []).includes(d.n) ? 'checked' : ''} ${dis()} /> ${d.short}
        </label>`).join('')}
      </div>
    </div>`).join('') || '<div class="res-empty">Nessun orario libero.</div>';

  rows.querySelectorAll('[data-save-free-hour]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.saveFreeHour;
    const g = (f) => rows.querySelector(`[data-fid="${id}"][data-f="${f}"]`);
    const days = [...rows.querySelectorAll(`input[data-fid="${id}"][data-dow]`)].filter((c) => c.checked).map((c) => parseInt(c.dataset.dow, 10));
    const patch = {
      name: g('name').value.trim(),
      code: freeHourCode(g('code').value),
      start_time: g('start').value,
      end_time: g('end').value,
      days_of_week: days,
    };
    if (!patch.name || !displayFreeHourCode(patch.code) || !(patch.end_time > patch.start_time)) {
      toast('Orario libero non valido (fine dopo inizio).', true);
      return;
    }
    run(supabase.from('service_shifts').update(patch).eq('id', id), 'Orario libero aggiornato');
  }));
  rows.querySelectorAll('[data-del-free-hour]').forEach((b) => b.addEventListener('click', () => {
    if (confirm('Eliminare l\'orario libero? Non deve avere prenotazioni collegate.'))
      run(supabase.from('service_shifts').delete().eq('id', b.dataset.delFreeHour), 'Orario libero eliminato');
  }));
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
    toast('Configurazione orari non salvata. Applica prima la migration del database.', true);
    return;
  }
  state.venue = { ...state.venue, ...(data || patch) };
  state.scheduleConfig = null;
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

// --- Chiusure straordinarie ----------------------------------------------
function formatDateLabel(iso) {
  if (!iso) return '—';
  const [year, month, day] = String(iso).split('-').map(Number);
  const date = new Date(year, month - 1, day, 12);
  return date.toLocaleDateString('it-IT', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
}

function addDaysToIso(iso, amount) {
  const [year, month, day] = String(iso).split('-').map(Number);
  const date = new Date(year, month - 1, day, 12);
  date.setDate(date.getDate() + amount);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function datesInRange(start, end) {
  const dates = [];
  let cursor = start;
  while (cursor <= end && dates.length < 370) {
    dates.push(cursor);
    cursor = addDaysToIso(cursor, 1);
  }
  return dates;
}

function renderClosures() {
  const rows = $('closureRows');
  if (!rows) return;
  $('closureStart').disabled = !state.canEdit;
  $('closureEnd').disabled = !state.canEdit;
  $('closureReason').disabled = !state.canEdit;
  $('addClosureBtn').disabled = !state.canEdit;
  rows.innerHTML = state.closures.length
    ? state.closures.map((closure) => `
      <div class="row-item closure-row">
        <span class="closure-row__date">${escapeHtml(formatDateLabel(closure.closed_date))}</span>
        <span class="closure-row__reason">${escapeHtml(closure.reason || 'Nessun motivo indicato')}</span>
        <button class="act act--warn" data-del-closure="${escapeHtml(closure.id)}" ${dis()}>Elimina</button>
      </div>`).join('')
    : '<div class="res-empty">Nessuna chiusura straordinaria inserita.</div>';

  rows.querySelectorAll('[data-del-closure]').forEach((button) =>
    button.addEventListener('click', () => deleteClosure(button.dataset.delClosure)));
}

async function addClosure(event) {
  event.preventDefault();
  if (!state.canEdit) return;
  const start = $('closureStart').value;
  const end = $('closureEnd').value || start;
  const reason = $('closureReason').value.trim() || null;
  if (!start) { toast('Seleziona una data di chiusura.', true); return; }
  if (end < start) { toast('La data finale deve essere successiva o uguale alla data iniziale.', true); return; }
  const dates = datesInRange(start, end);
  if (!dates.length) { toast('Intervallo non valido.', true); return; }
  if (dates.length >= 370) { toast('Intervallo troppo lungo.', true); return; }

  $('addClosureBtn').disabled = true;
  try {
    const payload = dates.map((closedDate) => ({
      venue_id: state.venue.id,
      closed_date: closedDate,
      reason,
    }));
    const { error } = await supabase
      .from('venue_closures')
      .upsert(payload, { onConflict: 'venue_id,closed_date' });
    if (error) throw error;
    $('closureAdd').reset();
    toast(dates.length === 1 ? 'Chiusura aggiunta.' : 'Intervallo di chiusura aggiunto.');
    await reloadAll();
  } catch (error) {
    console.error(error);
    toast(error.message?.includes('row-level') ? 'Permesso negato (solo titolare).' : 'Chiusura non salvata.', true);
  } finally {
    $('addClosureBtn').disabled = !state.canEdit;
  }
}

async function deleteClosure(id) {
  if (!state.canEdit || !id) return;
  const { error } = await supabase.from('venue_closures').delete().eq('id', id);
  if (error) {
    console.error(error);
    toast(error.message?.includes('row-level') ? 'Permesso negato (solo titolare).' : 'Eliminazione non riuscita.', true);
    return;
  }
  toast('Chiusura eliminata.');
  await reloadAll();
}

// --- Wiring ----------------------------------------------------------------
function wire() {
  document.querySelectorAll('input[name="adminTheme"]').forEach((input) =>
    input.addEventListener('change', () => {
      if (!input.checked) return;
      window.AdminTheme?.setPreference?.(input.value);
      renderThemeSettings();
    }));
  $('vBrandPick').addEventListener('input', () => { $('vBrand').value = $('vBrandPick').value; });
  $('saveVenue').addEventListener('click', saveVenue);
  $('saveTableChanges').addEventListener('click', saveTableChanges);
  $('cancelTableChanges').addEventListener('click', cancelTableChanges);
  $('scheduleSameMode').addEventListener('change', () => {
    if (!state.canEdit) return;
    state.scheduleConfig = state.scheduleConfig || loadScheduleConfig();
    state.scheduleConfig.sameMode = $('scheduleSameMode').checked;
    renderScheduleConfig();
  });
  $('scheduleModeShifts').addEventListener('change', () => {
    if (state.canEdit) {
      state.scheduleConfig = state.scheduleConfig || loadScheduleConfig();
      state.scheduleConfig.mode = 'shifts';
    }
  });
  $('scheduleModeFree').addEventListener('change', () => {
    if (state.canEdit) {
      state.scheduleConfig = state.scheduleConfig || loadScheduleConfig();
      state.scheduleConfig.mode = 'free';
    }
  });
  $('saveScheduleConfig').addEventListener('click', saveScheduleConfig);
  document.querySelectorAll('[data-schedule-tab]').forEach((button) =>
    button.addEventListener('click', () => setScheduleTab(button.dataset.scheduleTab)));
  $('closureAdd').addEventListener('submit', addClosure);

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

  $('freeHourAdd').addEventListener('submit', (e) => {
    e.preventDefault();
    const patch = {
      venue_id: state.venue.id,
      name: $('fName').value.trim(),
      code: freeHourCode($('fCode').value),
      start_time: $('fStart').value,
      end_time: $('fEnd').value,
      sort_order: state.shifts.length + 1,
    };
    if (!patch.name || !displayFreeHourCode(patch.code)) { toast('Inserisci nome e codice.', true); return; }
    if (!(patch.end_time > patch.start_time)) { toast('La fine deve essere dopo l\'inizio.', true); return; }
    run(supabase.from('service_shifts').insert(patch), 'Orario libero aggiunto')
      .then((ok) => { if (ok) { $('fName').value = ''; $('fCode').value = ''; } });
  });

  $('saveClosure').addEventListener('click', async () => {
    const days = [...$('weekdayBoxes').querySelectorAll('input[data-dow]')].filter((c) => c.checked).map((c) => parseInt(c.dataset.dow, 10));
    const ok = await run(supabase.from('venues').update({ closed_weekdays: days }).eq('id', state.venue.id), 'Chiusure salvate');
    if (ok) state.venue.closed_weekdays = days;
  });
}

init();
