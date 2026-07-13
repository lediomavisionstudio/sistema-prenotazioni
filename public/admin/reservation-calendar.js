let ctx = null;
let mode = 'week';
let anchorDate = null;
let rows = [];
let loading = false;
let reloadTimer = null;

const STATUS_CLASS = {
  in_attesa: 'pending',
  confermata: 'confirmed',
  arrivato: 'arrived',
  no_show: 'noshow',
  annullata: 'cancelled',
};

export function initReservationCalendar(context) {
  ctx = context;
  anchorDate = ctx.state.date;
  ctx.$('calendarToolbar').querySelectorAll('[data-cal-mode]').forEach((button) =>
    button.addEventListener('click', () => {
      mode = button.dataset.calMode;
      setActiveMode();
      loadCalendar();
    }));
  ctx.$('calendarToolbar').querySelectorAll('[data-cal-nav]').forEach((button) =>
    button.addEventListener('click', () => {
      anchorDate = moveAnchor(button.dataset.calNav === 'next' ? 1 : -1);
      loadCalendar();
    }));
  setActiveMode();
  subscribeCalendarRealtime();
  loadCalendar();
}

export function refreshReservationCalendar() {
  if (!ctx || loading) return;
  if (anchorDate !== ctx.state.date && mode === 'day') anchorDate = ctx.state.date;
  loadCalendar();
}

function subscribeCalendarRealtime() {
  ctx.supabase.channel('calendar-' + ctx.state.venue.id)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'reservations', filter: `venue_id=eq.${ctx.state.venue.id}` },
      (payload) => {
        const range = currentRange();
        const date = payload.new?.reservation_date || payload.old?.reservation_date;
        if (!date || date < range.start || date > range.end) return;
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => loadCalendar(), 250);
      })
    .subscribe();
}

async function loadCalendar() {
  if (!ctx?.state?.venue) return;
  loading = true;
  const range = currentRange();
  ctx.$('calendarTitle').textContent = range.label;
  const box = ctx.$('reservationCalendar');
  box.innerHTML = '<div class="calendar-skeleton">Carico calendario...</div>';
  try {
    const { data, error } = await ctx.supabase
      .from('reservations')
      .select('id, reservation_date, shift_id, party_size, customer_first_name, customer_last_name, customer_phone, customer_email, notes, status, source, table_id, created_at')
      .eq('venue_id', ctx.state.venue.id)
      .gte('reservation_date', range.start)
      .lte('reservation_date', range.end)
      .order('reservation_date', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) throw error;
    rows = data || [];
    renderCalendar();
  } catch (error) {
    console.error('[calendar] caricamento fallito:', error);
    box.innerHTML = '<div class="form-error">Impossibile caricare il calendario.</div>';
  } finally {
    loading = false;
  }
}

function renderCalendar() {
  const box = ctx.$('reservationCalendar');
  if (mode === 'day') box.innerHTML = renderDay(anchorDate);
  if (mode === 'week') box.innerHTML = renderWeek();
  if (mode === 'month') box.innerHTML = renderMonth();
  if (mode === 'agenda') box.innerHTML = renderAgenda();
  wireDragAndDrop(box);
}

function renderDay(iso) {
  return `<div class="calendar-day">
    ${ctx.state.shifts.map((shift) => slotHtml(iso, shift)).join('')}
  </div>`;
}

function renderWeek() {
  const start = weekStart(anchorDate);
  const days = Array.from({ length: 7 }, (_, i) => ctx.addDays(start, i));
  return `<div class="calendar-week">
    <div class="calendar-week__head"></div>
    ${days.map((day) => `<div class="calendar-week__head">${dayLabel(day)}</div>`).join('')}
    ${ctx.state.shifts.map((shift) => `
      <div class="calendar-shift-label">${ctx.escapeHtml(shift.name)}<span>${ctx.hhmm(shift.start_time)}</span></div>
      ${days.map((day) => slotHtml(day, shift, true)).join('')}
    `).join('')}
  </div>`;
}

function renderMonth() {
  const first = monthStart(anchorDate);
  const start = weekStart(first);
  const days = Array.from({ length: 42 }, (_, i) => ctx.addDays(start, i));
  const currentMonth = anchorDate.slice(0, 7);
  return `<div class="calendar-month">
    ${['Lun','Mar','Mer','Gio','Ven','Sab','Dom'].map((d) => `<div class="calendar-month__dow">${d}</div>`).join('')}
    ${days.map((day) => {
      const dayRows = rows.filter((r) => r.reservation_date === day);
      return `<div class="calendar-month__cell ${day.slice(0, 7) === currentMonth ? '' : 'is-muted'}" data-cal-date="${day}">
        <strong>${Number(day.slice(8, 10))}</strong>
        <div>${dayRows.slice(0, 4).map(eventHtml).join('')}</div>
        ${dayRows.length > 4 ? `<span class="calendar-more">+${dayRows.length - 4}</span>` : ''}
      </div>`;
    }).join('')}
  </div>`;
}

