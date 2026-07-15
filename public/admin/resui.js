// UI condivisa delle prenotazioni: transizioni di stato, rendering di una
// riga/card e aggancio delle azioni. Usato da dashboard.js e upcoming.js.
import { STATUS_LABEL, escapeHtml } from './app.js';
import { openTableMapSelector } from './table-map-selector.js';

// Transizioni di stato disponibili per ciascuno stato corrente.
export const TRANSITIONS = {
  in_attesa:  [{ to: 'confermata', label: 'Conferma', cls: 'act--ok' }, { to: 'annullata', label: 'Rifiuta', cls: 'act--warn' }],
  confermata: [
    { to: 'arrivato', label: 'Arrivato', cls: 'act--go' },
    { to: 'no_show', label: 'Non presentato', cls: 'act--warn' },
    { to: 'annullata', label: 'Annulla prenotazione', cls: 'act--mute' },
  ],
  arrivato:   [{ to: 'terminato', label: 'Terminato', cls: 'act--ok' }],
  no_show:    [{ to: 'confermata', label: 'Ripristina', cls: 'act--mute' }],
  annullata:  [{ to: 'in_attesa', label: 'Ripristina', cls: 'act--mute' }],
};

// Ordine di visualizzazione: attive prima, chiuse in fondo.
export function statusRank(s) {
  return { in_attesa: 0, confermata: 1, arrivato: 2, terminato: 3, no_show: 4, annullata: 5 }[s] ?? 9;
}

// HTML di una card prenotazione. opts.timeLabel appare nella colonna sinistra
// (nella dashboard è l'ora del turno, in "In arrivo" può essere l'ora del turno).
export function reservationCardHtml(r, opts = {}) {
  const acts = (TRANSITIONS[r.status] || []).map((t) =>
    `<button class="act ${t.cls}" data-id="${r.id}" data-to="${t.to}">${t.label}</button>`).join('');
  const emailBadge = emailVerificationBadgeHtml(r);
  const tableControl = tableAssignmentHtml(r, opts);
  const partyControl = partySizeHtml(r, opts);
  const quickActions = reservationQuickActionsHtml(r, opts);
  const timer = reservationTimerHtml(r, opts);
  const stateClasses = [`res--status-${r.status}`, reservationDelayClass(r, opts)].filter(Boolean).join(' ');
  const capacityWarning = opts.capacityWarning
    ? '<span class="party-capacity-warning">La capienza dei tavoli assegnati non è più sufficiente. Modifica l’assegnazione dei tavoli.</span>'
    : '';
  return `
    <div class="res ${stateClasses}">
      <div class="res__time"><span>${escapeHtml(opts.timeLabel || '')}</span>${timer}</div>
      <div class="res__main">
        <div class="res__name">${escapeHtml(r.customer_last_name)} ${escapeHtml(r.customer_first_name)}
          ${r.source === 'widget' ? '<span class="pill">widget</span>' : ''}</div>
        <div class="res__meta">
          <a href="tel:${escapeHtml(r.customer_phone)}">${escapeHtml(r.customer_phone)}</a>
          ${partyControl}
          <span>${opts.tableCode ? 'Tavolo ' + escapeHtml(opts.tableCode) : 'Tavolo non assegnato'}</span>
          ${opts.shiftName ? `<span>${escapeHtml(opts.shiftName)}</span>` : ''}
          ${emailBadge}
          ${capacityWarning}
        </div>
        ${tableControl}
        ${r.notes ? `<div class="res__notes">${escapeHtml(r.notes)}</div>` : ''}
      </div>
      <div class="res__side">
        ${quickActions}
        <span class="badge badge--${r.status}">${escapeHtml(STATUS_LABEL[r.status] || r.status)}</span>
      </div>
      ${acts ? `<div class="res__actions">${acts}</div>` : ''}
    </div>`;
}

function reservationQuickActionsHtml(r, opts = {}) {
  const actions = [];
  if (r.customer_phone) {
    actions.push(`<a href="https://wa.me/${escapeHtml(String(r.customer_phone).replace(/\D/g, ''))}" target="_blank" rel="noopener">Chiama WhatsApp</a>`);
  }
  if (r.customer_email) actions.push(`<a href="mailto:${escapeHtml(r.customer_email)}">Scrivi email</a>`);
  if (!actions.length) return '';
  return `<details class="quick-menu">
    <summary aria-label="Azioni rapide"><span aria-hidden="true">•••</span></summary>
    <div class="quick-menu__panel">${actions.join('')}</div>
  </details>`;
}

