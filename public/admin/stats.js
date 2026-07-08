// Pagina Statistiche: grafici e KPI calcolati con query dirette a Supabase
// (nessun dato pre-aggregato). I dati rispettano la RLS: ogni utente vede solo
// i propri locali. Grafici resi con Chart.js (caricato via CDN in stats.html).
import {
  supabase, requireSession, signOut, loadCurrentVenue,
  todayISO, toISO, isoToDate, addDays, isoDow, hhmm, escapeHtml, toast, WEEKDAYS,
} from './app.js';

const $ = (id) => document.getElementById(id);

const state = {
  session: null,
  venue: null,
  role: null,
  period: '7',
  shifts: [],
  capacity: 0,
};

// Istanze Chart.js attive, distrutte e ricreate a ogni cambio periodo.
const charts = {};

// Palette coerente col design system.
const COLORS = {
  tomato: '#c8402a',
  tomatoSoft: '#f7ddd5',
  green: '#2f7d55',
  blue: '#2b6cb0',
  gold: '#b07d1a',
  ink: '#3a2b23',
  inkSoft: '#7a6a5d',
  line: '#e3d6ba',
};

// ---------------------------------------------------------------------------
// Avvio
// ---------------------------------------------------------------------------
async function init() {
  state.session = await requireSession();
  if (!state.session) return;

  $('logoutBtn').addEventListener('click', signOut);

  try {
    const current = await loadCurrentVenue();
    if (!current) {
      document.body.innerHTML = '<div class="login-wrap"><div class="login-card"><h1>Nessun locale</h1>' +
        '<p class="sub">Il tuo account non è collegato ad alcun locale.</p>' +
        '<button class="btn btn--ghost btn--block" onclick="location.href=\'index.html\'">Esci</button></div></div>';
      return;
    }
    state.venue = current.venue;
    state.role = current.role;
    $('venueName').textContent = current.venue.name;
    $('userRole').textContent = (current.role === 'owner' ? 'Titolare' : 'Staff') + ' · ' + (state.session.user.email || '');

    // Chart.js default coerenti col tema
    if (window.Chart) {
      Chart.defaults.font.family = getComputedStyle(document.body).getPropertyValue('--font-body') || 'Inter, sans-serif';
      Chart.defaults.color = COLORS.inkSoft;
    }

    await loadConfig();
    wireControls();
    await refresh();

    $('pageSpinner').hidden = true;
    $('page').hidden = false;
  } catch (err) {
    console.error(err);
    $('pageSpinner').hidden = true;
    toast('Errore di caricamento. Ricarica la pagina.', true);
  }
}

