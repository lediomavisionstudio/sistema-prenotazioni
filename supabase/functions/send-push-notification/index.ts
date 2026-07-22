import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const oneSignalAppId = Deno.env.get("ONESIGNAL_APP_ID") || "";
const oneSignalRestApiKey = Deno.env.get("ONESIGNAL_REST_API_KEY") || "";
const pushCronSecret = Deno.env.get("PUSH_CRON_SECRET") || "";

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Audience = "all" | "marketing" | "loyal" | "waitlist" | "admin";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });

  try {
    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error("Configurazione mancante: SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY");
    }

    const body = await req.json().catch(() => ({})) as {
      action?: "manual" | "campaign" | "process_scheduled" | "admin_new_booking" | "admin_booking_cancelled" | "customer_reminder" | "waitlist_table_available" | "upcoming_event" | "diagnostics";
      venue_id?: string;
      reservation_id?: string | null;
      waitlist_id?: string | null;
      title?: string;
      message?: string;
      image_url?: string | null;
      link_url?: string | null;
      audience?: Audience;
      scheduled_for?: string | null;
      cron_secret?: string | null;
    };

    const action = body.action || "manual";
    const user = await getOptionalUser(req);
    if (action === "diagnostics") {
      if (!user) throw new Error("Utente non autenticato");
      if (!body.venue_id) throw new Error("venue_id richiesto");
      await requireStaff(user.id, body.venue_id);
      return await getDiagnostics(body.venue_id);
    }

    if (action === "process_scheduled") {
      if (!pushCronSecret) throw new Error("Configurazione mancante: PUSH_CRON_SECRET non impostato nei Supabase Secrets");
      if (body.cron_secret !== pushCronSecret) throw new Error("Cron secret non valido");
      if (!oneSignalAppId) throw new Error("Configurazione mancante: ONESIGNAL_APP_ID non impostato nei Supabase Secrets");
      if (!oneSignalRestApiKey) throw new Error("Configurazione mancante: ONESIGNAL_REST_API_KEY non impostata nei Supabase Secrets");
      return await processScheduledCampaigns();
    }

    if (!oneSignalAppId) throw new Error("Configurazione mancante: ONESIGNAL_APP_ID non impostato nei Supabase Secrets");
    if (!oneSignalRestApiKey) throw new Error("Configurazione mancante: ONESIGNAL_REST_API_KEY non impostata nei Supabase Secrets");

    if (action === "manual" || action === "campaign" || action === "upcoming_event") {
      if (!user) throw new Error("Utente non autenticato");
      if (!body.venue_id) throw new Error("venue_id richiesto");
      await requireStaff(user.id, body.venue_id);
      return await sendManual(body, user.id);
    }

    if (action === "admin_new_booking") return await sendAdminBooking(body, "new_booking");
    if (action === "admin_booking_cancelled") return await sendAdminBooking(body, "booking_cancelled");
    if (action === "customer_reminder") return await sendCustomerReservation(body, "reservation_reminder");
    if (action === "waitlist_table_available") return await sendWaitlist(body);

    return json({ error: "azione non supportata" }, 400);
  } catch (error) {
    console.error("[send-push-notification] errore", error);
    return json({ error: error instanceof Error ? error.message : "Invio push non riuscito" }, 500);
  }
});

