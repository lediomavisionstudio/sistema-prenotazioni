const DEFAULT_COLOR = '#f4c7bb';
const GRID = 20;
const STAGE_WIDTH = 1400;
const STAGE_HEIGHT = 900;

let ctx = null;
let selectedId = null;
let zoom = 1;
let pan = { x: 0, y: 0 };
let snapEnabled = true;
let undoStack = [];
let redoStack = [];
let saveTimer = null;
let pointerState = null;
let initialized = false;

export function initRoomDesigner(context) {
  if (initialized) return;
  initialized = true;
  ctx = context;

  ctx.$('editRoomBtn').addEventListener('click', toggleDesigner);
  ctx.$('rdAdd').addEventListener('click', addTable);
  ctx.$('rdDuplicate').addEventListener('click', duplicateSelected);
  ctx.$('rdDelete').addEventListener('click', deleteSelected);
  ctx.$('rdUndo').addEventListener('click', undo);
  ctx.$('rdRedo').addEventListener('click', redo);
  ctx.$('rdSnap').addEventListener('change', (event) => { snapEnabled = event.target.checked; });
  ctx.$('rdZoomIn').addEventListener('click', () => setZoom(zoom + 0.1));
  ctx.$('rdZoomOut').addEventListener('click', () => setZoom(zoom - 0.1));
  ctx.$('rdStage').addEventListener('pointerdown', onStagePointerDown);
  ctx.$('rdStage').addEventListener('wheel', onWheel, { passive: false });

  ['rdCode', 'rdZone', 'rdSeatsMax', 'rdShape', 'rdColor', 'rdRotation', 'rdWidth', 'rdHeight', 'rdActive', 'rdLocked']
    .forEach((id) => ctx.$(id).addEventListener('input', updateSelectedFromInspector));

  renderDesigner();
}

export function syncRoomDesigner() {
  if (!ctx || ctx.$('roomDesigner')?.hidden) return;
  renderDesigner();
}

function toggleDesigner() {
  const box = ctx.$('roomDesigner');
  box.hidden = !box.hidden;
  ctx.$('editRoomBtn').textContent = box.hidden ? 'Modifica sala' : 'Chiudi modifica sala';
  if (!box.hidden) renderDesigner();
}

function tableDefaults(table, index = 0) {
  return {
    layout_x: num(table.layout_x, 80 + (index % 6) * 150),
    layout_y: num(table.layout_y, 80 + Math.floor(index / 6) * 130),
    layout_width: num(table.layout_width, 120),
    layout_height: num(table.layout_height, 90),
    layout_rotation: num(table.layout_rotation, 0),
    layout_shape: table.layout_shape || 'rectangle',
    layout_color: table.layout_color || DEFAULT_COLOR,
    layout_locked: !!table.layout_locked,
  };
}

function renderDesigner() {
  if (!ctx) return;
  const surface = ctx.$('rdSurface');
  const tables = ctx.state.tables || [];
  surface.style.width = `${STAGE_WIDTH}px`;
  surface.style.height = `${STAGE_HEIGHT}px`;
  surface.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;

  if (!tables.length) {
    surface.innerHTML = '<div class="room-empty">Crea il primo tavolo per disegnare la sala.</div>';
    selectedId = null;
    renderInspector();
    updateButtons();
    return;
  }

  surface.innerHTML = tables.map((table, index) => tableHtml(table, index)).join('');
  surface.querySelectorAll('.room-table').forEach((node) => {
    node.addEventListener('pointerdown', onTablePointerDown);
    node.querySelector('[data-rd-handle="resize"]').addEventListener('pointerdown', onResizePointerDown);
    node.querySelector('[data-rd-handle="rotate"]').addEventListener('pointerdown', onRotatePointerDown);
  });
  renderInspector();
  updateButtons();
}