function reservationTimerHtml(r, opts = {}) {
  const date = r.reservation_date || '';
  const time = String(opts.timeLabel || '').slice(0, 5);
  if (!['in_attesa', 'confermata'].includes(r.status)) return '';
  if (!date || !time) return '';
  const diff = reservationMinuteDiff(date, time);
  if (diff === null || diff >= 0) return '';
  return `<small class="res__timer" data-res-timer data-res-date="${escapeHtml(date)}" data-res-time="${escapeHtml(time)}" data-res-status="${escapeHtml(r.status)}"></small>`;
}

function reservationDelayClass(r, opts = {}) {
  if (!['in_attesa', 'confermata'].includes(r.status)) return '';
  const diff = reservationMinuteDiff(r.reservation_date, opts.timeLabel);
  if (diff === null || diff >= 0) return '';
  const late = Math.abs(diff);
  if (late >= 30) return 'res--late-strong';
  if (late >= 10) return 'res--late';
  return '';
}

function reservationMinuteDiff(date, time) {
  const cleanTime = String(time || '').slice(0, 5);
  if (!date || !/^\d{2}:\d{2}$/.test(cleanTime)) return null;
  const target = new Date(`${date}T${cleanTime}:00`);
  if (Number.isNaN(target.getTime())) return null;
  return Math.round((target.getTime() - Date.now()) / 60000);
}

let quickMenuDismissalBound = false;
let reservationTimerInterval = null;

function closeQuickMenus(except = null) {
  document.querySelectorAll('.quick-menu[open]').forEach((menu) => {
    if (menu !== except) menu.removeAttribute('open');
  });
}

function wireQuickMenuDismissal(container) {
  container.querySelectorAll('.quick-menu').forEach((menu) => {
    menu.addEventListener('toggle', () => {
      if (menu.open) closeQuickMenus(menu);
    });
    menu.querySelectorAll('a, button').forEach((item) =>
      item.addEventListener('click', () => menu.removeAttribute('open')));
  });
  if (quickMenuDismissalBound) return;
  quickMenuDismissalBound = true;
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.quick-menu')) closeQuickMenus();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeQuickMenus();
  });
  window.addEventListener('pagehide', () => closeQuickMenus());
  window.addEventListener('scroll', () => closeQuickMenus(), { passive: true });
}

export function wireReservationTimers(container = document) {
  updateReservationTimers(container);
  clearInterval(reservationTimerInterval);
  reservationTimerInterval = setInterval(() => updateReservationTimers(document), 60000);
}

function updateReservationTimers(scope = document) {
  scope.querySelectorAll('[data-res-timer]').forEach((timer) => {
    const diff = reservationMinuteDiff(timer.dataset.resDate, timer.dataset.resTime);
    if (diff === null) {
      timer.textContent = '';
      return;
    }
    const status = timer.dataset.resStatus;
    const minutes = Math.abs(diff);
    if (!['in_attesa', 'confermata'].includes(status)) {
      timer.textContent = '';
    } else if (diff >= 0) {
      timer.textContent = '';
    } else {
      timer.textContent = `Ritardo ${minutes} min`;
    }
  });
}

function partySizeHtml(r, opts = {}) {
  if (!opts.canEditPartySize) return `<span>${escapeHtml(r.party_size)} persone</span>`;
  return `<span class="party-editor" data-party-editor="${escapeHtml(r.id)}">
    <span class="party-view" data-party-view>
      <span><strong data-party-value>${escapeHtml(r.party_size)}</strong> persone</span>
      <button class="act act--mute" type="button" data-party-edit="${escapeHtml(r.id)}">Modifica</button>
    </span>
    <span class="party-view" data-party-form hidden>
      <input class="party-edit-input" type="number" min="1" step="1" inputmode="numeric" value="${escapeHtml(r.party_size)}" data-party-input aria-label="Numero persone" />
      <button class="act act--ok" type="button" data-party-save="${escapeHtml(r.id)}">Salva</button>
      <button class="act act--mute" type="button" data-party-cancel="${escapeHtml(r.id)}">Annulla</button>
    </span>
  </span>`;
}