function renderAgenda() {
  const range = currentRange();
  const days = [];
  for (let d = range.start; d <= range.end; d = ctx.addDays(d, 1)) days.push(d);
  return `<div class="calendar-agenda">
    ${days.map((day) => {
      const dayRows = rows.filter((r) => r.reservation_date === day);
      return `<section class="calendar-agenda__day" data-cal-date="${day}">
        <h3>${ctx.escapeHtml(ctx.formatLong(day))}</h3>
        ${dayRows.length ? dayRows.map(eventHtml).join('') : '<p>Nessuna prenotazione</p>'}
      </section>`;
    }).join('')}
  </div>`;
}

function slotHtml(day, shift, compact = false) {
  const slotRows = rows.filter((r) => r.reservation_date === day && r.shift_id === shift.id);
  return `<div class="calendar-slot ${compact ? 'calendar-slot--compact' : ''}" data-cal-date="${day}" data-cal-shift="${shift.id}">
    ${compact ? '' : `<h3>${ctx.escapeHtml(shift.name)}<span>${ctx.hhmm(shift.start_time)}-${ctx.hhmm(shift.end_time)}</span></h3>`}
    ${slotRows.length ? slotRows.map(eventHtml).join('') : '<span class="calendar-empty">Vuoto</span>'}
  </div>`;
}

function eventHtml(row) {
  const cls = STATUS_CLASS[row.status] || 'pending';
  const shift = ctx.state.shifts.find((s) => s.id === row.shift_id);
  return `<button class="calendar-event calendar-event--${cls}" draggable="true" data-cal-res="${ctx.escapeHtml(row.id)}" type="button">
    <strong>${ctx.escapeHtml(row.customer_last_name)} ${ctx.escapeHtml(row.customer_first_name || '')}</strong>
    <span>${row.party_size} pax${shift ? ' · ' + ctx.escapeHtml(shift.name) : ''}</span>
  </button>`;
}

function wireDragAndDrop(container) {
  container.querySelectorAll('[data-cal-res]').forEach((event) =>
    event.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/reservation-id', event.dataset.calRes);
      e.dataTransfer.effectAllowed = 'move';
    }));
  container.querySelectorAll('[data-cal-date]').forEach((slot) => {
    slot.addEventListener('dragover', (e) => { e.preventDefault(); slot.classList.add('is-drop'); });
    slot.addEventListener('dragleave', () => slot.classList.remove('is-drop'));
    slot.addEventListener('drop', (e) => {
      e.preventDefault();
      slot.classList.remove('is-drop');
      moveReservation(e.dataTransfer.getData('text/reservation-id'), slot.dataset.calDate, slot.dataset.calShift || null);
    });
  });
}

async function moveReservation(id, date, shiftId) {
  const row = rows.find((r) => r.id === id);
  if (!row || !date) return;
  const nextShift = shiftId || row.shift_id || ctx.state.shifts[0]?.id;
  const patch = { reservation_date: date, shift_id: nextShift, table_id: null };
  const { error } = await ctx.supabase.from('reservations').update(patch).eq('id', id);
  if (error) {
    console.error('[calendar] drag/drop fallito:', error);
    ctx.toast('Impossibile spostare la prenotazione.', true);
    return;
  }
  ctx.toast('Prenotazione spostata.');
  if (date === ctx.state.date || row.reservation_date === ctx.state.date) {
    await ctx.reloadDay();
  } else {
    await loadCalendar();
  }
}

function setActiveMode() {
  ctx.$('calendarToolbar').querySelectorAll('[data-cal-mode]').forEach((button) =>
    button.classList.toggle('is-active', button.dataset.calMode === mode));
}

function currentRange() {
  if (mode === 'day') return { start: anchorDate, end: anchorDate, label: ctx.formatLong(anchorDate) };
  if (mode === 'week') {
    const start = weekStart(anchorDate);
    const end = ctx.addDays(start, 6);
    return { start, end, label: `${ctx.formatLong(start)} - ${ctx.formatLong(end)}` };
  }
  if (mode === 'month') {
    const start = monthStart(anchorDate);
    const end = monthEnd(anchorDate);
    return { start, end, label: new Intl.DateTimeFormat('it-IT', { month: 'long', year: 'numeric' }).format(toDate(anchorDate)) };
  }
  const start = anchorDate;
  const end = ctx.addDays(anchorDate, 30);
  return { start, end, label: 'Agenda prossimi 30 giorni' };
}

function moveAnchor(dir) {
  if (mode === 'day') return ctx.addDays(anchorDate, dir);
  if (mode === 'week') return ctx.addDays(anchorDate, dir * 7);
  if (mode === 'agenda') return ctx.addDays(anchorDate, dir * 30);
  const d = toDate(anchorDate);
  d.setMonth(d.getMonth() + dir);
  return toISO(d);
}

function weekStart(iso) {
  const d = toDate(iso);
  const dow = d.getDay() === 0 ? 7 : d.getDay();
  d.setDate(d.getDate() - dow + 1);
  return toISO(d);
}

function monthStart(iso) {
  const d = toDate(iso);
  d.setDate(1);
  return toISO(d);
}

function monthEnd(iso) {
  const d = toDate(iso);
  d.setMonth(d.getMonth() + 1, 0);
  return toISO(d);
}

function dayLabel(iso) {
  return new Intl.DateTimeFormat('it-IT', { weekday: 'short', day: '2-digit', month: '2-digit' }).format(toDate(iso));
}

function toDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}

function toISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