function tableHtml(table, index) {
  const layout = tableDefaults(table, index);
  const isRound = layout.layout_shape === 'round';
  const isSquare = layout.layout_shape === 'square';
  const width = isSquare ? Math.max(layout.layout_width, layout.layout_height) : layout.layout_width;
  const height = isSquare ? width : layout.layout_height;
  const activeClass = table.active ? '' : ' is-off';
  const selectedClass = table.id === selectedId ? ' is-selected' : '';
  const lockedClass = layout.layout_locked ? ' is-locked' : '';
  return `<button class="room-table room-table--${ctx.escapeHtml(layout.layout_shape)}${activeClass}${selectedClass}${lockedClass}" type="button"
      data-table-id="${ctx.escapeHtml(table.id)}"
      style="left:${layout.layout_x}px;top:${layout.layout_y}px;width:${width}px;height:${height}px;transform:rotate(${layout.layout_rotation}deg);--table-color:${ctx.escapeHtml(layout.layout_color)}">
      <span class="room-table__code">${ctx.escapeHtml(table.code)}</span>
      <span class="room-table__seats">${table.seats_max}</span>
      <span class="room-table__status">${table.active ? '' : 'Fuori servizio'}</span>
      <i class="room-table__lock">${layout.layout_locked ? 'Bloccato' : ''}</i>
      <span class="room-table__handle room-table__handle--rotate" data-rd-handle="rotate" aria-hidden="true"></span>
      <span class="room-table__handle room-table__handle--resize" data-rd-handle="resize" aria-hidden="true"></span>
    </button>`;
}

function renderInspector() {
  const table = selectedTable();
  ctx.$('rdInspectorForm').hidden = !table;
  ctx.$('rdInspector').querySelector('.room-inspector__empty').hidden = !!table;
  if (!table) return;

  const layout = tableDefaults(table);
  ctx.$('rdZone').innerHTML = ctx.state.zones.map((zone) =>
    `<option value="${ctx.escapeHtml(zone.id)}">${ctx.escapeHtml(zone.name)}</option>`).join('');
  ctx.$('rdCode').value = table.code || '';
  ctx.$('rdZone').value = table.zone_id || ctx.state.zones[0]?.id || '';
  ctx.$('rdSeatsMax').value = table.seats_max || 2;
  ctx.$('rdShape').value = layout.layout_shape;
  ctx.$('rdColor').value = normalizeColor(layout.layout_color);
  ctx.$('rdRotation').value = Math.round(layout.layout_rotation);
  ctx.$('rdWidth').value = Math.round(layout.layout_width);
  ctx.$('rdHeight').value = Math.round(layout.layout_height);
  ctx.$('rdActive').checked = table.active !== false;
  ctx.$('rdLocked').checked = !!layout.layout_locked;
}

function updateButtons() {
  const hasSelection = !!selectedTable();
  ctx.$('rdDuplicate').disabled = !hasSelection || !ctx.state.canEdit;
  ctx.$('rdDelete').disabled = !hasSelection || !ctx.state.canEdit;
  ctx.$('rdUndo').disabled = !undoStack.length || !ctx.state.canEdit;
  ctx.$('rdRedo').disabled = !redoStack.length || !ctx.state.canEdit;
  ctx.$('rdAdd').disabled = !ctx.state.canEdit;
}

function selectedTable() {
  return (ctx.state.tables || []).find((table) => table.id === selectedId) || null;
}

function selectTable(id) {
  selectedId = id;
  renderDesigner();
}

function onStagePointerDown(event) {
  if (event.target !== ctx.$('rdStage') && event.target !== ctx.$('rdSurface')) return;
  selectedId = null;
  renderDesigner();
  pointerState = { type: 'pan', startX: event.clientX, startY: event.clientY, pan: { ...pan } };
  ctx.$('rdStage').setPointerCapture(event.pointerId);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp, { once: true });
}

