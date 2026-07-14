// Impostazioni: gestione zone, tavoli, orari turni e chiusura settimanale.
// Le scritture su queste tabelle sono consentite dalla RLS solo al ruolo
// 'owner'; per lo staff la pagina è in sola lettura.
import {
  supabase, requireSession, signOut, loadCurrentVenue,
  hhmm, escapeHtml, toast, WEEKDAYS,
} from './app.js';

const $ = (id) => document.getElementById(id);

const state = { session: null, venue: null, role: null, zones: [], tables: [], shifts: [], canEdit: false };

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
    supabase.from('restaurant_tables').select('id, code, seats_min, seats_max, zone_id, active').eq('venue_id', state.venue.id).order('code'),
    supabase.from('service_shifts').select('id, code, name, start_time, end_time, days_of_week, sort_order').eq('venue_id', state.venue.id).order('sort_order'),
  ]);
  if (z.error) throw z.error; if (t.error) throw t.error; if (s.error) throw s.error;
  state.zones = z.data || [];
  state.tables = t.data || [];
  state.shifts = s.data || [];
  renderZones(); renderTables(); renderShifts(); fillZoneSelect();
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
  const zoneName = (id) => escapeHtml(state.zones.find((z) => z.id === id)?.name || '—');
  $('tableRows').innerHTML = state.tables.map((t) => `
    <div class="row-item">
      <input style="width:80px" value="${escapeHtml(t.code)}" data-tid="${t.id}" data-f="code" ${dis()} maxlength="20" />
      <select data-tid="${t.id}" data-f="zone_id" ${dis()}>
        ${state.zones.map((z) => `<option value="${z.id}" ${z.id === t.zone_id ? 'selected' : ''}>${escapeHtml(z.name)}</option>`).join('')}
      </select>
      <input style="width:64px" type="number" min="1" value="${t.seats_min}" data-tid="${t.id}" data-f="seats_min" ${dis()} />
      <input style="width:64px" type="number" min="1" value="${t.seats_max}" data-tid="${t.id}" data-f="seats_max" ${dis()} />
      <label class="pill" style="cursor:pointer"><input type="checkbox" ${t.active ? 'checked' : ''} data-tid="${t.id}" data-f="active" ${dis()} /> attivo</label>
      <button class="btn btn--ghost btn--sm" data-save-table="${t.id}" ${dis()}>Salva</button>
      <button class="act act--warn" data-del-table="${t.id}" ${dis()}>Elimina</button>
    </div>`).join('') || '<div class="res-empty">Nessun tavolo.</div>';

  $('tableRows').querySelectorAll('[data-save-table]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.saveTable;
    const g = (f) => $('tableRows').querySelector(`[data-tid="${id}"][data-f="${f}"]`);
    const patch = {
      code: g('code').value.trim(),
      zone_id: g('zone_id').value,
      seats_min: parseInt(g('seats_min').value, 10),
      seats_max: parseInt(g('seats_max').value, 10),
      active: g('active').checked,
    };
    if (!patch.code || !(patch.seats_max >= patch.seats_min && patch.seats_min > 0)) { toast('Dati tavolo non validi.', true); return; }
    run(supabase.from('restaurant_tables').update(patch).eq('id', id), 'Tavolo aggiornato');
  }));
  $('tableRows').querySelectorAll('[data-del-table]').forEach((b) => b.addEventListener('click', () => {
    if (confirm('Eliminare il tavolo?')) run(supabase.from('restaurant_tables').delete().eq('id', b.dataset.delTable), 'Tavolo eliminato');
  }));
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
      seats_min: parseInt($('tMin').value, 10),
      seats_max: parseInt($('tMax').value, 10),
    };
    if (!patch.code || !patch.zone_id) { toast('Inserisci codice e zona.', true); return; }
    if (!(patch.seats_max >= patch.seats_min && patch.seats_min > 0)) { toast('Posti non validi.', true); return; }
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
