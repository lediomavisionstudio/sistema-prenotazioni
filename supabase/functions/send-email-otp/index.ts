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

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const otpSecret = Deno.env.get("EMAIL_OTP_SECRET") || "";

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({})) as {
      venue_slug?: string;
      email?: string;
      client_request_id?: string;
    };
    const venueSlug = String(body.venue_slug || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const clientRequestId = String(body.client_request_id || "").trim();

    console.info("[send-email-otp] payload ricevuto", {
      venue_slug: venueSlug || null,
      email,
      client_request_id: clientRequestId || null,
    });

    if (!otpSecret) return json({ sent: false, error: "EMAIL_OTP_SECRET non configurato" }, 500);
    if (!venueSlug) return json({ sent: false, error: "venue_slug richiesto" }, 400);
    if (!clientRequestId) return json({ sent: false, error: "client_request_id richiesto" }, 400);
    if (!isValidEmail(email)) return json({ sent: false, error: "EMAIL_NON_VALIDA" }, 400);

    const { data: venue, error: venueError } = await supabase
      .from("venues")
      .select("id, name")
      .eq("slug", venueSlug)
      .eq("active", true)
      .maybeSingle();
    if (venueError) throw venueError;
    if (!venue) return json({ sent: false, error: "LOCALE_NON_TROVATO" }, 404);

    const { data: verifiedRows, error: verifiedLookupError } = await supabase
      .from("email_verification_codes")
      .select("id, verified_at")
      .eq("venue_id", venue.id)
      .eq("email", email)
      .not("verified_at", "is", null)
      .order("verified_at", { ascending: false })
      .limit(1);
    if (verifiedLookupError) throw verifiedLookupError;
    if ((verifiedRows || []).length > 0) {
      console.info("[send-email-otp] email gia verificata, OTP non inviato", {
        recipient: email,
        venue_id: venue.id,
        verified_at: verifiedRows?.[0]?.verified_at || null,
      });
      return json({
        sent: false,
        already_verified: true,
        verified: true,
      });
    }

    const windowStart = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { count, error: countError } = await supabase
      .from("email_verification_codes")
      .select("id", { count: "exact", head: true })
      .eq("venue_id", venue.id)
      .eq("email", email)
      .gte("created_at", windowStart);
    if (countError) throw countError;
    if ((count || 0) >= 3) {
      return json({ sent: false, error: "OTP_RESEND_LIMIT" }, 429);
    }

    const code = generateOtp();
    const codeHash = await hashOtp(code, email, clientRequestId);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const { error: insertError } = await supabase.from("email_verification_codes").insert({
      venue_id: venue.id,
      client_request_id: clientRequestId,
      email,
      code_hash: codeHash,
      expires_at: expiresAt,
    });
    if (insertError) throw insertError;

    const provider = getConfiguredEmailProviderName();
    console.info("[send-email-otp] invio codice OTP", {
      provider,
      recipient: email,
      venue_id: venue.id,
      expires_at: expiresAt,
    });
    const result = await sendTransactionalEmail({
      to: email,
      subject: "Verifica il tuo indirizzo email",
      html: renderOtpEmail(code, venue.name),
      text: `Il tuo codice di verifica per ${venue.name} e': ${code}. Il codice scade tra 10 minuti.`,
    });
    console.info("[send-email-otp] risposta provider email", result);

    return json({ sent: true, expires_in_seconds: 600, provider: result.provider, message_id: result.messageId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[send-email-otp] errore", error);
    return json({ sent: false, error: message }, 500);
  }
});

function generateOtp() {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return String(buffer[0] % 1000000).padStart(6, "0");
}

async function hashOtp(code: string, email: string, clientRequestId: string) {
  const data = new TextEncoder().encode(`${otpSecret}:${email}:${clientRequestId}:${code}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function renderOtpEmail(code: string, venueName: string) {
  const digits = code.split("").map((digit) =>
    `<span style="display:inline-block;min-width:34px;padding:10px 8px;border-radius:10px;background:#fffdf6;border:1px solid #e3d6ba;font-size:28px;font-weight:800;letter-spacing:0;color:#3a2b23">${digit}</span>`
  ).join("");

  return `<!doctype html>
<html lang="it">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#efe4c9;font-family:Inter,Arial,sans-serif;color:#3a2b23">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#efe4c9;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#fffdf6;border:1px solid #e3d6ba;border-radius:18px;overflow:hidden;box-shadow:0 14px 42px rgba(58,43,35,.12)">
        <tr><td style="padding:28px 24px 18px;background:linear-gradient(180deg,#fffdf6,#f7efdb)">
          <p style="margin:0 0 8px;color:#c8402a;font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:700">Verifica email</p>
          <h1 style="margin:0 0 12px;font-size:28px;line-height:1.15">Verifica il tuo indirizzo email</h1>
          <p style="margin:0;color:#7a6a5d;line-height:1.55">Usa questo codice per continuare la richiesta di prenotazione da ${escapeHtml(venueName)}.</p>
        </td></tr>
        <tr><td align="center" style="padding:12px 24px 28px">
          <div style="display:inline-flex;gap:7px;margin:8px 0 18px">${digits}</div>
          <p style="margin:0;color:#7a6a5d;line-height:1.55">Il codice scade tra 10 minuti.</p>
        </td></tr>
        <tr><td style="padding:16px 24px;background:#3a2b23;color:#fffdf6;font-size:12px">Sistema Prenotazioni</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
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

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
