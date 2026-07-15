import { escapeHtml } from './app.js';

let modal;
let activeContext = null;
let lastFocus = null;

export function openTableMapSelector({ box, picker, saveButton, reservation, onConfirm }) {
  try {
    if (!box || !picker || !saveButton) return false;
    ensureModal();
    lastFocus = document.activeElement;
    activeContext = {
      box,
      picker,
      saveButton,
      reservation: reservation || {},
      onConfirm,
      initial: selectedIds(picker),
      suggestionMessage: '',
      pendingMove: null,
    };
    applyAutomaticSuggestion();
    renderModal();
    modal.hidden = false;
    modal.querySelector('[data-table-map-close]')?.focus({ preventScroll: true });
    return true;
  } catch (error) {
    console.error('[table-map] apertura mappa fallita:', error);
    box?.classList.remove('is-map-enabled');
    return false;
  }
}

function ensureModal() {
  if (modal) return;
  modal = document.createElement('div');
  modal.className = 'table-map-modal';
  modal.hidden = true;
  modal.innerHTML = `
    <div class="table-map-modal__overlay" data-table-map-overlay></div>
    <section class="table-map-modal__card" role="dialog" aria-modal="true" aria-labelledby="tableMapTitle">
      <header class="table-map-modal__head">
        <div>
          <h2 id="tableMapTitle">Assegna tavoli</h2>
          <p data-table-map-booking></p>
          <p data-table-map-current></p>
        </div>
        <button class="table-map-modal__close" type="button" data-table-map-close aria-label="Chiudi">×</button>
      </header>
      <div class="table-map-legend" aria-label="Legenda mappa tavoli">
        <span><i class="table-map-legend__dot is-free"></i>Libero</span>
        <span><i class="table-map-legend__dot is-confirmed"></i>Confermato</span>
        <span><i class="table-map-legend__dot is-arrived"></i>Arrivato</span>
        <span><i class="table-map-legend__dot is-finished"></i>Terminato</span>
        <span><i class="table-map-legend__dot is-busy"></i>Occupato</span>
      </div>
      <div class="table-map-modal__body" data-table-map-body></div>
      <p class="table-map-modal__error" data-table-map-error hidden></p>
      <div class="table-map-move-confirm" data-table-map-move-confirm hidden>
        <p data-table-map-move-message></p>
        <div>
          <button class="btn btn--ghost" type="button" data-table-map-move-cancel>Annulla</button>
          <button class="btn btn--primary" type="button" data-table-map-move-accept>Conferma</button>
        </div>
      </div>
      <footer class="table-map-modal__footer">
        <div class="table-map-modal__summary">
          <span>Da: <strong data-table-map-from>—</strong></span>
          <span>A: <strong data-table-map-to>—</strong></span>
          <span>Tavoli selezionati: <strong data-table-map-codes>—</strong></span>
          <span>Capienza: <strong data-table-map-seats>0</strong> posti</span>
          <span>Prenotazione: <strong data-table-map-party>0</strong> persone</span>
          <span data-table-map-capacity></span>
        </div>
        <div class="table-map-modal__actions">
          <button class="btn btn--ghost" type="button" data-table-map-cancel>Annulla</button>
          <button class="btn btn--primary" type="button" data-table-map-confirm>Assegna tavoli</button>
        </div>
      </footer>
    </section>
  `;
  document.body.appendChild(modal);
  modal.querySelector('[data-table-map-close]')?.addEventListener('click', requestClose);
  modal.querySelector('[data-table-map-cancel]')?.addEventListener('click', requestClose);
  modal.querySelector('[data-table-map-overlay]')?.addEventListener('click', requestClose);
  modal.querySelector('[data-table-map-confirm]')?.addEventListener('click', confirmSelection);
  modal.querySelector('[data-table-map-move-cancel]')?.addEventListener('click', cancelPendingMove);
  modal.querySelector('[data-table-map-move-accept]')?.addEventListener('click', confirmPendingMove);
  modal.addEventListener('keydown', trapFocus);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modal && !modal.hidden) requestClose();
  });
}

