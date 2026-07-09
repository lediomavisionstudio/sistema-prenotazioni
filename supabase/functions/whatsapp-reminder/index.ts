import { createWhatsappProvider } from "../_shared/services/whatsapp/provider.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const providerName = (Deno.env.get("WHATSAPP_PROVIDER") || "none").toLowerCase();
    const provider = createWhatsappProvider();
    await provider.send({
      to: "",
      body: "",
    });

    return json({
      sent: false,
      skipped: true,
      provider: providerName,
      reason: "WHATSAPP_REMINDER_INACTIVE",
      note: "Funzione predisposta per scheduled jobs futuri; nessun messaggio viene inviato in questa versione.",
    });
  } catch (error) {
    console.error("[whatsapp-reminder]", error);
    return json({ sent: false, error: error instanceof Error ? error.message : String(error) });
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
