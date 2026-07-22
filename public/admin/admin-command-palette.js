import { requireSession, escapeHtml } from './app.js';

let palette;
let input;
let list;

function actions() {
  const csvButton = document.querySelector('[data-export="csv"]');
  return [
    {
      id: 'search',
      title: 'Cerca prenotazione',
      hint: 'Sposta il cursore nella ricerca globale',
      run: () => document.querySelector('[data-global-search-input]')?.focus(),
    },
    {
      id: 'today',
      title: 'Vai a oggi',
      hint: 'Dashboard',
      run: () => document.getElementById('goToday')?.click() || (location.href = 'dashboard.html'),
    },
    {
      id: 'manual',
      title: 'Nuova prenotazione manuale',
      hint: 'Dashboard',
      run: () => document.getElementById('addBtn')?.click() || (location.href = 'dashboard.html'),
    },
    { id: 'dashboard', title: 'Apri Dashboard', hint: 'Navigazione', run: () => (location.href = 'dashboard.html') },
    { id: 'upcoming', title: 'Apri Prenotazioni', hint: 'Navigazione', run: () => (location.href = 'upcoming.html') },
    { id: 'stats', title: 'Apri Statistiche', hint: 'Navigazione', run: () => (location.href = 'stats.html') },
    { id: 'communications', title: 'Apri Comunicazioni', hint: 'Navigazione', run: () => (location.href = 'communications.html') },
    { id: 'settings', title: 'Apri Impostazioni', hint: 'Navigazione', run: () => (location.href = 'settings.html') },
    {
      id: 'theme',
      title: 'Cambia tema',
      hint: 'Chiaro / Scuro',
      run: () => {
        const current = window.AdminTheme?.resolvedTheme?.() || 'light';
        window.AdminTheme?.setPreference?.(current === 'dark' ? 'light' : 'dark');
      },
    },
    csvButton ? {
      id: 'csv',
      title: 'Esporta CSV',
      hint: 'Usa esportazione esistente',
      run: () => csvButton.click(),
    } : null,
  ].filter(Boolean);
}

function filteredActions() {
  const term = String(input.value || '').toLowerCase().trim();
  return actions().filter((action) =>
    !term || `${action.title} ${action.hint}`.toLowerCase().includes(term));
}

function render() {
  const rows = filteredActions();
  list.innerHTML = rows.length
    ? rows.map((action, index) => `<button class="command-palette__item${index === 0 ? ' is-active' : ''}" type="button" data-command="${escapeHtml(action.id)}">
        <strong>${escapeHtml(action.title)}</strong>
        <span>${escapeHtml(action.hint)}</span>
      </button>`).join('')
    : '<div class="command-palette__empty">Nessuna azione disponibile.</div>';
}

function closePalette() {
  if (!palette) return;
  palette.hidden = true;
}

function openPalette() {
  if (!palette) return;
  palette.hidden = false;
  input.value = '';
  render();
  input.focus({ preventScroll: true });
}

function runCommand(id) {
  const action = actions().find((item) => item.id === id);
  if (!action) return;
  closePalette();
  action.run();
}

function mountPalette() {
  if (document.querySelector('[data-command-palette]')) return;
  palette = document.createElement('div');
  palette.className = 'command-palette';
  palette.dataset.commandPalette = '';
  palette.hidden = true;
  palette.innerHTML = `
    <div class="command-palette__backdrop" data-command-close></div>
    <div class="command-palette__panel" role="dialog" aria-modal="true" aria-label="Command Palette">
      <input class="command-palette__input" type="search" placeholder="Cerca azioni o pagine..." autocomplete="off" />
      <div class="command-palette__list"></div>
    </div>
  `;
  document.body.appendChild(palette);
  input = palette.querySelector('.command-palette__input');
  list = palette.querySelector('.command-palette__list');
  input.addEventListener('input', render);
  palette.querySelector('[data-command-close]').addEventListener('click', closePalette);
  list.addEventListener('click', (event) => {
    const button = event.target.closest('[data-command]');
    if (button) runCommand(button.dataset.command);
  });
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openPalette();
      return;
    }
    if (event.key === 'Escape' && !palette.hidden) closePalette();
    if (event.key === 'Enter' && !palette.hidden) {
      const active = list.querySelector('.command-palette__item.is-active');
      if (active) runCommand(active.dataset.command);
    }
  });
}

(async function initCommandPalette() {
  const session = await requireSession();
  if (!session) return;
  mountPalette();
})();