function renderModal() {
  const { picker, reservation } = activeContext;
  const rows = tableRows(picker);
  const zones = groupByZone(rows);
  const name = `${reservation.firstName || ''} ${reservation.lastName || ''}`.trim() || 'Prenotazione';
  const time = reservation.timeLabel || reservation.shiftName || '';
  const party = partySize();
  const currentCodes = initialCodes().join(' + ');
  const error = modal.querySelector('[data-table-map-error]');
  modal.querySelector('[data-table-map-booking]').textContent = `${name}${time ? ` · ${time}` : ''} · ${party} persone`;
  modal.querySelector('[data-table-map-current]').textContent = `Attualmente: ${currentCodes || 'nessun tavolo assegnato'}`;
  if (error) {
    error.textContent = activeContext.suggestionMessage || '';
    error.hidden = !activeContext.suggestionMessage;
  }
  modal.querySelector('[data-table-map-body]').innerHTML = zones.map((zone) => `
    <section class="table-map-zone">
      <h3>${escapeHtml(zone.name)}</h3>
      <div class="table-map-grid">
        ${zone.tables.map(tableMapCardHtml).join('')}
      </div>
    </section>
  `).join('');
  modal.querySelectorAll('[data-table-map-choice]').forEach((button) =>
    button.addEventListener('click', () => toggleTable(button.dataset.tableMapChoice)));
  updateSummary();
}

function tableRows(picker) {
  return [...picker.querySelectorAll('[data-table-choice]')].map((input) => {
    const option = input.closest('.table-picker__option');
    const x = parseFloat(option?.dataset.x || '');
    const y = parseFloat(option?.dataset.y || '');
    return {
      id: input.dataset.tableChoice,
      code: option?.querySelector('strong')?.textContent?.trim() || '',
      seats: parseInt(option?.querySelector('small')?.textContent || '0', 10) || 0,
      status: option?.querySelector('.table-picker__status')?.textContent?.trim() || 'Disponibile',
      zone: option?.dataset.zone || 'Sala',
      guest: option?.dataset.guest || '',
      detail: option?.dataset.detail || '',
      phone: option?.dataset.guestPhone || '',
      email: option?.dataset.guestEmail || '',
      notes: option?.dataset.guestNotes || '',
      party: option?.dataset.guestParty || '',
      time: option?.dataset.guestTime || '',
      reservationStatus: option?.dataset.guestStatus || '',
      x: Number.isFinite(x) ? x : null,
      y: Number.isFinite(y) ? y : null,
      disabled: input.disabled,
      checked: input.checked,
    };
  });
}

function applyAutomaticSuggestion() {
  if (activeContext.initial.length) return;
  const suggestion = bestTableCombination(tableRows(activeContext.picker));
  if (!suggestion.length) {
    activeContext.suggestionMessage = 'Nessuna combinazione disponibile';
    return;
  }
  activeContext.suggestionMessage = '';
  setSelectedIds(activeContext.picker, suggestion.map((row) => row.id));
}

function bestTableCombination(rows) {
  const party = partySize();
  const available = rows
    .filter((row) => row.id && row.seats > 0 && !row.disabled)
    .sort((a, b) => a.seats - b.seats || a.code.localeCompare(b.code, 'it', { numeric: true }));
  if (!party || !available.length) return [];
  if (activeContext.picker.dataset.selectionMode === 'single') {
    return available
      .filter((row) => row.seats >= party)
      .sort((a, b) => (a.seats - party) - (b.seats - party) || a.code.localeCompare(b.code, 'it', { numeric: true }))
      .slice(0, 1);
  }
  return bestMultiTableCombination(available, party);
}

function bestMultiTableCombination(rows, party) {
  let best = null;
  const maxTables = Math.min(rows.length, 8);
  let explored = 0;

  function visit(index, picked, seats) {
    if (explored > 50000) return;
    if (seats >= party) {
      explored += 1;
      const candidate = { rows: [...picked], seats };
      if (!best || compareCombinations(candidate, best, party) < 0) best = candidate;
      return;
    }
    if (index >= rows.length || picked.length >= maxTables) return;
    for (let i = index; i < rows.length; i += 1) {
      picked.push(rows[i]);
      visit(i + 1, picked, seats + rows[i].seats);
      picked.pop();
    }
  }

  visit(0, [], 0);
  return best?.rows || [];
}

function compareCombinations(a, b, party) {
  const wasteA = a.seats - party;
  const wasteB = b.seats - party;
  if (wasteA !== wasteB) return wasteA - wasteB;
  if (a.rows.length !== b.rows.length) return a.rows.length - b.rows.length;
  return proximityScore(a.rows) - proximityScore(b.rows);
}

function proximityScore(rows) {
  if (rows.length <= 1) return 0;
  const positioned = rows.every((row) => Number.isFinite(row.x) && Number.isFinite(row.y));
  if (positioned) {
    let total = 0;
    let pairs = 0;
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        total += Math.hypot(rows[i].x - rows[j].x, rows[i].y - rows[j].y);
        pairs += 1;
      }
    }
    return pairs ? total / pairs : 0;
  }
  return new Set(rows.map((row) => row.zone || 'Sala')).size - 1;
}

