// UI condivisa delle prenotazioni: transizioni di stato, rendering di una
// riga/card e aggancio delle azioni. Usato da dashboard.js e upcoming.js.
import { STATUS_LABEL, escapeHtml } from './app.js';

// Transizioni di stato disponibili per ciascuno stato corrente.
export const TRANSITIONS = {
  in_attesa:  [{ to: 'confermata', label: 'Conferma', cls: 'act--ok' }, { to: 'annullata', label: 'Rifiuta', cls: 'act--warn' }],
  confermata: [{ to: 'arrivato', label: 'Arrivato', cls: 'act--go' }, { to: 'no_show', label: 'No-show', cls: 'act--warn' }, { to: 'annullata', label: 'Annulla', cls: 'act--mute' }],
  arrivato:   [{ to: 'confermata', label: 'Ripristina', cls: 'act--mute' }],
  no_show:    [{ to: 'confermata', label: 'Ripristina', cls: 'act--mute' }],
  annullata:  [{ to: 'in_attesa', label: 'Ripristina', cls: 'act--mute' }],
};

// Ordine di visualizzazione: attive prima, chiuse in fondo.
export function statusRank(s) {
  return { in_attesa: 0, confermata: 1, arrivato: 2, no_show: 3, annullata: 4 }[s] ?? 9;
}

// HTML di una card prenotazione. opts.timeLabel appare nella colonna sinistra
// (nella dashboard è l'ora del turno, in "In arrivo" può essere l'ora del turno).
export function reservationCardHtml(r, opts = {}) {
  const acts = (TRANSITIONS[r.status] || []).map((t) =>
    `<button class="act ${t.cls}" data-id="${r.id}" data-to="${t.to}">${t.label}</button>`).join('');
  const emailBadge = emailVerificationBadgeHtml(r);
  const tableControl = tableAssignmentHtml(r, opts);
  return `
    <div class="res">
      <div class="res__time">${escapeHtml(opts.timeLabel || '')}</div>
      <div class="res__main">
        <div class="res__name">${escapeHtml(r.customer_last_name)} ${escapeHtml(r.customer_first_name)}
          ${r.source === 'widget' ? '<span class="pill">widget</span>' : ''}</div>
        <div class="res__meta">
          <a href="tel:${escapeHtml(r.customer_phone)}">${escapeHtml(r.customer_phone)}</a>
          <span>${r.party_size} coperti</span>
          <span>${opts.tableCode ? 'Tavolo ' + escapeHtml(opts.tableCode) : 'Tavolo non assegnato'}</span>
          ${opts.shiftName ? `<span>${escapeHtml(opts.shiftName)}</span>` : ''}
          ${emailBadge}
        </div>
        ${tableControl}
        ${r.notes ? `<div class="res__notes">${escapeHtml(r.notes)}</div>` : ''}
      </div>
      <div class="res__side"><span class="badge badge--${r.status}">${STATUS_LABEL[r.status]}</span></div>
      ${acts ? `<div class="res__actions">${acts}</div>` : ''}
    </div>`;
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
    return `<label class="table-picker__option${disabled ? ' is-disabled' : ''}">
      <input type="checkbox" data-table-choice="${escapeHtml(table.id)}" ${selected ? 'checked' : ''} ${disabled ? 'disabled' : ''} />
      <span class="table-picker__check" aria-hidden="true"></span>
      <span class="table-picker__main">
        <strong>${escapeHtml(table.code)}</strong>
        <small>${escapeHtml(table.seatsMax)} posti</small>
      </span>
      <span class="table-picker__status">${escapeHtml(status)}</span>
    </label>`;
  }).join('');
  return `<div class="res__table-assign" data-party-size="${escapeHtml(r.party_size || 0)}" data-selection-mode="${selectionMode}">
    <div class="table-picker" data-table-picker="${escapeHtml(r.id)}" data-selection-mode="${selectionMode}">
      <button class="table-picker__button" type="button" data-table-picker-toggle aria-expanded="false">
        <span data-table-picker-label>${escapeHtml(summary)}</span>
        <span aria-hidden="true">▾</span>
      </button>
      <div class="table-picker__menu" data-table-picker-menu hidden>${options}</div>
    </div>
    <button class="act act--mute" type="button" data-table-save="${escapeHtml(r.id)}">Assegna tavoli</button>
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
}

export function wireTableAssignment(container, onAssign) {
  container.querySelectorAll('[data-table-picker]').forEach((picker) => {
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
    button.addEventListener('click', () => {
      const id = button.dataset.tableSave;
      const box = button.closest('.res__table-assign');
      const picker = box?.querySelector('[data-table-picker]');
      const ids = picker ? selectedTableIds(picker) : [];
      const totalSeats = tablePickerSeats(picker);
      const partySize = parseInt(box?.dataset.partySize || '0', 10) || 0;
      const error = box?.querySelector('[data-table-summary-error]');
      if (ids.length && totalSeats < partySize) {
        if (error) error.hidden = false;
        return;
      }
      const selectionMode = box?.dataset.selectionMode || picker?.dataset.selectionMode || 'multi';
      onAssign(id, selectionMode === 'single' ? (ids[0] || null) : ids);
    }));
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
          <span>${w.party_size} coperti</span>
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
