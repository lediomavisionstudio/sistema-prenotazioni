let ctx = null;

export function initPrintExport(context) {
  ctx = context;
  ctx.$('exportToolbar').querySelectorAll('[data-export]').forEach((button) =>
    button.addEventListener('click', () => handleExport(button.dataset.export)));
}

function handleExport(type) {
  if (type === 'csv') return exportCsv();
  if (type === 'room') return openPrint('Sala', roomHtml());
  if (type === 'kitchen') return openPrint('Cucina', kitchenHtml());
  if (type === 'pdf') return openPrint('Riepilogo prenotazioni', summaryHtml(), true);
}

function activeRows() {
  return [...ctx.state.reservations]
    .filter((r) => r.status !== 'annullata')
    .sort((a, b) => shiftTime(a).localeCompare(shiftTime(b)) || a.customer_last_name.localeCompare(b.customer_last_name, 'it'));
}

function roomHtml() {
  const rows = activeRows();
  const byShift = groupByShift(rows);
  return `${printHeader('Stampa sala')}
    ${Object.entries(byShift).map(([shiftName, shiftRows]) => `
      <section class="print-section">
        <h2>${ctx.escapeHtml(shiftName)}</h2>
        <table>
          <thead><tr><th>Ora</th><th>Cliente</th><th>Coperti</th><th>Tavolo</th><th>Telefono</th><th>Stato</th><th>Note</th></tr></thead>
          <tbody>${shiftRows.map((r) => `<tr>
            <td>${ctx.escapeHtml(shiftTime(r))}</td>
            <td>${ctx.escapeHtml(fullName(r))}</td>
            <td>${r.party_size}</td>
            <td>${ctx.escapeHtml(tableCode(r))}</td>
            <td>${ctx.escapeHtml(r.customer_phone || '')}</td>
            <td><span class="print-badge">${ctx.escapeHtml(ctx.STATUS_LABEL[r.status] || r.status)}</span></td>
            <td>${ctx.escapeHtml(r.notes || '')}</td>
          </tr>`).join('')}</tbody>
        </table>
      </section>`).join('')}`;
}

function kitchenHtml() {
  const rows = activeRows().filter((r) => r.notes || r.party_size);
  return `${printHeader('Stampa cucina')}
    <section class="print-grid">
      ${rows.map((r) => `<article class="kitchen-ticket">
        <strong>${ctx.escapeHtml(shiftTime(r))} · ${r.party_size} persone</strong>
        <h2>${ctx.escapeHtml(fullName(r))}</h2>
        <p>Tavolo ${ctx.escapeHtml(tableCode(r))}</p>
        <div>${ctx.escapeHtml(r.notes || 'Nessuna nota cucina')}</div>
      </article>`).join('') || '<p>Nessuna prenotazione attiva.</p>'}
    </section>`;
}

function summaryHtml() {
  const rows = activeRows();
  const covers = rows.reduce((sum, r) => sum + (r.party_size || 0), 0);
  return `${printHeader('Riepilogo prenotazioni')}
    <div class="print-kpis">
      <div><strong>${rows.length}</strong><span>Prenotazioni</span></div>
      <div><strong>${covers}</strong><span>Coperti</span></div>
      <div><strong>${ctx.state.waitlist.length}</strong><span>Lista attesa</span></div>
    </div>
    ${roomHtml()}`;
}

function printHeader(title) {
  return `<header class="print-head">
    <div>
      <p>${ctx.escapeHtml(ctx.state.venue?.name || 'Gestionale')}</p>
      <h1>${ctx.escapeHtml(title)}</h1>
    </div>
    <span>${ctx.escapeHtml(ctx.formatLong(ctx.state.date))}</span>
  </header>`;
}