function onTablePointerDown(event) {
  const tableNode = event.currentTarget;
  const table = ctx.state.tables.find((item) => item.id === tableNode.dataset.tableId);
  if (!table) return;
  event.stopPropagation();
  selectTable(table.id);
  if (!ctx.state.canEdit || tableDefaults(table).layout_locked) return;
  pushHistory();
  pointerState = {
    type: 'drag',
    id: table.id,
    startX: event.clientX,
    startY: event.clientY,
    origin: { x: tableDefaults(table).layout_x, y: tableDefaults(table).layout_y },
  };
  tableNode.setPointerCapture(event.pointerId);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp, { once: true });
}

function onResizePointerDown(event) {
  const tableNode = event.currentTarget.closest('.room-table');
  const table = ctx.state.tables.find((item) => item.id === tableNode.dataset.tableId);
  if (!table || tableDefaults(table).layout_locked || !ctx.state.canEdit) return;
  event.stopPropagation();
  selectTable(table.id);
  pushHistory();
  pointerState = {
    type: 'resize',
    id: table.id,
    startX: event.clientX,
    startY: event.clientY,
    origin: { w: tableDefaults(table).layout_width, h: tableDefaults(table).layout_height },
  };
  tableNode.setPointerCapture(event.pointerId);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp, { once: true });
}

function onRotatePointerDown(event) {
  const tableNode = event.currentTarget.closest('.room-table');
  const table = ctx.state.tables.find((item) => item.id === tableNode.dataset.tableId);
  if (!table || tableDefaults(table).layout_locked || !ctx.state.canEdit) return;
  event.stopPropagation();
  selectTable(table.id);
  pushHistory();
  const rect = tableNode.getBoundingClientRect();
  pointerState = {
    type: 'rotate',
    id: table.id,
    center: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
  };
  tableNode.setPointerCapture(event.pointerId);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp, { once: true });
}

function onPointerMove(event) {
  if (!pointerState) return;
  if (pointerState.type === 'pan') {
    pan = {
      x: pointerState.pan.x + event.clientX - pointerState.startX,
      y: pointerState.pan.y + event.clientY - pointerState.startY,
    };
    renderDesigner();
    return;
  }

  const table = ctx.state.tables.find((item) => item.id === pointerState.id);
  if (!table) return;
  if (pointerState.type === 'drag') {
    table.layout_x = snap(pointerState.origin.x + (event.clientX - pointerState.startX) / zoom);
    table.layout_y = snap(pointerState.origin.y + (event.clientY - pointerState.startY) / zoom);
  }
  if (pointerState.type === 'resize') {
    table.layout_width = clamp(snap(pointerState.origin.w + (event.clientX - pointerState.startX) / zoom), 56, 360);
    table.layout_height = table.layout_shape === 'square'
      ? table.layout_width
      : clamp(snap(pointerState.origin.h + (event.clientY - pointerState.startY) / zoom), 56, 260);
  }
  if (pointerState.type === 'rotate') {
    const angle = Math.atan2(event.clientY - pointerState.center.y, event.clientX - pointerState.center.x) * 180 / Math.PI;
    table.layout_rotation = snapEnabled ? Math.round(angle / 5) * 5 : Math.round(angle);
  }
  renderDesigner();
  scheduleSave(table.id);
}

function onPointerUp() {
  pointerState = null;
  window.removeEventListener('pointermove', onPointerMove);
}

function onWheel(event) {
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  setZoom(zoom + (event.deltaY < 0 ? 0.08 : -0.08));
}