// Config (turni + capienza): serve al calcolo dell'occupazione.
async function loadConfig() {
  const [{ data: shifts, error: e1 }, { data: tables, error: e2 }] = await Promise.all([
    supabase.from('service_shifts').select('id, name, start_time, end_time, days_of_week, sort_order')
      .eq('venue_id', state.venue.id).eq('active', true).order('sort_order'),
    supabase.from('restaurant_tables').select('seats_max')
      .eq('venue_id', state.venue.id).eq('active', true),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  state.shifts = shifts || [];
  state.capacity = (tables || []).reduce((s, t) => s + (t.seats_max || 0), 0);
}

// ---------------------------------------------------------------------------
// Calcolo intervallo date in base al periodo scelto
// ---------------------------------------------------------------------------
function computeRange(period) {
  const today = todayISO();
  if (period === '7')  return { from: addDays(today, -6),  to: today };
  if (period === '30') return { from: addDays(today, -29), to: today };

  const now = isoToDate(today);
  if (period === 'this_month') {
    const from = toISO(new Date(now.getFullYear(), now.getMonth(), 1));
    return { from, to: today };
  }
  if (period === 'last_month') {
    const from = toISO(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    const to = toISO(new Date(now.getFullYear(), now.getMonth(), 0)); // giorno 0 = ultimo del mese prec.
    return { from, to };
  }
  return { from: addDays(today, -6), to: today };
}

// Elenco di tutte le date ISO comprese nell'intervallo (estremi inclusi).
function datesBetween(from, to) {
  const out = [];
  let d = from;
  let guard = 0;
  while (d <= to && guard < 400) { out.push(d); d = addDays(d, 1); guard++; }
  return out;
}

// ---------------------------------------------------------------------------
// Caricamento + render
// ---------------------------------------------------------------------------
async function refresh() {
  const { from, to } = computeRange(state.period);
  $('rangeLabel').textContent = `Dal ${labelDate(from)} al ${labelDate(to)}`;

  // Periodo corrente + periodo precedente (di pari durata) per il trend no-show.
  const days = datesBetween(from, to).length;
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(days - 1));

  const [rows, prevRows] = await Promise.all([
    fetchReservations(from, to),
    fetchReservations(prevFrom, prevTo),
  ]);

  renderKpis(rows, prevRows, from, to);
  renderCoversPerDay(rows, from, to);
  renderShiftOccupancy(rows, from, to);
  renderSource(rows);
  renderWeekday(rows, from, to);
  renderTopCustomers(rows);
}

async function fetchReservations(from, to) {
  const { data, error } = await supabase
    .from('reservations')
    .select('reservation_date, shift_id, party_size, status, source, customer_first_name, customer_last_name, customer_phone')
    .eq('venue_id', state.venue.id)
    .gte('reservation_date', from)
    .lte('reservation_date', to);
  if (error) throw error;
  return data || [];
}

// Helper stato
const isServed = (r) => r.status === 'confermata' || r.status === 'arrivato';
const isActive = (r) => r.status !== 'annullata';

// ---------------------------------------------------------------------------
// KPI
// ---------------------------------------------------------------------------
function renderKpis(rows, prevRows, from, to) {
  const active = rows.filter(isActive);
  const covers = rows.filter(isServed).reduce((s, r) => s + r.party_size, 0);

  $('kpiRes').textContent = active.length;
  $('kpiCovers').textContent = covers;

  const rate = noShowRate(rows);
  const prevRate = noShowRate(prevRows);
  $('kpiNoShow').textContent = fmtPct(rate);

  // Trend vs periodo precedente (freccia): meno no-show = meglio (verde).
  const trendEl = $('kpiNoShowTrend');
  if (rate == null || prevRate == null) {
    trendEl.textContent = '';
  } else {
    const delta = Math.round((rate - prevRate) * 10) / 10;
    if (delta === 0) { trendEl.textContent = '= 0'; trendEl.className = 'trend'; }
    else if (delta < 0) { trendEl.textContent = '▼ ' + Math.abs(delta) + '%'; trendEl.className = 'trend trend--good'; }
    else { trendEl.textContent = '▲ ' + delta + '%'; trendEl.className = 'trend trend--bad'; }
  }

  const widgetCount = active.filter((r) => r.source === 'widget').length;
  const widgetPct = active.length ? Math.round((widgetCount / active.length) * 100) : 0;
  $('kpiWidget').textContent = widgetPct + '%';
}

// Tasso no-show = no_show / (serviti + no_show). null se nessun dato utile.
function noShowRate(rows) {
  const noShow = rows.filter((r) => r.status === 'no_show').length;
  const base = rows.filter((r) => isServed(r) || r.status === 'no_show').length;
  if (base === 0) return null;
  return (noShow / base) * 100;
}

const fmtPct = (v) => (v == null ? '—' : Math.round(v) + '%');

// ---------------------------------------------------------------------------
// Grafico: coperti per giorno (barre)
// ---------------------------------------------------------------------------
function renderCoversPerDay(rows, from, to) {
  const dates = datesBetween(from, to);
  const byDate = new Map(dates.map((d) => [d, 0]));
  for (const r of rows) {
    if (isServed(r) && byDate.has(r.reservation_date)) {
      byDate.set(r.reservation_date, byDate.get(r.reservation_date) + r.party_size);
    }
  }
  drawChart('chartCovers', {
    type: 'bar',
    data: {
      labels: dates.map(shortDate),
      datasets: [{
        label: 'Coperti',
        data: dates.map((d) => byDate.get(d)),
        backgroundColor: COLORS.tomato,
        borderRadius: 4,
        maxBarThickness: 34,
      }],
    },
    options: baseOptions({ yTitle: 'Coperti' }),
  });
}

// ---------------------------------------------------------------------------
// Grafico: occupazione per turno (barre %)
// ---------------------------------------------------------------------------
function renderShiftOccupancy(rows, from, to) {
  const dates = datesBetween(from, to);
  const labels = [];
  const values = [];

  for (const s of state.shifts) {
    // Giorni del periodo in cui questo turno è attivo (per il denominatore).
    const daysOperated = dates.filter((d) => (s.days_of_week || []).includes(isoDow(d))).length;
    const covers = rows
      .filter((r) => r.shift_id === s.id && isServed(r))
      .reduce((acc, r) => acc + r.party_size, 0);
    const denom = state.capacity * Math.max(1, daysOperated);
    const occ = denom > 0 ? Math.round((covers / denom) * 100) : 0;
    labels.push(s.name);
    values.push(occ);
  }

  drawChart('chartShifts', {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Occupazione %',
        data: values,
        backgroundColor: [COLORS.tomato, COLORS.blue, COLORS.gold, COLORS.green, COLORS.inkSoft],
        borderRadius: 4,
        maxBarThickness: 60,
      }],
    },
    options: baseOptions({ yTitle: '%', yMax: 100 }),
  });
}

