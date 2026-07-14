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
  const options = [
    `<option value="">Tavolo non assegnato</option>`,
    ...opts.tableOptions.map((table) => {
      const selected = table.id === r.table_id ? ' selected' : '';
      const disabled = table.disabled ? ' disabled' : '';
      return `<option value="${escapeHtml(table.id)}"${selected}${disabled}>${escapeHtml(table.label)}</option>`;
    }),
  ].join('');
  return `<div class="res__table-assign">
    <select data-table-select="${escapeHtml(r.id)}" aria-label="Assegna tavolo">${options}</select>
    <button class="act act--mute" type="button" data-table-save="${escapeHtml(r.id)}">Assegna tavolo</button>
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
  container.querySelectorAll('[data-table-save]').forEach((button) =>
    button.addEventListener('click', () => {
      const id = button.dataset.tableSave;
      const select = button.closest('.res')?.querySelector('[data-table-select]');
      onAssign(id, select ? select.value || null : null);
    }));
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
