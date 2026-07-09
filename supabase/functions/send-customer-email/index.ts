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
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({})) as {
      reservation_id?: string;
      template?: "booking-confirmation" | "booking-reminder" | "booking-cancelled" | "booking-modified";
    };

    if (!body.reservation_id) {
      return json({ sent: false, error: "reservation_id richiesto" }, 400);
    }

    const { data: reservation, error } = await supabase
      .from("reservations")
      .select("id, venue_id, customer_email")
      .eq("id", body.reservation_id)
      .single();

    if (error || !reservation) {
      return json({ sent: false, error: error?.message || "Prenotazione non trovata" }, 404);
    }

    await supabase.from("notification_logs").insert({
      venue_id: reservation.venue_id,
      reservation_id: reservation.id,
      channel: "email",
      kind: body.template || "booking-confirmation",
      recipient: reservation.customer_email,
      provider: "resend",
      status: "skipped",
      error_message: "CUSTOMER_EMAIL_INACTIVE",
      metadata: { reason: "Architettura pronta, invio cliente non attivo in questa versione." },
    });

    return json({
      sent: false,
      skipped: true,
      reason: "CUSTOMER_EMAIL_INACTIVE",
    });
  } catch (error) {
    console.error("[send-customer-email]", error);
    return json({ sent: false, error: error instanceof Error ? error.message : String(error) });
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