async function getDiagnostics(venueId: string) {
  const [
    totalSubscriptions,
    adminSubscriptions,
    customerSubscriptions,
    lastSuccess,
    lastError,
  ] = await Promise.all([
    supabase
      .from("push_subscriptions")
      .select("id", { count: "exact", head: true })
      .eq("venue_id", venueId),
    supabase
      .from("push_subscriptions")
      .select("id", { count: "exact", head: true })
      .eq("venue_id", venueId)
      .eq("audience", "admin"),
    supabase
      .from("push_subscriptions")
      .select("id", { count: "exact", head: true })
      .eq("venue_id", venueId)
      .neq("audience", "admin"),
    supabase
      .from("push_notification_logs")
      .select("title, kind, audience, created_at, delivered_count, provider_notification_id")
      .eq("venue_id", venueId)
      .eq("status", "sent")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("push_notification_logs")
      .select("title, kind, audience, created_at, error")
      .eq("venue_id", venueId)
      .eq("status", "failed")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const errors = [
    totalSubscriptions.error,
    adminSubscriptions.error,
    customerSubscriptions.error,
    lastSuccess.error,
    lastError.error,
  ].filter(Boolean);
  if (errors.length) throw errors[0];

  return json({
    server: {
      app_id_configured: Boolean(oneSignalAppId),
      rest_api_configured: Boolean(oneSignalRestApiKey),
      cron_secret_configured: Boolean(pushCronSecret),
    },
    subscriptions: {
      total: totalSubscriptions.count || 0,
      admin: adminSubscriptions.count || 0,
      customer: customerSubscriptions.count || 0,
    },
    last_success: lastSuccess.data || null,
    last_error: lastError.data || null,
  });
}

async function sendManual(body: any, userId: string) {
  const audience = normalizeAudience(body.audience);
  const title = cleanText(body.title, 90) || "Comunicazione";
  const message = cleanText(body.message, 240);
  if (!message) return json({ error: "Messaggio richiesto" }, 400);

  const campaignPayload = {
    venue_id: body.venue_id,
    created_by: userId,
    title,
    message,
    image_url: body.image_url || null,
    link_url: body.link_url || null,
    audience,
    scheduled_for: body.scheduled_for || null,
    status: body.scheduled_for ? "scheduled" : "sending",
  };
  const { data: campaign, error: campaignError } = await supabase
    .from("push_campaigns")
    .insert(campaignPayload)
    .select("*")
    .maybeSingle();
  if (campaignError) throw campaignError;

  if (body.scheduled_for) {
    await logPush({ venueId: body.venue_id, campaignId: campaign.id, kind: "campaign_scheduled", title, message, audience, status: "queued" });
    return json({ scheduled: true, campaign });
  }

  const subscriptions = await loadSubscriptions(body.venue_id, audience);
  const result = await sendToSubscriptions({
    venueId: body.venue_id,
    campaignId: campaign.id,
    kind: "manual",
    title,
    message,
    imageUrl: body.image_url || null,
    linkUrl: body.link_url || null,
    subscriptions,
    audience,
  });

  await supabase.from("push_campaigns").update({
    status: result.sent ? "sent" : "failed",
    sent_at: new Date().toISOString(),
    delivered_count: result.recipients,
    provider_response: result.provider_response,
    error: result.error || null,
  }).eq("id", campaign.id);

  return json({ sent: result.sent, campaign_id: campaign.id, recipients: result.recipients, provider_response: result.provider_response, error: result.error });
}

async function processScheduledCampaigns() {
  const { data, error } = await supabase
    .from("push_campaigns")
    .select("*")
    .eq("status", "scheduled")
    .lte("scheduled_for", new Date().toISOString())
    .limit(20);
  if (error) throw error;
  const results = [];
  for (const campaign of data || []) {
    const subscriptions = await loadSubscriptions(campaign.venue_id, normalizeAudience(campaign.audience));
    const result = await sendToSubscriptions({
      venueId: campaign.venue_id,
      campaignId: campaign.id,
      kind: "campaign_scheduled",
      title: campaign.title,
      message: campaign.message,
      imageUrl: campaign.image_url,
      linkUrl: campaign.link_url,
      subscriptions,
      audience: campaign.audience,
    });
    await supabase.from("push_campaigns").update({
      status: result.sent ? "sent" : "failed",
      sent_at: new Date().toISOString(),
      delivered_count: result.recipients,
      provider_response: result.provider_response || null,
      error: result.error || null,
    }).eq("id", campaign.id);
    results.push({ campaign_id: campaign.id, ...result });
  }
  return json({ processed: results.length, results });
}

async function sendAdminBooking(body: any, kind: "new_booking" | "booking_cancelled") {
  const booking = await loadReservationOrWaitlist(body);
  const title = kind === "new_booking" ? "Nuova prenotazione" : "Prenotazione cancellata";
  const message = `${booking.customer_first_name || ""} ${booking.customer_last_name || ""} - ${booking.party_size || 0} persone`;
  const subscriptions = await loadSubscriptions(booking.venue_id, "admin");
  const result = await sendToSubscriptions({
    venueId: booking.venue_id,
    reservationId: body.reservation_id || null,
    waitlistId: body.waitlist_id || null,
    kind,
    title,
    message,
    linkUrl: "/admin/upcoming.html",
    subscriptions,
    audience: "admin",
  });
  return json(result);
}

async function sendCustomerReservation(body: any, kind: "reservation_reminder") {
  if (!body.reservation_id) throw new Error("reservation_id richiesto");
  const booking = await loadReservation(body.reservation_id);
  const subscriptions = await loadCustomerSubscriptions(booking.venue_id, { reservationId: booking.id, email: booking.customer_email, phone: booking.customer_phone });
  const title = "Promemoria prenotazione";
  const message = `Ti aspettiamo il ${booking.reservation_date} alle ${booking.shift?.start_time?.slice(0, 5) || ""}.`;
  const result = await sendToSubscriptions({
    venueId: booking.venue_id,
    reservationId: booking.id,
    kind,
    title,
    message,
    subscriptions,
    audience: "customer",
  });
  return json(result);
}

async function sendWaitlist(body: any) {
  if (!body.waitlist_id && body.reservation_id) {
    const booking = await loadReservation(body.reservation_id);
    const subscriptions = await loadCustomerSubscriptions(booking.venue_id, { reservationId: booking.id, email: booking.customer_email, phone: booking.customer_phone });
    const result = await sendToSubscriptions({
      venueId: booking.venue_id,
      reservationId: booking.id,
      kind: "waitlist_table_available",
      title: "Tavolo disponibile",
      message: "Si e' liberato un tavolo: la tua richiesta e' stata presa in carico.",
      subscriptions,
      audience: "waitlist",
    });
    return json(result);
  }
  if (!body.waitlist_id) throw new Error("waitlist_id richiesto");
  const { data, error } = await supabase.from("waitlist").select("*").eq("id", body.waitlist_id).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Voce lista attesa non trovata");
  const subscriptions = await loadCustomerSubscriptions(data.venue_id, { waitlistId: data.id, email: data.customer_email, phone: data.customer_phone });
  const result = await sendToSubscriptions({
    venueId: data.venue_id,
    waitlistId: data.id,
    kind: "waitlist_table_available",
    title: "Tavolo disponibile",
    message: "Si e' liberato un tavolo: controlla la tua richiesta.",
    subscriptions,
    audience: "waitlist",
  });
  return json(result);
}

async function loadReservationOrWaitlist(body: any) {
  if (body.waitlist_id) {
    const { data, error } = await supabase.from("waitlist").select("*").eq("id", body.waitlist_id).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("Lista attesa non trovata");
    return data;
  }
  if (!body.reservation_id) throw new Error("reservation_id richiesto");
  return await loadReservation(body.reservation_id);
}

async function loadReservation(id: string) {
  const { data, error } = await supabase
    .from("reservations")
    .select("*, shift:service_shifts(start_time,end_time)")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Prenotazione non trovata");
  return data;
}

async function loadSubscriptions(venueId: string, audience: Audience | "customer") {
  let query = supabase
    .from("push_subscriptions")
    .select("subscription_id")
    .eq("venue_id", venueId)
    .not("subscription_id", "is", null);
  if (audience === "admin") query = query.eq("audience", "admin");
  else if (audience === "marketing") query = query.eq("marketing_consent", true).neq("audience", "admin");
  else if (audience === "waitlist") query = query.not("waitlist_id", "is", null);
  else if (audience === "loyal") query = query.neq("audience", "admin");
  else query = query.neq("audience", "admin");

  const { data, error } = await query.limit(2000);
  if (error) throw error;
  return uniqueSubscriptions((data || []).map((row) => row.subscription_id));
}

async function loadCustomerSubscriptions(venueId: string, params: { reservationId?: string; waitlistId?: string; email?: string; phone?: string }) {
  const filters: string[] = [];
  if (params.reservationId) filters.push(`reservation_id.eq.${params.reservationId}`);
  if (params.waitlistId) filters.push(`waitlist_id.eq.${params.waitlistId}`);
  if (params.email) filters.push(`customer_email.eq.${params.email}`);
  if (params.phone) filters.push(`customer_phone.eq.${params.phone}`);
  if (!filters.length) return [];
  const { data, error } = await supabase
    .from("push_subscriptions")
    .select("subscription_id")
    .eq("venue_id", venueId)
    .or(filters.join(","));
  if (error) throw error;
  return uniqueSubscriptions((data || []).map((row) => row.subscription_id));
}

async function sendToSubscriptions(params: {
  venueId: string;
  campaignId?: string | null;
  reservationId?: string | null;
  waitlistId?: string | null;
  kind: string;
  title: string;
  message: string;
  imageUrl?: string | null;
  linkUrl?: string | null;
  subscriptions: string[];
  audience: string;
}) {
  if (!params.subscriptions.length) {
    await logPush({ ...params, status: "skipped", error: "NO_SUBSCRIPTIONS" });
    return { sent: false, recipients: 0, skipped: true, error: "NO_SUBSCRIPTIONS" };
  }

  const payload: Record<string, unknown> = {
    app_id: oneSignalAppId,
    include_subscription_ids: params.subscriptions,
    headings: { it: params.title, en: params.title },
    contents: { it: params.message, en: params.message },
    url: params.linkUrl || undefined,
    big_picture: params.imageUrl || undefined,
    chrome_web_image: params.imageUrl || undefined,
  };

  try {
    const response = await fetch("https://onesignal.com/api/v1/notifications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${oneSignalRestApiKey}`,
      },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    let providerResponse: any = text;
    try { providerResponse = JSON.parse(text); } catch (_) {}
    if (!response.ok) throw new Error(`OneSignal HTTP ${response.status}: ${text || response.statusText}`);
    await logPush({
      ...params,
      status: "sent",
      deliveredCount: params.subscriptions.length,
      providerNotificationId: providerResponse?.id || null,
      providerResponse,
    });
    return { sent: true, recipients: params.subscriptions.length, provider_response: providerResponse };
  } catch (error) {
    const message = error instanceof Error ? error.message : "ONESIGNAL_ERROR";
    await logPush({ ...params, status: "failed", error: message });
    return { sent: false, recipients: params.subscriptions.length, error: message };
  }
}

async function logPush(params: any) {
  const { error } = await supabase.from("push_notification_logs").insert({
    venue_id: params.venueId,
    campaign_id: params.campaignId || null,
    reservation_id: params.reservationId || null,
    waitlist_id: params.waitlistId || null,
    kind: params.kind,
    title: params.title,
    message: params.message,
    audience: params.audience || null,
    provider_notification_id: params.providerNotificationId || null,
    status: params.status,
    delivered_count: params.deliveredCount || 0,
    error: params.error || null,
    provider_response: params.providerResponse || null,
  });
  if (error) console.error("[send-push-notification] log non scritto", error);
}

async function getOptionalUser(req: Request) {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}

async function requireStaff(userId: string, venueId: string) {
  const { data, error } = await supabase
    .from("venue_staff")
    .select("id")
    .eq("venue_id", venueId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Permesso negato");
}

function uniqueSubscriptions(ids: string[]) {
  return [...new Set(ids.filter(Boolean))];
}

function normalizeAudience(value?: string): Audience {
  return (["all", "marketing", "loyal", "waitlist", "admin"].includes(value || "") ? value : "all") as Audience;
}

function cleanText(value: unknown, max: number) {
  return String(value || "").trim().slice(0, max);
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