function tableAssignmentHtml(r, opts = {}) {
  if (!Array.isArray(opts.tableOptions)) return '';
  const partySize = Number(r.party_size || 0);
  const hasSingleTableAvailable = opts.tableOptions.some((table) =>
    !table.disabled && Number(table.seatsMax || 0) >= partySize);
  const selectionMode = hasSingleTableAvailable ? 'single' : 'multi';
  const rawSelectedIds = new Set(Array.isArray(r.table_ids) && r.table_ids.length ? r.table_ids : [r.table_id].filter(Boolean));
  const selectedIds = selectionMode === 'single' ? new Set([...rawSelectedIds].slice(0, 1)) : rawSelectedIds;
  const selectedTables = opts.tableOptions.filter((table) => selectedIds.has(table.id));
  const selectedCodes = selectedTables.map((table) => table.code).filter(Boolean);
  const selectedSeats = selectedTables.reduce((sum, table) => sum + (table.seatsMax || 0), 0);
  const summary = selectedCodes.length ? selectedCodes.join(' + ') : 'Tavolo non assegnato';
  const options = opts.tableOptions.map((table) => {
    const selected = selectedIds.has(table.id);
    const disabled = table.disabled && !selected;
    const status = table.busy && !selected ? 'Occupato' : table.disabled && !selected ? 'Fuori servizio' : 'Disponibile';
    return `<label class="table-picker__option${disabled ? ' is-disabled' : ''}" data-zone="${escapeHtml(table.zoneName || 'Sala')}" data-guest="${escapeHtml(table.guestName || '')}" data-detail="${escapeHtml(table.guestDetail || '')}" data-guest-phone="${escapeHtml(table.guestPhone || '')}" data-guest-email="${escapeHtml(table.guestEmail || '')}" data-guest-notes="${escapeHtml(table.guestNotes || '')}" data-guest-party="${escapeHtml(table.guestParty || '')}" data-guest-time="${escapeHtml(table.guestTime || '')}" data-guest-status="${escapeHtml(table.guestStatus || '')}">
      <input type="checkbox" data-table-choice="${escapeHtml(table.id)}" ${selected ? 'checked' : ''} ${disabled ? 'disabled' : ''} />
      <span class="table-picker__check" aria-hidden="true"></span>
      <span class="table-picker__main">
        <strong>${escapeHtml(table.code)}</strong>
        <small>${escapeHtml(table.seatsMax)} posti</small>
      </span>
      <span class="table-picker__status">${escapeHtml(status)}</span>
    </label>`;
  }).join('');
  return `<div class="res__table-assign" data-party-size="${escapeHtml(r.party_size || 0)}" data-selection-mode="${selectionMode}" data-reservation-first-name="${escapeHtml(r.customer_first_name || '')}" data-reservation-last-name="${escapeHtml(r.customer_last_name || '')}" data-reservation-time="${escapeHtml(opts.timeLabel || '')}" data-reservation-shift="${escapeHtml(opts.shiftName || '')}">
    <div class="table-picker" data-table-picker="${escapeHtml(r.id)}" data-selection-mode="${selectionMode}">
      <button class="table-picker__button" type="button" data-table-picker-toggle aria-expanded="false">
        <span data-table-picker-label>${escapeHtml(summary)}</span>
        <span aria-hidden="true">▾</span>
      </button>
      <div class="table-picker__menu" data-table-picker-menu hidden>${options}</div>
    </div>
    <button class="act act--mute" type="button" data-table-save="${escapeHtml(r.id)}">${selectedCodes.length ? 'Cambia tavolo' : 'Assegna tavoli'}</button>
    <div class="table-picker__summary" data-table-summary>
      <span>Tavoli selezionati: <strong data-table-summary-codes>${escapeHtml(selectedCodes.join(' + ') || '—')}</strong></span>
      <span>Capienza totale: <strong data-table-summary-seats>${selectedSeats}</strong> posti</span>
      <span>Prenotazione: <strong>${escapeHtml(r.party_size || 0)}</strong> persone</span>
      <span class="table-picker__error" data-table-summary-error hidden>Seleziona altri tavoli: la capienza attuale non è sufficiente.</span>
    </div>
  </div>`;
}

function emailVerificationBadgeHtml(r) {
  if (!r.customer_email) return '<span class="email-badge email-badge--none">Nessuna email</span>';
  if (r.email_verified) return '<span class="email-badge email-badge--verified">Email verificata</span>';
  return '<span class="email-badge email-badge--unverified">Email non verificata</span>';
}

