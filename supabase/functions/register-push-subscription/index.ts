import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });

  try {
    if (!supabaseUrl || !serviceRoleKey) throw new Error("Supabase service secrets mancanti");
    const body = await req.json().catch(() => ({})) as {
      venue_id?: string;
      audience?: "admin" | "customer";
      reservation_id?: string | null;
      waitlist_id?: string | null;
      external_id?: string | null;
      onesignal_id?: string | null;
      subscription_id?: string | null;
      customer_email?: string | null;
      customer_phone?: string | null;
      marketing_consent?: boolean;
      notification_permission?: string | null;
      browser?: string | null;
      device_label?: string | null;
      pwa_installed?: boolean;
    };

    if (!body.subscription_id) return json({ error: "subscription_id richiesto" }, 400);
    const authUser = await getOptionalUser(req);
    const venueId = await resolveVenueId(body);
    const audience = body.audience === "admin" && authUser ? "admin" : "customer";
    if (audience === "admin") await requireStaff(authUser!.id, venueId);

    const payload = {
      venue_id: venueId,
      user_id: audience === "admin" ? authUser?.id || null : null,
      reservation_id: body.reservation_id || null,
      waitlist_id: body.waitlist_id || null,
      audience,
      external_id: body.external_id || null,
      onesignal_id: body.onesignal_id || null,
      subscription_id: body.subscription_id,
      customer_email: cleanEmail(body.customer_email),
      customer_phone: body.customer_phone || null,
      marketing_consent: !!body.marketing_consent,
      notification_permission: body.notification_permission || null,
      browser: body.browser || null,
      device_label: body.device_label || null,
      pwa_installed: !!body.pwa_installed,
      last_seen_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from("push_subscriptions")
      .upsert(payload, { onConflict: "venue_id,subscription_id" })
      .select("id, audience, subscription_id")
      .maybeSingle();
    if (error) throw error;

    return json({ ok: true, subscription: data });
  } catch (error) {
    console.error("[register-push-subscription] errore", error);
    return json({ error: error instanceof Error ? error.message : "Registrazione push non riuscita" }, 500);
  }
});

async function getOptionalUser(req: Request) {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}

async function resolveVenueId(body: { venue_id?: string; reservation_id?: string | null; waitlist_id?: string | null }) {
  if (body.venue_id) {
    return body.venue_id;
  }
  if (body.reservation_id) {
    const { data, error } = await supabase.from("reservations").select("venue_id").eq("id", body.reservation_id).maybeSingle();
    if (error) throw error;
    if (data?.venue_id) return data.venue_id;
  }
  if (body.waitlist_id) {
    const { data, error } = await supabase.from("waitlist").select("venue_id").eq("id", body.waitlist_id).maybeSingle();
    if (error) throw error;
    if (data?.venue_id) return data.venue_id;
  }
  throw new Error("venue_id non risolto");
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

function cleanEmail(value?: string | null) {
  const email = String(value || "").trim().toLowerCase();
  return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
