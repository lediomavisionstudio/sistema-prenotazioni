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

type BookingPayload = {
  reservation_id?: string | null;
  waitlist_id?: string | null;
  venue_slug?: string | null;
  fallback_customer_email?: string | null;
};

type BookingRecord = {
  id: string;
  venue_id: string;
  reservation_date: string;
  shift_id: string;
  party_size: number;
  customer_first_name: string;
  customer_last_name: string;
  customer_phone: string;
  customer_email?: string | null;
  notes?: string | null;
  status?: string | null;
  table_id?: string | null;
  created_at?: string;
};

type Venue = {
  id: string;
  name: string;
  slug: string;
  phone?: string | null;
  address?: string | null;
  timezone?: string | null;
  contact_email?: string | null;
  notification_admin_email?: string | null;
  admin_booking_email_enabled?: boolean;
  logo_url?: string | null;
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const adminUrl = Deno.env.get("PUBLIC_ADMIN_URL") || Deno.env.get("PUBLIC_SITE_URL") || "";

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error("Supabase service secrets mancanti");
    }

    const payload = await req.json().catch(() => ({})) as BookingPayload;
    const mode = payload.waitlist_id ? "waitlist" : "reservation";
    const id = payload.waitlist_id || payload.reservation_id;
    console.info("[send-admin-booking-email] payload ricevuto", {
      reservation_id: payload.reservation_id || null,
      waitlist_id: payload.waitlist_id || null,
      venue_slug: payload.venue_slug || null,
      mode,
    });

    if (!id) {
      return json({ sent: false, error: "reservation_id o waitlist_id richiesto" }, 400);
    }

    const booking = await loadBooking(mode, id);
    if (!booking.customer_email && payload.fallback_customer_email && isValidEmail(payload.fallback_customer_email)) {
      booking.customer_email = payload.fallback_customer_email.trim().toLowerCase();
    }
    const venue = await loadVenue(booking.venue_id, payload.venue_slug);
    console.info("[send-admin-booking-email] prenotazione caricata", {
      id,
      venue_id: venue.id,
      venue_slug: venue.slug,
      notification_admin_email_configured: !!venue.notification_admin_email,
      customer_email: booking.customer_email || null,
    });

    if (venue.admin_booking_email_enabled === false) {
      await writeLog({
        venueId: venue.id,
        reservationId: mode === "reservation" ? id : null,
        waitlistId: mode === "waitlist" ? id : null,
        kind: "admin_new_booking",
        recipient: null,
        status: "skipped",
        error: "ADMIN_BOOKING_EMAIL_DISABLED",
      });
      return json({ sent: false, skipped: true, reason: "ADMIN_BOOKING_EMAIL_DISABLED" });
    }

    const adminRecipient = resolveAdminEmail(venue);
    const recipient = adminRecipient.email;
    console.info("[send-admin-booking-email] destinatario admin risolto", {
      venue_id: venue.id,
      recipient,
      source: adminRecipient.source,
    });
    if (!recipient) {
      const message = "Nessuna email admin configurata per il locale";
      await markReservation(mode, id, false, message);
      await writeLog({
        venueId: venue.id,
        reservationId: mode === "reservation" ? id : null,
        waitlistId: mode === "waitlist" ? id : null,
        kind: "admin_new_booking",
        recipient: null,
        status: "failed",
        error: message,
      });
      return json({ sent: false, error: message });
    }

    if (!isValidEmail(recipient)) {
      const message = "Email admin non valida";
      await markReservation(mode, id, false, message);
      await writeLog({
        venueId: venue.id,
        reservationId: mode === "reservation" ? id : null,
        waitlistId: mode === "waitlist" ? id : null,
        kind: "admin_new_booking",
        recipient,
        status: "failed",
        error: message,
      });
      return json({ sent: false, error: message });
    }

    const details = await loadDetails(booking);
    const html = renderAdminEmail({ booking, venue, mode, requestOrigin: requestOrigin(req), ...details });
    let sendError: string | null = null;
    let providerMessageId: string | null = null;
    const provider = getConfiguredEmailProviderName();
    try {
      console.info("[send-admin-booking-email] invio email admin", {
        provider,
        recipient,
        reservation_id: mode === "reservation" ? id : null,
        waitlist_id: mode === "waitlist" ? id : null,
      });
      const result = await sendTransactionalEmail({
        to: recipient,
        subject: "🔔 Nuova prenotazione ricevuta",
        html,
      });
      providerMessageId = result.messageId;
      console.info("[send-admin-booking-email] risposta provider email", result);
    } catch (error) {
      sendError = error instanceof Error ? error.message : String(error);
      console.error("[send-admin-booking-email] errore invio email admin", error);
    }

    if (sendError) {
      await markReservation(mode, id, false, sendError);
      await writeLog({
        venueId: venue.id,
        reservationId: mode === "reservation" ? id : null,
        waitlistId: mode === "waitlist" ? id : null,
        kind: "admin_new_booking",
        recipient,
        status: "failed",
        error: sendError,
        provider,
      });
      return json({ sent: false, error: sendError });
    }

    await markReservation(mode, id, true, null);
    await writeLog({
      venueId: venue.id,
      reservationId: mode === "reservation" ? id : null,
      waitlistId: mode === "waitlist" ? id : null,
      kind: "admin_new_booking",
      recipient,
      status: "sent",
      error: null,
      provider,
      providerMessageId,
    });

    return json({ sent: true, provider, message_id: providerMessageId });
  } catch (error) {
    console.error("[send-admin-booking-email]", error);
    return json({ sent: false, error: error instanceof Error ? error.message : String(error) });
  }
});

