// UI condivisa delle prenotazioni: transizioni di stato, rendering di una
// riga/card e aggancio delle azioni. Usato da dashboard.js e upcoming.js.
import { STATUS_LABEL, escapeHtml } from './app.js';

const ROOM_STAGE_WIDTH = 1400;
const ROOM_STAGE_HEIGHT = 900;

// Transizioni di stato disponibili per ciascuno stato corrente.
export const TRANSITIONS = {
  in_attesa:  [{ to: 'confermata', label: 'Conferma', cls: 'act--ok' }, { to: 'annullata', label: 'Rifiuta', cls: 'act--warn' }],
  confermata: [{ to: 'arrivato', label: 'Arrivato', cls: 'act--go' }, { to: 'no_show', label: 'No-show', cls: 'act--warn' }, { to: 'annullata', label: 'Annulla', cls: 'act--mute' }],
  arrivato:   [{ to: 'terminata', label: 'Servizio terminato', cls: 'act--ok' }, { to: 'confermata', label: 'Ripristina', cls: 'act--mute' }],
  no_show:    [{ to: 'confermata', label: 'Ripristina', cls: 'act--mute' }],
  annullata:  [{ to: 'in_attesa', label: 'Ripristina', cls: 'act--mute' }],
  terminata:  [{ to: 'confermata', label: 'Ripristina', cls: 'act--mute' }],
};

