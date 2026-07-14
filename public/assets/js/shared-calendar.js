const MONTH_FMT = new Intl.DateTimeFormat('it-IT', { month: 'long', year: 'numeric' });

function cap(value) {
  return String(value || '').charAt(0).toUpperCase() + String(value || '').slice(1);
}

function toISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isoToDate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}

function isoDow(date) {
  const day = date.getDay();
  return day === 0 ? 7 : day;
}

function injectStyles() {
  if (document.getElementById('sharedCalendarStyles')) return;
  const style = document.createElement('style');
  style.id = 'sharedCalendarStyles';
  style.textContent = `
    .shared-cal-popover {
      position: fixed;
      z-index: 1000;
      width: min(360px, calc(100vw - 24px));
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--surface);
      box-shadow: 0 24px 60px rgba(58,43,35,.18);
      padding: 14px;
      animation: sharedCalIn 180ms ease both;
    }
    .shared-cal-popover[hidden] { display: none !important; }
    .shared-cal-backdrop {
      position: fixed;
      inset: 0;
      z-index: 999;
      background: transparent;
    }
    .shared-cal-backdrop[hidden] { display: none !important; }
    .shared-cal-popover .cal__head {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 12px;
    }
    .shared-cal-popover .cal__title {
      font-family: var(--font-title);
      font-weight: 700;
      font-size: 1.1rem;
      text-transform: capitalize;
      text-align: center;
      flex: 1;
    }
    .shared-cal-popover .cal__nav {
      width: 42px;
      height: 42px;
      flex: none;
      border: 1.5px solid var(--line);
      border-radius: 50%;
      background: var(--surface);
      color: var(--tomato-dark);
      font-size: 1.3rem;
      line-height: 1;
      cursor: pointer;
      display: grid;
      place-items: center;
      transition: background .15s, border-color .15s, transform .05s;
    }
    .shared-cal-popover .cal__nav:hover:not(:disabled) {
      border-color: var(--tomato);
      background: var(--tomato-soft);
    }
    .shared-cal-popover .cal__nav:active:not(:disabled) { transform: scale(.92); }
    .shared-cal-popover .cal__dow {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      gap: 6px;
      margin-bottom: 8px;
    }
    .shared-cal-popover .cal__dow span {
      text-align: center;
      font-size: 0.7rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: .04em;
      color: var(--ink-soft);
    }
    .shared-cal-popover .cal__grid {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      gap: 6px;
    }
    .shared-cal-popover .cal__cell {
      aspect-ratio: 1 / 1;
      border: 1.5px solid transparent;
      border-radius: var(--radius-sm);
      background: transparent;
      font: inherit;
      font-weight: 600;
      font-size: 1rem;
      color: var(--ink);
      cursor: pointer;
      display: grid;
      place-items: center;
      transition: border-color .15s, background .15s;
    }
    .shared-cal-popover .cal__cell:hover:not(:disabled) { border-color: var(--tomato); }
    .shared-cal-popover .cal__cell.is-empty { visibility: hidden; cursor: default; }
    .shared-cal-popover .cal__cell.is-today { border-color: var(--tomato); color: var(--tomato-dark); }
    .shared-cal-popover .cal__cell.is-selected { background: var(--tomato); border-color: var(--tomato); color: #fff; }
    @keyframes sharedCalIn {
      from { opacity: 0; transform: translateY(-6px) scale(.98); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
  `;
  document.head.appendChild(style);
}

export function createSharedCalendar({ anchor, getDate, onSelect }) {
  injectStyles();

  const backdrop = document.createElement('button');
  backdrop.type = 'button';
  backdrop.className = 'shared-cal-backdrop';
  backdrop.hidden = true;
  backdrop.setAttribute('aria-label', 'Chiudi calendario');

  const popover = document.createElement('div');
  popover.className = 'shared-cal-popover';
  popover.hidden = true;
  popover.innerHTML = `
    <div class="cal__head">
      <button class="cal__nav" type="button" data-cal-prev aria-label="Mese precedente">&lsaquo;</button>
      <div class="cal__title" data-cal-title></div>
      <button class="cal__nav" type="button" data-cal-next aria-label="Mese successivo">&rsaquo;</button>
    </div>
    <div class="cal__dow">
      <span>Lun</span><span>Mar</span><span>Mer</span><span>Gio</span><span>Ven</span><span>Sab</span><span>Dom</span>
    </div>
    <div class="cal__grid" data-cal-grid></div>
  `;
  document.body.append(backdrop, popover);

  let shownYear = 0;
  let shownMonth = 0;

  function selectedDate() {
    return isoToDate(getDate());
  }

  function position() {
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth - 24);
    const left = Math.min(Math.max(12, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 12);
    const top = Math.min(rect.bottom + 10, window.innerHeight - 390);
    popover.style.width = `${width}px`;
    popover.style.left = `${left}px`;
    popover.style.top = `${Math.max(12, top)}px`;
  }

  function render() {
    const selected = selectedDate();
    const today = new Date();
    const todayIso = toISO(new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12));
    const selectedIso = toISO(selected);
    const first = new Date(shownYear, shownMonth, 1, 12);
    const grid = popover.querySelector('[data-cal-grid]');
    popover.querySelector('[data-cal-title]').textContent = cap(MONTH_FMT.format(first));
    grid.innerHTML = '';

    for (let i = 0; i < isoDow(first) - 1; i++) {
      const empty = document.createElement('div');
      empty.className = 'cal__cell is-empty';
      grid.appendChild(empty);
    }

    const daysInMonth = new Date(shownYear, shownMonth + 1, 0).getDate();
    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(shownYear, shownMonth, day, 12);
      const iso = toISO(date);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'cal__cell';
      if (iso === todayIso) button.classList.add('is-today');
      if (iso === selectedIso) button.classList.add('is-selected');
      button.textContent = String(day);
      button.addEventListener('click', () => {
        onSelect(iso);
        close();
      });
      grid.appendChild(button);
    }
  }

  function open() {
    const selected = selectedDate();
    shownYear = selected.getFullYear();
    shownMonth = selected.getMonth();
    render();
    position();
    backdrop.hidden = false;
    popover.hidden = false;
  }

  function close() {
    popover.hidden = true;
    backdrop.hidden = true;
  }

  popover.querySelector('[data-cal-prev]').addEventListener('click', () => {
    shownMonth--;
    if (shownMonth < 0) { shownMonth = 11; shownYear--; }
    render();
  });
  popover.querySelector('[data-cal-next]').addEventListener('click', () => {
    shownMonth++;
    if (shownMonth > 11) { shownMonth = 0; shownYear++; }
    render();
  });
  backdrop.addEventListener('click', close);
  window.addEventListener('resize', () => { if (!popover.hidden) position(); });

  return { open, close };
}