async function loadBooking(mode: string, id: string): Promise<BookingRecord> {
  const table = mode === "waitlist" ? "waitlist" : "reservations";
  const { data, error } = await supabase.from(table).select("*").eq("id", id).single();
  if (error || !data) throw new Error(`Prenotazione non trovata: ${error?.message || id}`);
  return data as BookingRecord;
}

async function loadVenue(venueId: string, slug?: string | null): Promise<Venue> {
  let query = supabase.from("venues").select("*").eq("id", venueId);
  if (slug) query = query.eq("slug", slug);
  const { data, error } = await query.single();
  if (error || !data) throw new Error(`Locale non trovato: ${error?.message || venueId}`);
  return data as Venue;
}

async function loadDetails(booking: BookingRecord) {
  const [{ data: shift }, { data: table }] = await Promise.all([
    supabase.from("service_shifts").select("name,start_time,end_time").eq("id", booking.shift_id).maybeSingle(),
    booking.table_id
      ? supabase.from("restaurant_tables").select("code").eq("id", booking.table_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  return {
    shift: shift as { name?: string; start_time?: string; end_time?: string } | null,
    table: table as { code?: string } | null,
  };
}

function resolveAdminEmail(venue: Venue): { email: string | null; source: string | null } {
  const notificationEmail = venue.notification_admin_email?.trim();
  if (notificationEmail) return { email: notificationEmail, source: "venues.notification_admin_email" };

  const contactEmail = venue.contact_email?.trim();
  if (contactEmail) return { email: contactEmail, source: "venues.contact_email" };

  return { email: null, source: null };
}

async function markReservation(mode: string, id: string, sent: boolean, error: string | null) {
  if (mode !== "reservation") return;
  await supabase
    .from("reservations")
    .update({
      admin_notification_sent_at: sent ? new Date().toISOString() : null,
      admin_notification_error: error,
    })
    .eq("id", id);
}

async function writeLog(params: {
  venueId: string;
  reservationId: string | null;
  waitlistId: string | null;
  kind: string;
  recipient: string | null;
  status: "sent" | "skipped" | "failed";
  error: string | null;
  provider?: string;
  providerMessageId?: string | null;
}) {
  const { error } = await supabase.from("notification_logs").insert({
    venue_id: params.venueId,
    reservation_id: params.reservationId,
    waitlist_id: params.waitlistId,
    channel: "email",
    kind: params.kind,
    recipient: params.recipient,
    provider: params.provider || getConfiguredEmailProviderName(),
    status: params.status,
    error_message: params.error,
    metadata: params.providerMessageId ? { provider_message_id: params.providerMessageId } : {},
  });
  if (error) console.error("[send-admin-booking-email] log notification_logs non scritto", error);
}

function renderAdminEmail(args: {
  booking: BookingRecord;
  venue: Venue;
  mode: string;
  requestOrigin: string | null;
  shift: { name?: string; start_time?: string; end_time?: string } | null;
  table: { code?: string } | null;
}) {
  const { booking, venue, mode, requestOrigin, shift, table } = args;
  const customerName = `${booking.customer_first_name} ${booking.customer_last_name}`.trim();
  const phoneHref = `tel:${booking.customer_phone}`;
  const customerEmail = booking.customer_email || "-";
  const emailHref = booking.customer_email ? `mailto:${booking.customer_email}` : "";
  const shiftText = shift?.start_time ? `${shift.name || "Turno"} - ${formatTime(shift.start_time)}` : "-";
  const actionUrl = adminDashboardUrl(adminUrl, requestOrigin);
  const preheader = mode === "waitlist" ? "Nuova richiesta in lista d'attesa" : "Nuova prenotazione pubblica";

  return `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Nuova prenotazione</title>
  <style>
    body { margin:0; padding:0; background:#f4f2ee; color:#211b17; font-family:Inter,Arial,sans-serif; }
    .wrap { width:100%; padding:28px 12px; }
    .card { max-width:640px; margin:0 auto; background:#fffdf8; border:1px solid #e5ded4; border-radius:8px; overflow:hidden; }
    .head { padding:24px; background:#211b17; color:#fffdf8; }
    .logo { max-height:44px; margin-bottom:18px; }
    .badge { display:inline-block; padding:7px 10px; border-radius:999px; background:#c43d2f; color:#fff; font-size:12px; font-weight:700; text-transform:uppercase; }
    h1 { margin:14px 0 4px; font-size:24px; line-height:1.2; }
    .lead { margin:0; color:#e7ded1; }
    .body { padding:24px; }
    .grid { width:100%; border-collapse:collapse; }
    .grid td { padding:12px 0; border-bottom:1px solid #eee6dc; vertical-align:top; }
    .label { width:42%; color:#6b6259; font-size:13px; }
    .value { font-weight:700; }
    .actions { padding-top:22px; }
    .btn { display:inline-block; margin:0 8px 10px 0; padding:12px 15px; border-radius:6px; background:#211b17; color:#fffdf8 !important; text-decoration:none; font-weight:700; }
    .btn.alt { background:#c43d2f; }
    .note { padding:14px; background:#faf4ea; border-radius:6px; margin-top:18px; }
    .foot { padding:18px 24px; color:#7b7166; font-size:12px; background:#f7f1e8; }
    @media (prefers-color-scheme: dark) {
      body { background:#17130f; color:#fff8ee; }
      .card { background:#211b17; border-color:#40352d; }
      .body { color:#fff8ee; }
      .grid td { border-bottom-color:#40352d; }
      .label, .foot { color:#cfc2b4; }
      .note { background:#2d251f; }
    }
  </style>
</head>
<body>
  <div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(preheader)}</div>
  <div class="wrap">
    <div class="card">
      <div class="head">
        ${venue.logo_url ? `<img class="logo" src="${escapeAttr(venue.logo_url)}" alt="${escapeAttr(venue.name)}">` : ""}
        <span class="badge">${mode === "waitlist" ? "Lista d'attesa" : "Nuova Prenotazione"}</span>
        <h1>${escapeHtml(venue.name)}</h1>
        <p class="lead">${escapeHtml(preheader)}</p>
      </div>
      <div class="body">
        <table class="grid" role="presentation">
          ${row("Nome cliente", booking.customer_first_name)}
          ${row("Cognome", booking.customer_last_name)}
          ${row("Email", customerEmail)}
          ${row("Telefono", booking.customer_phone)}
          ${row("Numero persone", String(booking.party_size))}
          ${row("Data", booking.reservation_date)}
          ${row("Orario", shiftText)}
          ${row("Tavolo", mode === "waitlist" ? "Lista d'attesa" : table?.code || "-")}
          ${row("Stato prenotazione", mode === "waitlist" ? "Lista d'attesa" : statusLabel(booking.status))}
        </table>
        ${booking.notes ? `<div class="note"><strong>Note</strong><br>${escapeHtml(booking.notes)}</div>` : ""}
        <div class="actions">
          <a class="btn" href="${escapeAttr(actionUrl)}">Apri Gestionale</a>
          <a class="btn alt" href="${escapeAttr(phoneHref)}">Chiama Cliente</a>
          ${emailHref ? `<a class="btn" href="${escapeAttr(emailHref)}">Scrivi Email</a>` : ""}
        </div>
      </div>
      <div class="foot">Sistema Prenotazioni &copy; ${new Date().getFullYear()}</div>
    </div>
  </div>
</body>
</html>`;
}

function row(label: string, value: string) {
  return `<tr><td class="label">${escapeHtml(label)}</td><td class="value">${escapeHtml(value || "-")}</td></tr>`;
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

function formatTime(value: string) {
  return value.slice(0, 5);
}

function requestOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (origin) return origin;
  const referer = req.headers.get("referer");
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch (_error) {
    return null;
  }
}

function adminDashboardUrl(value: string, fallbackOrigin: string | null = null) {
  const raw = String(value || "").trim();
  if (!raw && fallbackOrigin) return adminDashboardUrl(`${fallbackOrigin}/admin/dashboard.html`);
  if (!raw) return "#";
  try {
    const url = new URL(raw);
    const path = url.pathname.replace(/\/+$/, "");
    if (!path || path === "/admin") {
      url.pathname = `${path || "/admin"}/dashboard.html`;
    } else if (path.endsWith("/admin/index.html")) {
      url.pathname = path.replace(/index\.html$/, "dashboard.html");
    }
    return url.toString();
  } catch (_error) {
    return raw.endsWith("/admin") || raw.endsWith("/admin/")
      ? raw.replace(/\/+$/, "") + "/dashboard.html"
      : raw;
  }
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