function updateSelectedFromInspector() {
  const table = selectedTable();
  if (!table || !ctx.state.canEdit) return;
  pushHistory();
  const max = parseInt(ctx.$('rdSeatsMax').value, 10) || 1;
  table.code = ctx.$('rdCode').value.trim() || table.code;
  table.zone_id = ctx.$('rdZone').value || table.zone_id;
  table.seats_max = Math.max(1, max);
  table.layout_shape = ctx.$('rdShape').value;
  table.layout_color = ctx.$('rdColor').value || DEFAULT_COLOR;
  table.layout_rotation = clamp(parseInt(ctx.$('rdRotation').value, 10) || 0, -180, 180);
  table.layout_width = clamp(parseInt(ctx.$('rdWidth').value, 10) || 120, 56, 360);
  table.layout_height = table.layout_shape === 'square'
    ? table.layout_width
    : clamp(parseInt(ctx.$('rdHeight').value, 10) || 90, 56, 260);
  table.active = ctx.$('rdActive').checked;
  table.layout_locked = ctx.$('rdLocked').checked;
  renderDesigner();
  scheduleSave(table.id);
}

async function addTable() {
  if (!ctx.state.canEdit || !ctx.state.zones.length) {
    ctx.toast('Crea almeno una zona prima di aggiungere tavoli.', true);
    return;
  }
  pushHistory();
  const code = nextTableCode();
  const payload = {
    venue_id: ctx.state.venue.id,
    code,
    zone_id: ctx.state.zones[0].id,
    seats_max: 4,
    active: true,
    layout_x: 120,
    layout_y: 120,
    layout_width: 120,
    layout_height: 90,
    layout_rotation: 0,
    layout_shape: 'rectangle',
    layout_color: DEFAULT_COLOR,
    layout_locked: false,
    layout_updated_at: new Date().toISOString(),
  };
  const { data, error } = await ctx.supabase.from('restaurant_tables').insert(payload).select('*').single();
  if (error) { console.error('[room-designer] creazione tavolo fallita:', error); ctx.toast('Impossibile creare il tavolo.', true); return; }
  ctx.state.tables.push(data);
  selectedId = data.id;
  renderDesigner();
  ctx.toast('Tavolo creato.');
  await ctx.reloadAll();
  selectedId = data.id;
  renderDesigner();
}

async function duplicateSelected() {
  const source = selectedTable();
  if (!source || !ctx.state.canEdit) return;
  pushHistory();
  const layout = tableDefaults(source);
  const payload = {
    venue_id: ctx.state.venue.id,
    code: nextTableCode(source.code),
    zone_id: source.zone_id,
    seats_max: source.seats_max,
    active: source.active,
    layout_x: layout.layout_x + GRID,
    layout_y: layout.layout_y + GRID,
    layout_width: layout.layout_width,
    layout_height: layout.layout_height,
    layout_rotation: layout.layout_rotation,
    layout_shape: layout.layout_shape,
    layout_color: layout.layout_color,
    layout_locked: false,
    layout_updated_at: new Date().toISOString(),
  };
  const { data, error } = await ctx.supabase.from('restaurant_tables').insert(payload).select('*').single();
  if (error) { console.error('[room-designer] duplicazione tavolo fallita:', error); ctx.toast('Impossibile duplicare il tavolo.', true); return; }
  ctx.state.tables.push(data);
  selectedId = data.id;
  renderDesigner();
  ctx.toast('Tavolo duplicato.');
  await ctx.reloadAll();
  selectedId = data.id;
  renderDesigner();
}

async function deleteSelected() {
  const table = selectedTable();
  if (!table || !ctx.state.canEdit) return;
  if (!confirm(`Eliminare il tavolo ${table.code}?`)) return;
  pushHistory();
  const { error } = await ctx.supabase.from('restaurant_tables').delete().eq('id', table.id);
  if (error) { console.error('[room-designer] eliminazione tavolo fallita:', error); ctx.toast('Impossibile eliminare il tavolo.', true); return; }
  ctx.state.tables = ctx.state.tables.filter((item) => item.id !== table.id);
  selectedId = null;
  renderDesigner();
  ctx.toast('Tavolo eliminato.');
  await ctx.reloadAll();
}

function scheduleSave(id) {
  if (!ctx.state.canEdit) return;
  ctx.$('rdSaveState').textContent = 'Salvataggio...';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveTable(id), 550);
}

