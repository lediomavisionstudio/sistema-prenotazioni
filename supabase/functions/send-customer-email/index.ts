import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  getConfiguredEmailProviderName,
  isValidEmail,
  sendTransactionalEmail,
} from "../_shared/services/email/provider.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type TemplateKind = "request_received" | "booking-confirmation" | "booking-cancelled" | "booking-modified";
type CustomerEmailStatus = "request_received" | "confirmed" | "rejected" | "modified";
type EmailContent = {
  subject: string;
  eyebrow: string;
  title: string;
  text: string;
  details: string[][];
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  let reservationId: string | null = null;
  let venueId: string | null = null;
  let recipient: string | null = null;
  let kind: TemplateKind = "request_received";

  try {
    const body = await req.json().catch(() => ({})) as {
      reservation_id?: string;
      template?: TemplateKind;
      status?: CustomerEmailStatus;
      customer_email?: string | null;
      customer_first_name?: string | null;
      customer_last_name?: string | null;
      reservation_status?: string | null;
      venue_name?: string | null;
      reservation_date?: string | null;
      reservation_time?: string | null;
      party_size?: number | null;
      table_code?: string | null;
      fallback_email?: string | null;
      fallback_customer_name?: string | null;
      fallback_notes?: string | null;
      fallback_phone?: string | null;
      fallback_used_legacy_rpc?: boolean;
    };

    reservationId = body.reservation_id || null;
    kind = resolveTemplate(body.status, body.template);
    console.info("[send-customer-email] payload ricevuto", {
      reservation_id: reservationId,
      status: body.status || null,
      template: body.template || null,
      resolved_template: kind,
      customer_email: body.customer_email || null,
      customer_first_name: body.customer_first_name || null,
      customer_last_name: body.customer_last_name || null,
      reservation_status: body.reservation_status || null,
      venue_name: body.venue_name || null,
      reservation_date: body.reservation_date || null,
      reservation_time: body.reservation_time || null,
      party_size: body.party_size || null,
      table_code: body.table_code || null,
      fallback_email: body.fallback_email || null,
      fallback_used_legacy_rpc: !!body.fallback_used_legacy_rpc,
    });
    if (!reservationId) return json({ sent: false, error: "reservation_id richiesto" }, 400);

    const booking = await loadReservation(reservationId);
    venueId = booking.venue.id;
    recipient = booking.customer_email || body.customer_email || body.fallback_email || null;
    console.info("[send-customer-email] prenotazione caricata", {
      reservation_id: reservationId,
      venue_id: venueId,
      customer_email_in_db: booking.customer_email || null,
      recipient,
      template: kind,
    });

    if (!recipient) {
      await writeLog(venueId, reservationId, kind, null, "skipped", "CUSTOMER_EMAIL_MISSING");
      return json({ sent: false, skipped: true, reason: "CUSTOMER_EMAIL_MISSING" });
    }

    if (!isValidEmail(recipient)) {
      await writeFailure(reservationId, venueId, kind, recipient, "CUSTOMER_EMAIL_INVALID");
      return json({ sent: false, error: "CUSTOMER_EMAIL_INVALID" });
    }

    if (!booking.customer_email && recipient) {
      await backfillCustomerEmail(reservationId, recipient);
    }

    const email = buildEmail(kind, booking, {
      customerName: body.fallback_customer_name || null,
      notes: body.fallback_notes || null,
    });
    const provider = getConfiguredEmailProviderName();
    console.info("[send-customer-email] invio email cliente", {
      provider,
      recipient,
      reservation_id: reservationId,
      template: kind,
    });
    const sendResult = await sendTransactionalEmail({
      to: recipient,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });
    console.info("[send-customer-email] risposta provider email", sendResult);

    await supabase.from("reservations").update({
      customer_email_sent_at: new Date().toISOString(),
      customer_email_error: null,
    }).eq("id", reservationId);
    await writeLog(venueId, reservationId, kind, recipient, "sent", null, sendResult.provider, sendResult.messageId);

    return json({ sent: true, recipient, template: kind, provider: sendResult.provider, message_id: sendResult.messageId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[send-customer-email] errore", error);
    if (reservationId && venueId) await writeFailure(reservationId, venueId, kind, recipient, message);
    return json({ sent: false, error: message });
  }
});

function resolveTemplate(status?: CustomerEmailStatus, template?: TemplateKind): TemplateKind {
  if (status === "confirmed") return "booking-confirmation";
  if (status === "rejected") return "booking-cancelled";
  if (status === "modified") return "booking-modified";
  if (status === "request_received") return "request_received";
  return template || "request_received";
}

async function loadReservation(id: string) {
  const full = await supabase
    .from("reservations")
    .select(`
      id, venue_id, reservation_date, party_size, customer_first_name,
      customer_last_name, customer_email, notes, shift_id, status, table_id,
      venue:venues(name, phone, address),
      table:restaurant_tables(code),
      shift:service_shifts(name, start_time, end_time)
    `)
    .eq("id", id)
    .single();

  if (!full.error && full.data) return full.data as {
    id: string;
    venue_id: string;
    reservation_date: string;
    party_size: number;
    customer_first_name: string;
    customer_last_name: string;
    customer_email: string | null;
    notes: string | null;
    status: string | null;
    table: { code?: string | null } | null;
    venue: { name: string; phone?: string | null; address?: string | null };
    shift: { name: string; start_time: string; end_time: string };
  };

  const basic = await supabase
    .from("reservations")
    .select(`
      id, venue_id, reservation_date, party_size, customer_first_name,
      customer_last_name, notes, shift_id, status, table_id,
      venue:venues(name, phone, address),
      table:restaurant_tables(code),
      shift:service_shifts(name, start_time, end_time)
    `)
    .eq("id", id)
    .single();

  if (basic.error || !basic.data) throw new Error(basic.error?.message || full.error?.message || "Prenotazione non trovata");
  const data = { ...basic.data, customer_email: null };
  return data as {
    id: string;
    venue_id: string;
    reservation_date: string;
    party_size: number;
    customer_first_name: string;
    customer_last_name: string;
    customer_email: string | null;
    notes: string | null;
    status: string | null;
    table: { code?: string | null } | null;
    venue: { name: string; phone?: string | null; address?: string | null };
    shift: { name: string; start_time: string; end_time: string };
  };
}

function buildEmail(
  kind: TemplateKind,
  booking: Awaited<ReturnType<typeof loadReservation>>,
  fallback: { customerName?: string | null; notes?: string | null } = {},
) {
  const name = fallback.customerName || `${booking.customer_first_name} ${booking.customer_last_name}`.trim();
  const details = [
    ["Locale", booking.venue.name],
    ["Data", booking.reservation_date],
    ["Orario", `${booking.shift.name} - ${hhmm(booking.shift.start_time)}`],
    ["Persone", String(booking.party_size)],
    ["Nome", name],
  ];
  if (booking.table?.code) details.push(["Tavolo", booking.table.code]);
  if (booking.status) details.push(["Stato", statusLabel(booking.status)]);
  const notes = booking.notes || fallback.notes;
  if (notes) details.push(["Note", notes]);
  const directionsUrl = directionsHref(booking.venue.address);

  if (kind === "booking-confirmation") {
    const email = {
      subject: "La tua prenotazione è stata confermata ✅",
      eyebrow: "Prenotazione confermata",
      title: "La tua prenotazione è confermata",
      text: "Grazie per averci scelto. La pizzeria ha confermato la tua prenotazione: ti aspettiamo!",
      details,
    };
    return { ...email, html: renderEmail(email, directionsUrl) };
  }
  if (kind === "booking-cancelled") {
    const email = {
      subject: "Aggiornamento sulla tua prenotazione",
      eyebrow: "Aggiornamento prenotazione",
      title: "Non è stato possibile confermare la richiesta",
      text: "Per motivi organizzativi non è stato possibile confermare la tua richiesta. Ti invitiamo a contattare direttamente la pizzeria oppure a riprovare scegliendo un altro orario.",
      details,
    };
    return { ...email, html: renderEmail(email, directionsUrl) };
  }
  if (kind === "booking-modified") {
    const email = {
      subject: "La tua prenotazione è stata aggiornata",
      eyebrow: "Prenotazione aggiornata",
      title: "Abbiamo aggiornato la tua prenotazione",
      text: "Ti informiamo che i dettagli della tua prenotazione sono stati aggiornati. Trovi il riepilogo qui sotto.",
      details,
    };
    return { ...email, html: renderEmail(email, directionsUrl) };
  }
  const email = {
    subject: "Abbiamo ricevuto la tua richiesta di prenotazione 🍕",
    eyebrow: "Richiesta ricevuta",
    title: `Grazie, ${booking.customer_first_name}`,
    text: "Abbiamo ricevuto correttamente la tua richiesta di prenotazione. È in attesa della conferma della pizzeria: riceverai una seconda mail con l'esito finale.",
    details,
  };
  return { ...email, html: renderEmail(email, directionsUrl) };
}

function renderEmail(email: EmailContent, directionsUrl: string | null = null) {
  const rows = email.details.map(([label, value]) => `
    <tr>
      <td style="padding:11px 0;border-bottom:1px solid #eadfc9;color:#7a6a5d">${escapeHtml(label)}</td>
      <td style="padding:11px 0;border-bottom:1px solid #eadfc9;text-align:right;font-weight:700">${escapeHtml(value)}</td>
    </tr>`).join("");

  return `<!doctype html>
<html lang="it">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#efe4c9;font-family:Inter,Arial,sans-serif;color:#3a2b23">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#efe4c9;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#fffdf6;border:1px solid #e3d6ba;border-radius:18px;overflow:hidden;box-shadow:0 14px 42px rgba(58,43,35,.12)">
        <tr><td style="padding:28px 24px 18px;background:linear-gradient(180deg,#fffdf6,#f7efdb)">
          <p style="margin:0 0 8px;color:#c8402a;font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:700">${escapeHtml(email.eyebrow)}</p>
          <h1 style="margin:0 0 12px;font-size:28px;line-height:1.15">${escapeHtml(email.title)}</h1>
          <p style="margin:0;color:#7a6a5d;line-height:1.55">${escapeHtml(email.text)}</p>
        </td></tr>
        <tr><td style="padding:6px 24px 26px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
          ${directionsUrl ? `<p style="margin:22px 0 0;text-align:center"><a href="${escapeAttr(directionsUrl)}" style="display:inline-block;padding:12px 16px;border-radius:8px;background:#3a2b23;color:#fffdf6;text-decoration:none;font-weight:700">Apri Indicazioni</a></p>` : ""}
        </td></tr>
        <tr><td style="padding:16px 24px;background:#3a2b23;color:#fffdf6;font-size:12px">Sistema Prenotazioni</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function directionsHref(address?: string | null) {
  const value = String(address || "").trim();
  if (!value) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(value)}`;
}

function statusLabel(status?: string | null) {
  return ({
    in_attesa: "In attesa",
    confermata: "Confermata",
    annullata: "Rifiutata",
    arrivato: "Arrivato",
    no_show: "No-show",
  } as Record<string, string>)[status || ""] || status || "-";
}

async function writeFailure(reservationId: string, venueId: string, kind: string, recipient: string | null, message: string) {
  await supabase.from("reservations").update({ customer_email_error: message }).eq("id", reservationId)
    .then(({ error }) => { if (error) console.error("[send-customer-email] customer_email_error non aggiornato:", error.message); });
  await writeLog(venueId, reservationId, kind, recipient, "failed", message);
}

async function backfillCustomerEmail(reservationId: string, email: string) {
  const { error } = await supabase
    .from("reservations")
    .update({ customer_email: email.toLowerCase().trim() })
    .eq("id", reservationId);
  if (error) console.error("[send-customer-email] customer_email non aggiornato:", error.message);
}

async function writeLog(
  venueId: string,
  reservationId: string,
  kind: string,
  recipient: string | null,
  status: "sent" | "skipped" | "failed",
  errorMessage: string | null,
  provider = getConfiguredEmailProviderName(),
  providerMessageId: string | null = null,
) {
  const { error } = await supabase.from("notification_logs").insert({
    venue_id: venueId,
    reservation_id: reservationId,
    channel: "email",
    kind,
    recipient,
    provider,
    status,
    error_message: errorMessage,
    metadata: providerMessageId ? { provider_message_id: providerMessageId } : {},
  });
  if (error) console.error("[send-customer-email] log non scritto:", error.message);
}

function hhmm(value: string) {
  return (value || "").slice(0, 5);
}

function escapeHtml(value: string) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char] || char));
}

function escapeAttr(value: string) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
