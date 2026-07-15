import { STATUS_LABEL, escapeHtml, formatLong } from './app.js';

let ctx = null;
let activeReservation = null;
let activeProfile = null;
let activeHistory = [];

export function initCustomerCrm(context) {
  ctx = context;
  ensureModal();
}

export function wireCustomerCards(container, reservations) {
  ensureModal();
  container.querySelectorAll('[data-customer-card]').forEach((button) =>
    button.addEventListener('click', () => {
      const reservation = reservations.find((row) => row.id === button.dataset.customerCard);
      if (reservation) openCustomerCard(reservation);
    }));
}

function ensureModal() {
  if (document.getElementById('customerCrmModal')) return;
  const modal = document.createElement('div');
  modal.className = 'crm-modal';
  modal.id = 'customerCrmModal';
  modal.hidden = true;
  modal.innerHTML = `
    <div class="crm-modal__overlay" data-crm-close></div>
    <section class="crm-card" role="dialog" aria-modal="true" aria-labelledby="crmTitle">
      <div class="crm-card__head">
        <div>
          <p class="crm-eyebrow">Mini CRM</p>
          <h2 id="crmTitle">Scheda cliente</h2>
        </div>
        <button class="act act--mute" type="button" data-crm-close>Chiudi</button>
      </div>
      <div class="crm-card__body" id="crmBody"></div>
    </section>`;
  document.body.appendChild(modal);
  modal.querySelectorAll('[data-crm-close]').forEach((node) =>
    node.addEventListener('click', closeCustomerCard));
}

async function openCustomerCard(reservation) {
  activeReservation = reservation;
  const modal = document.getElementById('customerCrmModal');
  modal.hidden = false;
  modal.querySelector('#crmBody').innerHTML = '<div class="crm-loading">Carico scheda cliente...</div>';
  try {
    const identity = customerIdentity(reservation);
    if (!identity) {
      modal.querySelector('#crmBody').innerHTML = '<div class="res-empty">Questo cliente non ha email o telefono validi per creare la scheda.</div>';
      return;
    }
    const [profile, history] = await Promise.all([
      loadProfile(identity),
      loadHistory(identity),
    ]);
    activeProfile = profile;
    activeHistory = history;
    renderCustomerCard(identity);
  } catch (error) {
    console.error('[customer-crm] apertura scheda cliente fallita:', error);
    modal.querySelector('#crmBody').innerHTML = '<div class="form-error">Impossibile caricare la scheda cliente.</div>';
  }
}

function closeCustomerCard() {
  const modal = document.getElementById('customerCrmModal');
  if (modal) modal.hidden = true;
  activeReservation = null;
  activeProfile = null;
  activeHistory = [];
}

function customerIdentity(reservation) {
  const email = String(reservation.customer_email || '').trim().toLowerCase();
  if (email) return { type: 'email', key: email };
  const phone = normalizePhone(reservation.customer_phone);
  if (phone) return { type: 'phone', key: phone };
  return null;
}