async function saveTable(id) {
  const table = ctx.state.tables.find((item) => item.id === id);
  if (!table) return;
  const patch = sanitizeTablePatch(table);
  const { error } = await ctx.supabase.from('restaurant_tables').update(patch).eq('id', id);
  if (error) {
    console.error('[room-designer] salvataggio layout fallito:', error);
    ctx.$('rdSaveState').textContent = 'Errore salvataggio';
    ctx.toast('Layout non salvato.', true);
    return;
  }
  ctx.$('rdSaveState').textContent = 'Salvato';
  setTimeout(() => { if (ctx) ctx.$('rdSaveState').textContent = 'Salvataggio automatico'; }, 1400);
}

function sanitizeTablePatch(table) {
  const layout = tableDefaults(table);
  return {
    code: String(table.code || '').trim(),
    zone_id: table.zone_id,
    seats_max: Math.max(1, parseInt(table.seats_max, 10) || 1),
    active: table.active !== false,
    layout_x: layout.layout_x,
    layout_y: layout.layout_y,
    layout_width: layout.layout_shape === 'square' ? Math.max(layout.layout_width, layout.layout_height) : layout.layout_width,
    layout_height: layout.layout_shape === 'square' ? Math.max(layout.layout_width, layout.layout_height) : layout.layout_height,
    layout_rotation: layout.layout_rotation,
    layout_shape: ['square', 'rectangle', 'round'].includes(layout.layout_shape) ? layout.layout_shape : 'rectangle',
    layout_color: normalizeColor(layout.layout_color),
    layout_locked: !!layout.layout_locked,
    layout_updated_at: new Date().toISOString(),
  };
}

function pushHistory() {
  if (!ctx?.state?.canEdit) return;
  const snapshot = JSON.stringify(ctx.state.tables.map((table) => ({ ...table })));
  if (undoStack[undoStack.length - 1] === snapshot) return;
  undoStack.push(snapshot);
  if (undoStack.length > 40) undoStack.shift();
  redoStack = [];
  updateButtons();
}

function restore(snapshot) {
  ctx.state.tables = JSON.parse(snapshot);
  renderDesigner();
  persistAllTables();
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(JSON.stringify(ctx.state.tables.map((table) => ({ ...table }))));
  restore(undoStack.pop());
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(JSON.stringify(ctx.state.tables.map((table) => ({ ...table }))));
  restore(redoStack.pop());
}

function setZoom(next) {
  zoom = clamp(next, 0.45, 1.8);
  ctx.$('rdZoomLabel').textContent = `${Math.round(zoom * 100)}%`;
  renderDesigner();
}

async function persistAllTables() {
  ctx.$('rdSaveState').textContent = 'Salvataggio...';
  const results = await Promise.all(ctx.state.tables.map((table) =>
    ctx.supabase.from('restaurant_tables').update(sanitizeTablePatch(table)).eq('id', table.id)));
  const failed = results.find((result) => result.error);
  if (failed) {
    console.error('[room-designer] salvataggio multiplo fallito:', failed.error);
    ctx.$('rdSaveState').textContent = 'Errore salvataggio';
    ctx.toast('Alcune modifiche non sono state salvate.', true);
    return;
  }
  ctx.$('rdSaveState').textContent = 'Salvato';
  setTimeout(() => { if (ctx) ctx.$('rdSaveState').textContent = 'Salvataggio automatico'; }, 1400);
}

function nextTableCode(base = 'T') {
  const codes = new Set((ctx.state.tables || []).map((table) => String(table.code || '').toLowerCase()));
  let index = 1;
  let candidate;
  do {
    candidate = base === 'T' ? `T${index}` : `${base}-${index}`;
    index += 1;
  } while (codes.has(candidate.toLowerCase()));
  return candidate;
}

function snap(value) {
  return snapEnabled ? Math.round(value / GRID) * GRID : value;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeColor(value) {
  return /^#[0-9a-fA-F]{6}$/.test(value || '') ? value : DEFAULT_COLOR;
}
