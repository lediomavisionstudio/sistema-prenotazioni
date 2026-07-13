import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { isValidEmail } from "../_shared/services/email/provider.ts";

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
      email?: string;
      client_request_id?: string;
      code?: string;
    };
    const email = String(body.email || "").trim().toLowerCase();
    const clientRequestId = String(body.client_request_id || "").trim();
    const code = String(body.code || "").replace(/\D/g, "").slice(0, 6);

    console.info("[verify-email-otp] payload ricevuto", {
      email,
      client_request_id: clientRequestId || null,
      code_length: code.length,
    });

    if (!otpSecret) return json({ verified: false, error: "EMAIL_OTP_SECRET non configurato" }, 500);
    if (!clientRequestId) return json({ verified: false, error: "client_request_id richiesto" }, 400);
    if (!isValidEmail(email)) return json({ verified: false, error: "EMAIL_NON_VALIDA" }, 400);
    if (!/^\d{6}$/.test(code)) return json({ verified: false, error: "OTP_NON_VALIDO" }, 400);

    const { data: row, error } = await supabase
      .from("email_verification_codes")
      .select("id, code_hash, expires_at, attempt_count, verified_at, used_at")
      .eq("client_request_id", clientRequestId)
      .eq("email", email)
      .is("verified_at", null)
      .is("used_at", null)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!row) return json({ verified: false, error: "OTP_SCADUTO_O_NON_TROVATO" }, 400);
    if ((row.attempt_count || 0) >= 5) return json({ verified: false, error: "OTP_TROPPI_TENTATIVI" }, 429);

    const expected = await hashOtp(code, email, clientRequestId);
    if (expected !== row.code_hash) {
      await supabase
        .from("email_verification_codes")
        .update({ attempt_count: (row.attempt_count || 0) + 1 })
        .eq("id", row.id);
      return json({ verified: false, error: "OTP_ERRATO" }, 400);
    }

    const verifiedAt = new Date().toISOString();
    const { error: updateError } = await supabase
      .from("email_verification_codes")
      .update({ verified_at: verifiedAt })
      .eq("id", row.id);
    if (updateError) throw updateError;

    console.info("[verify-email-otp] codice verificato", {
      email,
      client_request_id: clientRequestId,
      verification_id: row.id,
    });
    return json({ verified: true, verified_at: verifiedAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[verify-email-otp] errore", error);
    return json({ verified: false, error: message }, 500);
  }
});

async function hashOtp(code: string, email: string, clientRequestId: string) {
  const data = new TextEncoder().encode(`${otpSecret}:${email}:${clientRequestId}:${code}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