async function loadProfile(identity) {
  const { data, error } = await ctx.supabase
    .from('customer_profiles')
    .select('*')
    .eq('venue_id', ctx.state.venue.id)
    .eq('identity_type', identity.type)
    .eq('identity_key', identity.key)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function loadHistory(identity) {
  let query = ctx.supabase
    .from('reservations')
    .select('id, reservation_date, shift_id, party_size, customer_first_name, customer_last_name, customer_phone, customer_email, notes, status, source, table_id, created_at')
    .eq('venue_id', ctx.state.venue.id)
    .order('reservation_date', { ascending: false })
    .order('created_at', { ascending: false });
  query = identity.type === 'email'
    ? query.ilike('customer_email', identity.key)
    : query.eq('customer_phone', activeReservation.customer_phone);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

function renderCustomerCard(identity) {
  const modal = document.getElementById('customerCrmModal');
  const body = modal.querySelector('#crmBody');
  const stats = customerStats(activeHistory);
  const p = activeProfile || {};
  const fullName = `${p.last_name || activeReservation.customer_last_name || ''} ${p.first_name || activeReservation.customer_first_name || ''}`.trim();

  body.innerHTML = `
    <div class="crm-hero">
      <div>
        <h3>${escapeHtml(fullName || 'Cliente')}</h3>
        <p>${escapeHtml(activeReservation.customer_email || 'Nessuna email')} · ${escapeHtml(activeReservation.customer_phone || 'Nessun telefono')}</p>
      </div>
      <label class="crm-vip"><input id="crmVip" type="checkbox" ${p.is_vip ? 'checked' : ''} /> Cliente VIP</label>
    </div>
    <div class="crm-kpis">
      <div><strong>${stats.total}</strong><span>Prenotazioni</span></div>
      <div><strong>${stats.noShows}</strong><span>Non presentato</span></div>
      <div><strong>${stats.lastVisit || '—'}</strong><span>Ultima visita</span></div>
      <div><strong>${stats.avgCovers}</strong><span>Media coperti</span></div>
    </div>
    <div class="crm-form">
      <div class="field"><label>Compleanno</label><input id="crmBirthday" type="date" value="${escapeHtml(p.birthday || '')}" /></div>
      <div class="field"><label>Allergie</label><textarea id="crmAllergies" rows="3" placeholder="Es. glutine, lattosio...">${escapeHtml(p.allergies || '')}</textarea></div>
      <div class="field"><label>Note cliente</label><textarea id="crmNotes" rows="4" placeholder="Preferenze, abitudini, richieste ricorrenti...">${escapeHtml(p.notes || '')}</textarea></div>
      <button class="btn btn--primary" id="crmSave" type="button">Salva scheda cliente</button>
    </div>
    <div class="crm-history">
      <h3>Storico prenotazioni</h3>
      ${activeHistory.length ? activeHistory.map(historyRow).join('') : '<div class="res-empty">Nessuno storico disponibile.</div>'}
    </div>`;

  modal.querySelector('#crmSave').addEventListener('click', () => saveProfile(identity));
}

function historyRow(row) {
  return `<div class="crm-history__row">
    <div>
      <strong>${escapeHtml(formatLong(row.reservation_date))}</strong>
      <span>${row.party_size} persone · ${escapeHtml(STATUS_LABEL[row.status] || row.status)}</span>
    </div>
    ${row.notes ? `<p>${escapeHtml(row.notes)}</p>` : ''}
  </div>`;
}

function customerStats(rows) {
  const total = rows.length;
  const noShows = rows.filter((row) => row.status === 'no_show').length;
  const completed = rows.filter((row) => ['arrivato', 'confermata'].includes(row.status));
  const last = completed
    .filter((row) => row.reservation_date <= todayISO())
    .sort((a, b) => b.reservation_date.localeCompare(a.reservation_date))[0];
  const avg = total ? rows.reduce((sum, row) => sum + (row.party_size || 0), 0) / total : 0;
  return {
    total,
    noShows,
    lastVisit: last ? formatLong(last.reservation_date) : null,
    avgCovers: avg ? avg.toFixed(1).replace('.', ',') : '0',
  };
}

async function saveProfile(identity) {
  const payload = {
    venue_id: ctx.state.venue.id,
    identity_type: identity.type,
    identity_key: identity.key,
    first_name: activeReservation.customer_first_name || null,
    last_name: activeReservation.customer_last_name || null,
    email: activeReservation.customer_email || null,
    phone: activeReservation.customer_phone || null,
    is_vip: document.getElementById('crmVip').checked,
    allergies: document.getElementById('crmAllergies').value.trim() || null,
    notes: document.getElementById('crmNotes').value.trim() || null,
    birthday: document.getElementById('crmBirthday').value || null,
  };
  const { data, error } = await ctx.supabase
    .from('customer_profiles')
    .upsert(payload, { onConflict: 'venue_id,identity_type,identity_key' })
    .select('*')
    .single();
  if (error) {
    console.error('[customer-crm] salvataggio scheda fallito:', error);
    ctx.toast('Scheda cliente non salvata.', true);
    return;
  }
  activeProfile = data;
  ctx.toast('Scheda cliente salvata.');
  renderCustomerCard(identity);
}

function normalizePhone(value) {
  return String(value || '').replace(/[^\d+]/g, '').trim();
}

function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
