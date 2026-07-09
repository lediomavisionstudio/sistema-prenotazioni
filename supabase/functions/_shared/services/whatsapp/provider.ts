export type WhatsappPayload = {
  to: string;
  body: string;
  reservationId?: string;
};

export interface WhatsappProvider {
  send(payload: WhatsappPayload): Promise<{ skipped?: boolean; providerMessageId?: string }>;
}

export function createWhatsappProvider(): WhatsappProvider {
  const provider = (Deno.env.get("WHATSAPP_PROVIDER") || "none").toLowerCase();

  if (provider === "meta") return new MetaCloudWhatsappProvider();
  if (provider === "twilio") return new TwilioWhatsappProvider();
  return new DisabledWhatsappProvider();
}

class DisabledWhatsappProvider implements WhatsappProvider {
  async send(): Promise<{ skipped: true }> {
    return { skipped: true };
  }
}

class MetaCloudWhatsappProvider implements WhatsappProvider {
  async send(_payload: WhatsappPayload): Promise<{ skipped: true }> {
    // Predisposizione:
    // usare WHATSAPP_ACCESS_TOKEN e WHATSAPP_PHONE_NUMBER_ID dai Supabase Secrets
    // per chiamare https://graph.facebook.com/<version>/<phone-number-id>/messages.
    // In produzione usare template approvati quando richiesti da Meta.
    return { skipped: true };
  }
}

class TwilioWhatsappProvider implements WhatsappProvider {
  async send(_payload: WhatsappPayload): Promise<{ skipped: true }> {
    // Predisposizione:
    // usare TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN e TWILIO_WHATSAPP_FROM
    // dai Supabase Secrets per chiamare l'API Messages di Twilio.
    return { skipped: true };
  }
}

export async function sendWhatsappReminder(payload: WhatsappPayload) {
  return createWhatsappProvider().send(payload);
}

export async function sendWhatsappConfirmation(payload: WhatsappPayload) {
  return createWhatsappProvider().send(payload);
}

export async function sendWhatsappCancellation(payload: WhatsappPayload) {
  return createWhatsappProvider().send(payload);
}