// ---------------------------------------------------------------------------
// Grafico: origine prenotazioni (ciambella widget vs manuali)
// ---------------------------------------------------------------------------
function renderSource(rows) {
  const active = rows.filter(isActive);
  const widget = active.filter((r) => r.source === 'widget').length;
  const manual = active.filter((r) => r.source === 'manuale').length;

  drawChart('chartSource', {
    type: 'doughnut',
    data: {
      labels: ['Widget', 'Manuali'],
      datasets: [{
        data: [widget, manual],
        backgroundColor: [COLORS.tomato, COLORS.gold],
        borderColor: '#fffdf6',
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom' } },
      cutout: '62%',
    },
  });
}

// ---------------------------------------------------------------------------
// Grafico: media coperti per giorno della settimana
// ---------------------------------------------------------------------------
function renderWeekday(rows, from, to) {
  const dates = datesBetween(from, to);
  // Quante volte ricorre ogni giorno della settimana nel periodo (denominatore).
  const occurrences = [0, 0, 0, 0, 0, 0, 0]; // indice 0..6 = lun..dom
  for (const d of dates) occurrences[isoDow(d) - 1]++;

  const totals = [0, 0, 0, 0, 0, 0, 0];
  for (const r of rows) {
    if (!isServed(r)) continue;
    totals[isoDow(r.reservation_date) - 1] += r.party_size;
  }
  const avgs = totals.map((t, i) => occurrences[i] ? Math.round((t / occurrences[i]) * 10) / 10 : 0);

  // Giorno più forte
  let bestIdx = -1, bestVal = -1;
  avgs.forEach((v, i) => { if (v > bestVal) { bestVal = v; bestIdx = i; } });
  $('bestDay').textContent = bestVal > 0 ? `Più forte: ${WEEKDAYS[bestIdx].long} (${bestVal})` : '—';

  drawChart('chartWeekday', {
    type: 'bar',
    data: {
      labels: WEEKDAYS.map((w) => w.short),
      datasets: [{
        label: 'Media coperti',
        data: avgs,
        backgroundColor: avgs.map((_, i) => (i === bestIdx ? COLORS.tomato : COLORS.tomatoSoft)),
        borderColor: COLORS.tomato,
        borderWidth: 1,
        borderRadius: 4,
        maxBarThickness: 46,
      }],
    },
    options: baseOptions({ yTitle: 'Media coperti' }),
  });
}

// ---------------------------------------------------------------------------
// Top 10 clienti per numero di prenotazioni
// ---------------------------------------------------------------------------
function renderTopCustomers(rows) {
  const byPhone = new Map();
  for (const r of rows.filter(isActive)) {
    const key = (r.customer_phone || '').trim() || `${r.customer_last_name} ${r.customer_first_name}`;
    if (!byPhone.has(key)) {
      byPhone.set(key, { name: `${r.customer_last_name} ${r.customer_first_name}`.trim(), phone: r.customer_phone, count: 0 });
    }
    byPhone.get(key).count++;
  }
  const top = [...byPhone.values()].sort((a, b) => b.count - a.count).slice(0, 10);

  if (top.length === 0) {
    $('topCustomers').innerHTML = '<div class="res-empty">Nessuna prenotazione nel periodo.</div>';
    return;
  }

  $('topCustomers').innerHTML = `
    <div class="rank-list">
      ${top.map((c, i) => `
        <div class="rank">
          <span class="rank__pos">${i + 1}</span>
          <span class="rank__name">${escapeHtml(c.name)}</span>
          <a class="rank__phone" href="tel:${escapeHtml(c.phone || '')}">${escapeHtml(c.phone || '')}</a>
          <span class="rank__count">${c.count} pren.</span>
        </div>`).join('')}
    </div>`;
}

// ---------------------------------------------------------------------------
// Chart.js helpers
// ---------------------------------------------------------------------------
function drawChart(canvasId, cfg) {
  if (charts[canvasId]) charts[canvasId].destroy();
  const ctx = $(canvasId).getContext('2d');
  charts[canvasId] = new Chart(ctx, cfg);
}

function baseOptions({ yTitle, yMax } = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { display: false } },
      y: {
        beginAtZero: true,
        max: yMax,
        title: yTitle ? { display: true, text: yTitle } : undefined,
        grid: { color: COLORS.line },
        ticks: { precision: 0 },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Utility date
// ---------------------------------------------------------------------------
const dfShort = new Intl.DateTimeFormat('it-IT', { day: '2-digit', month: '2-digit' });
const dfLabel = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'long' });
const shortDate = (iso) => dfShort.format(isoToDate(iso));
const labelDate = (iso) => dfLabel.format(isoToDate(iso));

// ---------------------------------------------------------------------------
// Controlli
// ---------------------------------------------------------------------------
function wireControls() {
  $('periodTabs').querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      $('periodTabs').querySelectorAll('.tab').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      state.period = btn.dataset.period;
      refresh().catch((e) => { console.error(e); toast('Errore nel caricamento dati.', true); });
    });
  });
}

init();