// Ordine di visualizzazione: attive prima, chiuse in fondo.
export function statusRank(s) {
  return { in_attesa: 0, confermata: 1, arrivato: 2, no_show: 3, annullata: 4, terminata: 5 }[s] ?? 9;
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
  const selectedTableIds = new Set(Array.isArray(r.table_ids) && r.table_ids.length ? r.table_ids : [r.table_id].filter(Boolean));
  const options = [
    `<option value="">Tavolo non assegnato</option>`,
    ...opts.tableOptions.map((table) => {
      const selected = selectedTableIds.has(table.id) ? ' selected' : '';
      const disabled = table.disabled ? ' disabled' : '';
      return `<option value="${escapeHtml(table.id)}"${selected}${disabled}>${escapeHtml(table.label)}</option>`;
    }),
  ].join('');
  const cards = opts.tableOptions.map((table) => {
    const selected = selectedTableIds.has(table.id);
    const disabled = !!(table.previewDisabled ?? table.disabled) && !selected && !table.busy;
    const state = selected ? 'selected' : tablePreviewState(table, disabled);
    const code = table.code || String(table.label || '').replace(/\s*\(.*/, '');
    const seats = table.seatsMax || table.seats_max || 0;
    const status = tablePreviewStatus(state);
    const layout = tablePreviewLayout(table);
    const reservationStatus = table.busyStatus ? (STATUS_LABEL[table.busyStatus] || table.busyStatus) : '—';
    const timeLabel = formatTablePreviewTime(table.busyTime);
    const tooltip = [
      `Nome: ${code}`,
      `Coperti: ${seats}`,
      `Prenotazione: ${reservationStatus}`,
      `Orario: ${timeLabel}`,
      `Cliente: ${table.busyReservation || '—'}`,
    ].join('\n');
    return `<button class="table-preview table-preview--${state} table-preview--${escapeHtml(layout.shape)}" type="button"
      data-table-preview="${escapeHtml(table.id)}"
      data-table-code="${escapeHtml(code)}"
      data-table-seats="${escapeHtml(seats)}"
      data-table-state="${escapeHtml(state)}"
      style="${escapeHtml(layout.style)}"
      title="${escapeHtml(tooltip)}"
      aria-pressed="${selected ? 'true' : 'false'}"
      aria-label="Anteprima tavolo ${escapeHtml(code)}: ${escapeHtml(status)}">
      <span class="table-preview__code">${escapeHtml(code)}</span>
      <span class="table-preview__seats">${escapeHtml(seats)} posti</span>
      <span class="table-preview__status">${escapeHtml(status)}</span>
      <span class="table-preview__tooltip" role="tooltip">
        <span><strong>Nome</strong>${escapeHtml(code)}</span>
        <span><strong>Coperti</strong>${escapeHtml(seats)}</span>
        <span><strong>Prenotazione</strong>${escapeHtml(reservationStatus)}</span>
        <span><strong>Orario</strong>${escapeHtml(timeLabel)}</span>
        <span><strong>Cliente</strong>${escapeHtml(table.busyReservation || '—')}</span>
      </span>
    </button>`;
  }).join('');
  return `<div class="res__table-assign" data-party-size="${escapeHtml(r.party_size || 0)}">
    <div class="res__table-assign-row">
      <select data-table-select="${escapeHtml(r.id)}" aria-label="Assegna tavolo">${options}</select>
      <button class="act act--mute" type="button" data-table-save="${escapeHtml(r.id)}">Assegna tavolo</button>
    </div>
    <div class="table-preview-map table-preview-map--layout" aria-label="Piantina interattiva tavoli">${cards}</div>
    <div class="table-preview-group" data-table-preview-group hidden>
      <strong data-table-group-codes></strong>
      <span data-table-group-seats></span>
    </div>
    <div class="table-preview-summary">
      <div class="table-preview-summary__item">
        <span>Tavoli selezionati</span>
        <strong data-table-summary-codes>—</strong>
      </div>
      <div class="table-preview-summary__item">
        <span>Numero tavoli</span>
        <strong data-table-summary-count>0</strong>
      </div>
      <div class="table-preview-summary__item">
        <span>Posti disponibili</span>
        <strong data-table-summary-seats>0</strong>
      </div>
      <div class="table-preview-summary__actions">
        <button class="act act--mute table-preview-summary__button" type="button" data-table-preview-suggest>Suggerisci tavolo</button>
        <button class="act act--ok table-preview-summary__button" type="button" data-table-preview-ready="${escapeHtml(r.id)}">Assegna tavoli</button>
      </div>
      <span class="table-preview-summary__feedback" data-table-preview-feedback role="status" aria-live="polite"></span>
    </div>
  </div>`;
}

function tablePreviewState(table, disabled) {
  if (disabled) return 'disabled';
  if (!table.busy) return 'available';
  return table.busyStatus === 'arrivato' ? 'occupied' : 'incoming';
}

function tablePreviewStatus(state) {
  return {
    selected: 'Selezionato',
    occupied: 'Occupato',
    incoming: 'In arrivo',
    disabled: 'Disabilitato',
    available: 'Disponibile',
  }[state] || 'Disponibile';
}

function formatTablePreviewTime(value) {
  if (!value) return '—';
  return String(value).slice(0, 5);
}

function tablePreviewLayout(table) {
  const x = numberOr(table.layoutX, table.layout_x, 0);
  const y = numberOr(table.layoutY, table.layout_y, 0);
  const rawWidth = numberOr(table.layoutWidth, table.layout_width, 120);
  const rawHeight = numberOr(table.layoutHeight, table.layout_height, 90);
  const rotation = numberOr(table.layoutRotation, table.layout_rotation, 0);
  const shape = table.layoutShape || table.layout_shape || 'rectangle';
  const fixedSize = shape === 'square' || shape === 'round';
  const width = fixedSize ? Math.max(rawWidth, rawHeight) : rawWidth;
  const height = fixedSize ? width : rawHeight;
  const style = [
    `left:${(x / ROOM_STAGE_WIDTH) * 100}%`,
    `top:${(y / ROOM_STAGE_HEIGHT) * 100}%`,
    `width:${(width / ROOM_STAGE_WIDTH) * 100}%`,
    `height:${(height / ROOM_STAGE_HEIGHT) * 100}%`,
    `--table-rotation:${rotation}deg`,
    `--table-tooltip-rotation:${-rotation}deg`,
    `transform:rotate(${rotation}deg)`,
    table.layoutColor || table.layout_color ? `--table-color:${table.layoutColor || table.layout_color}` : '',
  ].filter(Boolean).join(';');
  return { shape, style };
}

function numberOr(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
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
  container.querySelectorAll('.res__table-assign').forEach(updateTablePreviewSummary);
  container.querySelectorAll('[data-table-preview]').forEach((button) =>
    button.addEventListener('click', () => {
      if (button.classList.contains('table-preview--occupied') || button.classList.contains('table-preview--incoming') || button.classList.contains('table-preview--disabled')) return;
      const selected = !button.classList.contains('table-preview--selected');
      setTablePreviewSelected(button, selected);
      pulseTablePreview(button, selected ? 'table-preview--pick' : 'table-preview--release');
      updateTablePreviewSummary(button.closest('.res__table-assign'));
    }));
  container.querySelectorAll('[data-table-preview-suggest]').forEach((button) =>
    button.addEventListener('click', () => suggestTablePreview(button.closest('.res__table-assign'))));
  container.querySelectorAll('[data-table-preview-ready]').forEach((button) =>
    button.addEventListener('click', () => {
      const box = button.closest('.res__table-assign');
      const feedback = box?.querySelector('[data-table-preview-feedback]');
      if (!feedback) return;
      const ids = [...box.querySelectorAll('.table-preview--selected')].map((item) => item.dataset.tablePreview).filter(Boolean);
      if (!ids.length) {
        feedback.textContent = 'Seleziona almeno un tavolo.';
        return;
      }
      box.querySelectorAll('.table-preview--selected').forEach((item) => pulseTablePreview(item, 'table-preview--assigning'));
      const group = box.querySelector('[data-table-preview-group]');
      if (group && !group.hidden) pulseTablePreview(group, 'table-preview-group--assigning');
      onAssign(button.dataset.tablePreviewReady, ids);
    }));
}

function pulseTablePreview(element, className) {
  if (!element) return;
  element.classList.remove(className);
  void element.offsetWidth;
  element.classList.add(className);
  window.clearTimeout(element._tablePreviewPulseTimer);
  element._tablePreviewPulseTimer = window.setTimeout(() => element.classList.remove(className), 760);
  element.addEventListener('animationend', () => element.classList.remove(className), { once: true });
}

function setTablePreviewSelected(button, selected) {
  button.classList.toggle('table-preview--selected', selected);
  button.classList.toggle('table-preview--available', !selected);
  button.dataset.tableState = selected ? 'selected' : 'available';
  button.setAttribute('aria-pressed', selected ? 'true' : 'false');
  const status = button.querySelector('.table-preview__status');
  if (status) status.textContent = selected ? 'Selezionato' : 'Disponibile';
}

function suggestTablePreview(box) {
  if (!box) return;
  const partySize = parseInt(box.dataset.partySize, 10) || 0;
  const tables = [...box.querySelectorAll('[data-table-preview]')]
    .map((button, index) => ({
      button,
      index,
      seats: parseInt(button.dataset.tableSeats, 10) || 0,
      disabled: button.classList.contains('table-preview--disabled'),
      occupied: button.classList.contains('table-preview--occupied') || button.classList.contains('table-preview--incoming'),
    }))
    .filter((table) => !table.disabled && !table.occupied && table.seats > 0);
  const feedback = box.querySelector('[data-table-preview-feedback]');
  const suggested = bestTableCombination(tables, partySize);

  box.querySelectorAll('.table-preview--selected').forEach((button) => {
    setTablePreviewSelected(button, false);
    pulseTablePreview(button, 'table-preview--release');
  });

  if (!suggested.length) {
    if (feedback) feedback.textContent = 'Nessuna combinazione disponibile.';
    updateTablePreviewSummary(box);
    return;
  }

  suggested.forEach((table) => {
    setTablePreviewSelected(table.button, true);
    pulseTablePreview(table.button, 'table-preview--suggested');
  });
  updateTablePreviewSummary(box);
  if (feedback) {
    feedback.textContent = 'Suggerimento applicato.';
    window.clearTimeout(feedback._tablePreviewTimer);
    feedback._tablePreviewTimer = window.setTimeout(() => { feedback.textContent = ''; }, 1800);
  }
}

function bestTableCombination(tables, partySize) {
  if (!tables.length || partySize <= 0) return [];
  const bySeats = [...tables].sort((a, b) => a.seats - b.seats || a.index - b.index);
  for (let size = 1; size <= bySeats.length; size++) {
    const candidates = tableCombinations(bySeats, size)
      .filter((combo) => combo.reduce((sum, table) => sum + table.seats, 0) >= partySize);
    if (candidates.length) {
      return candidates.sort((a, b) => tableComboScore(a, partySize) - tableComboScore(b, partySize))[0];
    }
  }
  return [];
}

function tableCombinations(tables, size) {
  const results = [];
  const current = [];
  const maxResults = 8000;
  function walk(start) {
    if (results.length >= maxResults) return;
    if (current.length === size) {
      results.push([...current]);
      return;
    }
    for (let i = start; i <= tables.length - (size - current.length); i++) {
      current.push(tables[i]);
      walk(i + 1);
      current.pop();
    }
  }
  walk(0);
  return results;
}

function tableComboScore(combo, partySize) {
  const seats = combo.reduce((sum, table) => sum + table.seats, 0);
  const indexes = combo.map((table) => table.index);
  const span = Math.max(...indexes) - Math.min(...indexes);
  const waste = seats - partySize;
  return span * 1000 + waste * 10 + Math.min(...indexes);
}

function updateTablePreviewSummary(box) {
  if (!box) return;
  const selected = [...box.querySelectorAll('.table-preview--selected')];
  const codes = selected.map((button) => button.dataset.tableCode).filter(Boolean);
  const seats = selected.reduce((sum, button) => sum + (parseInt(button.dataset.tableSeats, 10) || 0), 0);
  const codesEl = box.querySelector('[data-table-summary-codes]');
  const countEl = box.querySelector('[data-table-summary-count]');
  const seatsEl = box.querySelector('[data-table-summary-seats]');
  const group = box.querySelector('[data-table-preview-group]');
  const groupCodes = box.querySelector('[data-table-group-codes]');
  const groupSeats = box.querySelector('[data-table-group-seats]');
  if (codesEl) codesEl.textContent = codes.length ? codes.join(' + ') : '—';
  if (countEl) countEl.textContent = String(selected.length);
  if (seatsEl) seatsEl.textContent = String(seats);
  if (group) group.hidden = selected.length < 2;
  if (groupCodes) groupCodes.textContent = codes.join(' + ');
  if (groupSeats) groupSeats.textContent = `${seats} posti`;
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