// Aggancia i click delle azioni di stato dentro `container`.
export function wireRowActions(container, onChange) {
  container.querySelectorAll('.act[data-id][data-to]').forEach((b) =>
    b.addEventListener('click', () => onChange(b.dataset.id, b.dataset.to)));
  container.querySelectorAll('.quick-menu [data-id][data-to]').forEach((b) =>
    b.addEventListener('click', () => onChange(b.dataset.id, b.dataset.to)));
}

export function wireReservationQuickActions(container) {
  wireQuickMenuDismissal(container);
}

export function wirePartySizeEditing(container, onSave) {
  container.querySelectorAll('[data-party-editor]').forEach((editor) => {
    const id = editor.dataset.partyEditor;
    const view = editor.querySelector('[data-party-view]');
    const form = editor.querySelector('[data-party-form]');
    const input = editor.querySelector('[data-party-input]');
    const value = parseInt(input?.value || '1', 10) || 1;

    input?.addEventListener('input', () => {
      input.value = String(input.value || '').replace(/\D/g, '');
    });

    editor.querySelector('[data-party-edit]')?.addEventListener('click', () => {
      if (view) view.hidden = true;
      if (form) form.hidden = false;
      if (input) {
        input.value = String(value);
        input.focus({ preventScroll: true });
        input.select();
      }
    });

    editor.querySelector('[data-party-cancel]')?.addEventListener('click', () => {
      if (input) input.value = String(value);
      if (form) form.hidden = true;
      if (view) view.hidden = false;
    });

    editor.querySelector('[data-party-save]')?.addEventListener('click', async () => {
      const next = parseInt(String(input?.value || '').replace(/\D/g, ''), 10);
      if (!Number.isInteger(next) || next < 1) {
        if (input) input.value = String(value);
        await onSave(id, next, value);
        return;
      }
      await onSave(id, next, value);
    });
  });
}

export function createPartySizeUpdater({ supabase, toast, getReservations, reload, rerender }) {
  return async function updatePartySize(id, nextPartySize, previousPartySize) {
    const reservation = getReservations().find((row) => row.id === id);
    if (!reservation) return;
    const partySize = Number.parseInt(nextPartySize, 10);
    if (!Number.isInteger(partySize) || partySize < 1) {
      toast('Inserisci un numero di persone valido.', true);
      return;
    }
    if (partySize === previousPartySize) {
      rerender();
      return;
    }
    try {
      const { error } = await supabase
        .from('reservations')
        .update({ party_size: partySize })
        .eq('id', id);
      if (error) throw error;
      toast('Numero di persone aggiornato.');
      await reload();
    } catch (error) {
      console.error('[reservations] aggiornamento persone fallito:', error);
      toast('Impossibile aggiornare il numero di persone.', true);
      await reload();
    }
  };
}

