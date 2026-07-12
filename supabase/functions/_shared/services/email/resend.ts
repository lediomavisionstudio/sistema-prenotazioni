import {
  EmailProviderConfigurationError,
  isValidEmail,
  normalizeRecipients,
  providerSafeError,
} from "./provider.ts";
import type {
  TransactionalEmailPayload,
  TransactionalEmailProvider,
  TransactionalEmailResult,
} from "./provider.ts";

type ResendResponse = {
  id?: string;
  message?: string;
  name?: string;
};

export class ResendEmailProvider implements TransactionalEmailProvider {
  readonly name = "resend" as const;

  async send(payload: TransactionalEmailPayload): Promise<TransactionalEmailResult> {
    const apiKey = Deno.env.get("RESEND_API_KEY") || "";
    const from = Deno.env.get("EMAIL_FROM") || buildFrom(payload);
    const replyTo = payload.replyTo || Deno.env.get("EMAIL_REPLY_TO") || "";
    const recipients = normalizeRecipients(payload.to);

    if (!apiKey) throw new EmailProviderConfigurationError("RESEND_API_KEY non configurata", this.name);
    if (!from) throw new EmailProviderConfigurationError("EMAIL_FROM non configurata", this.name);
    if (!recipients.length) throw new Error(providerSafeError(this.name, "destinatario email non valido"));

    const body: Record<string, unknown> = {
      from,
      to: recipients,
      subject: payload.subject,
      html: payload.html,
    };

    if (payload.text) body.text = payload.text;
    if (isValidEmail(replyTo)) body.reply_to = replyTo.trim().toLowerCase();

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const responseText = await response.text();
    const parsed = parseJson(responseText);
    if (!response.ok) {
      const details = parsed?.message || responseText || response.statusText;
      throw new Error(providerSafeError(this.name, `HTTP ${response.status}: ${details}`));
    }
    console.info("[email-provider:resend] risposta API", {
      recipients,
      messageId: parsed?.id || null,
      status: response.status,
    });

    return {
      provider: this.name,
      messageId: parsed?.id || null,
    };
  }
}

function buildFrom(payload: TransactionalEmailPayload) {
  if (!payload.senderEmail) return "";
  return payload.senderName ? `${payload.senderName} <${payload.senderEmail}>` : payload.senderEmail;
}

function parseJson(value: string): ResendResponse | null {
  try {
    return value ? JSON.parse(value) as ResendResponse : null;
  } catch (_) {
    return null;
  }
}