function setSelectedIds(picker, ids) {
  const selected = new Set(ids);
  picker.querySelectorAll('[data-table-choice]').forEach((input) => {
    const checked = selected.has(input.dataset.tableChoice);
    if (input.checked !== checked) {
      input.checked = checked;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
}

function groupByZone(rows) {
  const map = new Map();
  rows.forEach((row) => {
    const zone = row.zone || 'Sala';
    if (!map.has(zone)) map.set(zone, []);
    map.get(zone).push(row);
  });
  return [...map.entries()].map(([name, tables]) => ({ name, tables }));
}

function tableMapCardHtml(row) {
  const selected = row.checked;
  const unavailable = row.disabled && !selected;
  const reservationClass = tableReservationStatusClass(row.reservationStatus);
  const statusClass = unavailable
    ? 'is-disabled'
    : selected
      ? 'is-selected'
      : row.status.toLowerCase().includes('occupato')
        ? 'is-busy'
        : row.status.toLowerCase().includes('fuori')
          ? 'is-off'
          : 'is-free';
  const classes = ['table-map-table', statusClass, reservationClass].filter(Boolean).join(' ');
  const tooltipRows = [
    row.phone ? `<span><b>Telefono</b>${escapeHtml(row.phone)}</span>` : '',
    row.email ? `<span><b>Email</b>${escapeHtml(row.email)}</span>` : '',
    row.notes ? `<span><b>Note</b>${escapeHtml(row.notes)}</span>` : '',
  ].filter(Boolean).join('');
  const tooltip = tooltipRows ? `<span class="table-map-tooltip" role="tooltip">${tooltipRows}</span>` : '';
  const people = row.party ? `${row.party} persone` : '';
  return `<button class="${classes}" type="button" data-table-map-choice="${escapeHtml(row.id)}" ${unavailable ? 'tabindex="-1" aria-disabled="true"' : ''} aria-pressed="${selected ? 'true' : 'false'}">
    <strong>${escapeHtml(row.code)}</strong>
    <span>Capienza: ${escapeHtml(row.seats)} posti</span>
    <small>Stato: ${escapeHtml(row.status)}</small>
    ${row.guest ? `<span class="table-map-table__guest">${escapeHtml(row.guest)}</span>` : ''}
    ${people ? `<small>${escapeHtml(people)}</small>` : ''}
    ${row.time ? `<small>${escapeHtml(row.time)}</small>` : ''}
    ${row.reservationStatus ? `<small>${escapeHtml(row.reservationStatus)}</small>` : ''}
    ${tooltip}
  </button>`;
}

function tableReservationStatusClass(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized.includes('confermat')) return 'is-confirmed';
  if (normalized.includes('arrivat')) return 'is-arrived';
  if (normalized.includes('terminat')) return 'is-finished';
  return '';
}

function tableCardHtml(row) {
  const selected = row.checked;
  const unavailable = row.disabled && !selected;
  const statusClass = unavailable
    ? 'is-disabled'
    : selected
      ? 'is-selected'
      : row.status.toLowerCase().includes('occupato')
        ? 'is-busy'
        : row.status.toLowerCase().includes('fuori')
          ? 'is-off'
          : 'is-free';
  const title = [row.code, `${row.seats} posti`, row.guest, row.detail, row.status].filter(Boolean).join(' · ');
  return `<button class="table-map-table ${statusClass}" type="button" data-table-map-choice="${escapeHtml(row.id)}" ${unavailable ? 'disabled' : ''} aria-pressed="${selected ? 'true' : 'false'}" title="${escapeHtml(title)}">
    <strong>${escapeHtml(row.code)}</strong>
    <span>${escapeHtml(row.guest || `${row.seats} posti`)}</span>
    <small>${escapeHtml(row.detail || row.status)}</small>
  </button>`;
}

function toggleTable(id) {
  const { picker } = activeContext;
  const input = [...picker.querySelectorAll('[data-table-choice]')]
    .find((choice) => choice.dataset.tableChoice === id);
  if (!input || input.disabled) return;
  if (shouldConfirmTableMove(input)) {
    showMoveConfirmation([id]);
    return;
  }
  if (picker.dataset.selectionMode === 'single' && !input.checked) {
    picker.querySelectorAll('[data-table-choice]:checked').forEach((choice) => {
      choice.checked = false;
      choice.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  input.checked = !input.checked;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  renderModal();
}

function shouldConfirmTableMove(input) {
  if (!activeContext?.initial?.length) return false;
  if (activeContext.picker.dataset.selectionMode !== 'single') return false;
  if (input.checked) return false;
  return !activeContext.initial.includes(input.dataset.tableChoice);
}

function showMoveConfirmation(nextIds) {
  const fromCodes = initialCodes().join(' + ') || '—';
  const toCodes = tableRows(activeContext.picker)
    .filter((row) => nextIds.includes(row.id))
    .map((row) => row.code)
    .join(' + ') || '—';
  const name = reservationName();
  activeContext.pendingMove = nextIds;
  const panel = modal.querySelector('[data-table-map-move-confirm]');
  const message = modal.querySelector('[data-table-map-move-message]');
  if (message) {
    message.innerHTML = `Spostare ${escapeHtml(name)}<br>da <strong>${escapeHtml(fromCodes)}</strong><br>a <strong>${escapeHtml(toCodes)}</strong>?`;
  }
  if (panel) panel.hidden = false;
}

function cancelPendingMove() {
  activeContext.pendingMove = null;
  const panel = modal.querySelector('[data-table-map-move-confirm]');
  if (panel) panel.hidden = true;
}

async function confirmPendingMove() {
  const ids = activeContext.pendingMove || [];
  if (!ids.length) return;
  setSelectedIds(activeContext.picker, ids);
  activeContext.pendingMove = null;
  const panel = modal.querySelector('[data-table-map-move-confirm]');
  if (panel) panel.hidden = true;
  renderModal();
  await confirmSelection();
}

function updateSummary() {
  const rows = tableRows(activeContext.picker).filter((row) => row.checked);
  const codes = rows.map((row) => row.code);
  const seats = rows.reduce((sum, row) => sum + row.seats, 0);
  const party = partySize();
  const missing = Math.max(0, party - seats);
  modal.querySelector('[data-table-map-codes]').textContent = codes.join(' + ') || '—';
  modal.querySelector('[data-table-map-from]').textContent = initialCodes().join(' + ') || '—';
  modal.querySelector('[data-table-map-to]').textContent = codes.join(' + ') || '—';
  modal.querySelector('[data-table-map-seats]').textContent = String(seats);
  modal.querySelector('[data-table-map-party]').textContent = String(party);
  modal.querySelector('[data-table-map-capacity]').textContent = missing ? `Mancano ${missing} posti` : 'Capienza sufficiente';
  modal.querySelector('[data-table-map-capacity]').classList.toggle('is-error', missing > 0);
  modal.querySelector('[data-table-map-confirm]').disabled = rows.length > 0 && missing > 0;
  modal.querySelector('[data-table-map-confirm]').textContent = activeContext.initial.length ? 'Salva assegnazione' : 'Assegna tavoli';
}

function initialCodes() {
  const initial = new Set(activeContext.initial);
  return tableRows(activeContext.picker)
    .filter((row) => initial.has(row.id))
    .map((row) => row.code);
}

function partySize() {
  return parseInt(activeContext.box?.dataset.partySize || '0', 10) || 0;
}

function reservationName() {
  const reservation = activeContext?.reservation || {};
  return `${reservation.firstName || ''} ${reservation.lastName || ''}`.trim() || 'questa prenotazione';
}

function selectedIds(picker) {
  return [...picker.querySelectorAll('[data-table-choice]:checked')]
    .map((input) => input.dataset.tableChoice)
    .filter(Boolean);
}

function hasUnsavedSelection() {
  const current = selectedIds(activeContext.picker).sort().join('|');
  const initial = [...activeContext.initial].sort().join('|');
  return current !== initial;
}

function requestClose() {
  if (activeContext && hasUnsavedSelection() && !confirm('Annullare la selezione dei tavoli?')) return;
  closeModal(true);
}

function closeModal(restoreInitial = false) {
  if (restoreInitial && activeContext) {
    const initial = new Set(activeContext.initial);
    activeContext.picker.querySelectorAll('[data-table-choice]').forEach((input) => {
      input.checked = initial.has(input.dataset.tableChoice);
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  modal.hidden = true;
  activeContext = null;
  lastFocus?.focus?.({ preventScroll: true });
}

async function confirmSelection() {
  const rows = tableRows(activeContext.picker).filter((row) => row.checked);
  const seats = rows.reduce((sum, row) => sum + row.seats, 0);
  const party = partySize();
  if (rows.length && seats < party) {
    const error = modal.querySelector('[data-table-map-error]');
    error.textContent = `Seleziona altri tavoli: mancano ${party - seats} posti.`;
    error.hidden = false;
    return;
  }
  const confirmButton = modal.querySelector('[data-table-map-confirm]');
  confirmButton.disabled = true;
  const ok = await activeContext.onConfirm?.();
  confirmButton.disabled = false;
  if (ok === false) return;
  modal.hidden = true;
  activeContext = null;
  lastFocus?.focus?.({ preventScroll: true });
}

function trapFocus(event) {
  if (event.key !== 'Tab' || modal.hidden) return;
  const focusables = [...modal.querySelectorAll('button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')];
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