function openPrint(title, body, isPdf = false) {
  const win = window.open('', '_blank', 'width=1100,height=800');
  if (!win) { ctx.toast('Popup bloccato: abilita le finestre per stampare.', true); return; }
  win.document.write(`<!doctype html><html lang="it"><head><meta charset="utf-8" />
    <title>${ctx.escapeHtml(title)}</title>
    <style>${printCss()}</style></head><body>
    ${body}
    <script>window.onload = function(){ document.title = ${JSON.stringify(fileBase(title))}; window.print(); };</script>
  </body></html>`);
  win.document.close();
  ctx.toast(isPdf ? 'PDF pronto nella finestra di stampa.' : 'Stampa pronta.');
}

function exportCsv() {
  const headers = ['data', 'turno', 'ora', 'nome', 'cognome', 'telefono', 'email', 'coperti', 'tavolo', 'stato', 'note'];
  const lines = [headers.join(',')];
  for (const r of activeRows()) {
    lines.push([
      r.reservation_date,
      shiftName(r),
      shiftTime(r),
      r.customer_first_name || '',
      r.customer_last_name || '',
      r.customer_phone || '',
      r.customer_email || '',
      r.party_size || '',
      tableCode(r),
      ctx.STATUS_LABEL[r.status] || r.status,
      r.notes || '',
    ].map(csvCell).join(','));
  }
  const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${fileBase('prenotazioni')}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  ctx.toast('CSV esportato.');
}

function groupByShift(rows) {
  return rows.reduce((acc, row) => {
    const key = shiftName(row);
    if (!acc[key]) acc[key] = [];
    acc[key].push(row);
    return acc;
  }, {});
}

function shiftName(row) {
  return ctx.state.shifts.find((s) => s.id === row.shift_id)?.name || 'Turno';
}

function shiftTime(row) {
  return ctx.hhmm(ctx.state.shifts.find((s) => s.id === row.shift_id)?.start_time || '');
}

function tableCode(row) {
  return row.table_id ? (ctx.state.tablesById.get(row.table_id)?.code || '-') : '-';
}

function fullName(row) {
  return `${row.customer_last_name || ''} ${row.customer_first_name || ''}`.trim();
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function fileBase(prefix) {
  return `${prefix}-${ctx.state.date}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
}

function printCss() {
  return `
    *{box-sizing:border-box} body{margin:0;padding:28px;color:#221915;font-family:Inter,Arial,sans-serif;background:#fff}
    .print-head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #221915;padding-bottom:16px;margin-bottom:20px}
    .print-head p{margin:0;color:#7a6a5d;font-weight:700;text-transform:uppercase;font-size:12px;letter-spacing:.08em}
    h1{margin:4px 0 0;font-size:30px} h2{margin:22px 0 10px;font-size:18px}.print-head span{font-weight:800}
    table{width:100%;border-collapse:collapse;font-size:12px} th{text-align:left;background:#f4efe8;color:#58483d;text-transform:uppercase;font-size:10px;letter-spacing:.06em}
    th,td{border-bottom:1px solid #e7ddd2;padding:9px 8px;vertical-align:top}.print-badge{display:inline-block;border-radius:999px;background:#f4efe8;padding:4px 8px;font-weight:800}
    .print-kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px}.print-kpis div{border:1px solid #e7ddd2;border-radius:14px;padding:14px}
    .print-kpis strong{display:block;font-size:26px}.print-kpis span{color:#7a6a5d;font-size:11px;text-transform:uppercase;font-weight:800}
    .print-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}.kitchen-ticket{break-inside:avoid;border:2px solid #221915;border-radius:16px;padding:16px;min-height:160px}
    .kitchen-ticket strong{font-size:13px}.kitchen-ticket h2{font-size:24px;margin:10px 0}.kitchen-ticket p{font-weight:800}.kitchen-ticket div{margin-top:12px;padding:12px;border-radius:12px;background:#f8f4ef}
    @media print{body{padding:14mm}.print-section{break-inside:auto}.kitchen-ticket{page-break-inside:avoid}}
  `;
}