export function wireTableAssignment(container, onAssign) {
  container.querySelectorAll('[data-table-picker]').forEach((picker) => {
    picker.closest('.res__table-assign')?.classList.add('is-map-enabled');
    enforceTableSelectionMode(picker);
    refreshTablePicker(picker);
    const toggle = picker.querySelector('[data-table-picker-toggle]');
    const menu = picker.querySelector('[data-table-picker-menu]');
    toggle?.addEventListener('click', () => {
      const open = menu.hidden;
      menu.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    picker.querySelectorAll('[data-table-choice]').forEach((choice) =>
      choice.addEventListener('change', () => {
        if (choice.checked) enforceTableSelectionMode(picker, choice);
        refreshTablePicker(picker);
      }));
  });
  container.querySelectorAll('[data-table-save]').forEach((button) =>
    button.addEventListener('click', async () => {
      const box = button.closest('.res__table-assign');
      const picker = box?.querySelector('[data-table-picker]');
      const opened = openTableMapSelector({
        box,
        picker,
        saveButton: button,
        reservation: reservationContext(box),
        onConfirm: () => saveTableAssignment(button, onAssign),
      });
      if (!opened) await saveTableAssignment(button, onAssign);
    }));
}

async function saveTableAssignment(button, onAssign) {
  const id = button.dataset.tableSave;
  const box = button.closest('.res__table-assign');
  const picker = box?.querySelector('[data-table-picker]');
  const ids = picker ? selectedTableIds(picker) : [];
  const totalSeats = tablePickerSeats(picker);
  const partySize = parseInt(box?.dataset.partySize || '0', 10) || 0;
  const error = box?.querySelector('[data-table-summary-error]');
  if (ids.length && totalSeats < partySize) {
    if (error) error.hidden = false;
    return false;
  }
  const selectionMode = box?.dataset.selectionMode || picker?.dataset.selectionMode || 'multi';
  return await onAssign(id, selectionMode === 'single' ? (ids[0] || null) : ids);
}

function reservationContext(box) {
  return {
    firstName: box?.dataset.reservationFirstName || '',
    lastName: box?.dataset.reservationLastName || '',
    timeLabel: box?.dataset.reservationTime || '',
    shiftName: box?.dataset.reservationShift || '',
  };
}

function enforceTableSelectionMode(picker, activeChoice = null) {
  if (picker?.dataset.selectionMode !== 'single') return;
  const checked = [...picker.querySelectorAll('[data-table-choice]:checked')];
  const keep = activeChoice || checked[0];
  checked.forEach((input) => {
    if (input !== keep) input.checked = false;
  });
}

function selectedTableIds(picker) {
  const checked = [...picker.querySelectorAll('[data-table-choice]:checked')];
  const choices = picker?.dataset.selectionMode === 'single' ? checked.slice(0, 1) : checked;
  return choices.map((input) => input.dataset.tableChoice).filter(Boolean);
}

function tablePickerSeats(picker) {
  return [...picker.querySelectorAll('[data-table-choice]:checked')].reduce((sum, input) => {
    const seats = parseInt(input.closest('.table-picker__option')?.querySelector('small')?.textContent || '0', 10);
    return sum + (Number.isFinite(seats) ? seats : 0);
  }, 0);
}

function refreshTablePicker(picker) {
  const box = picker.closest('.res__table-assign');
  const checked = [...picker.querySelectorAll('[data-table-choice]:checked')];
  const codes = checked.map((input) => input.closest('.table-picker__option')?.querySelector('strong')?.textContent || '').filter(Boolean);
  const seats = tablePickerSeats(picker);
  const partySize = parseInt(box?.dataset.partySize || '0', 10) || 0;
  const label = picker.querySelector('[data-table-picker-label]');
  const codesEl = box?.querySelector('[data-table-summary-codes]');
  const seatsEl = box?.querySelector('[data-table-summary-seats]');
  const error = box?.querySelector('[data-table-summary-error]');
  if (label) label.textContent = codes.length <= 2 ? (codes.join(' + ') || 'Tavolo non assegnato') : `${codes.length} tavoli selezionati`;
  if (codesEl) codesEl.textContent = codes.join(' + ') || '—';
  if (seatsEl) seatsEl.textContent = String(seats);
  if (error) error.hidden = !codes.length || seats >= partySize;
}

// HTML di una voce della lista d'attesa. `position` è la posizione in coda
// (1-based). Espone due azioni: promuovi (→ prenotazione) e rimuovi.
export function waitlistCardHtml(w, position, opts = {}) {
  return `
    <div class="res res--wait">
      <div class="res__time res__pos">#${position}</div>
      <div class="res__main">
        <div class="res__name">${escapeHtml(w.customer_last_name)} ${escapeHtml(w.customer_first_name)}
          <span class="pill">lista d'attesa</span></div>
        <div class="res__meta">
          <a href="tel:${escapeHtml(w.customer_phone)}">${escapeHtml(w.customer_phone)}</a>
          <span>${w.party_size} persone</span>
          ${opts.shiftName ? `<span>${escapeHtml(opts.shiftName)}</span>` : ''}
        </div>
        ${w.notes ? `<div class="res__notes">${escapeHtml(w.notes)}</div>` : ''}
      </div>
      <div class="res__actions">
        <button class="act act--ok" data-wl-promote="${w.id}">Promuovi</button>
        <button class="act act--mute" data-wl-remove="${w.id}">Rimuovi</button>
      </div>
    </div>`;
}

// Aggancia i click delle azioni della lista d'attesa dentro `container`.
export function wireWaitlistActions(container, onPromote, onRemove) {
  container.querySelectorAll('[data-wl-promote]').forEach((b) =>
    b.addEventListener('click', () => onPromote(b.dataset.wlPromote)));
  container.querySelectorAll('[data-wl-remove]').forEach((b) =>
    b.addEventListener('click', () => onRemove(b.dataset.wlRemove)));
}
