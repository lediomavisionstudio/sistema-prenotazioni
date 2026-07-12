import nodemailer from "npm:nodemailer@6.9.16";
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

type SmtpSendInfo = {
  messageId?: string;
  response?: string;
};

export class SmtpEmailProvider implements TransactionalEmailProvider {
  readonly name = "smtp" as const;

  async send(payload: TransactionalEmailPayload): Promise<TransactionalEmailResult> {
    const host = Deno.env.get("SMTP_HOST") || "smtp.gmail.com";
    const port = Number(Deno.env.get("SMTP_PORT") || "465");
    const secure = (Deno.env.get("SMTP_SECURE") || "true").toLowerCase() !== "false";
    const user = Deno.env.get("SMTP_USER") || "";
    const pass = Deno.env.get("SMTP_PASS") || "";
    const from = payload.senderEmail || Deno.env.get("EMAIL_FROM") || user;
    const replyTo = payload.replyTo || Deno.env.get("EMAIL_REPLY_TO") || "";
    const recipients = normalizeRecipients(payload.to);

    if (!host) throw new EmailProviderConfigurationError("SMTP_HOST non configurato", this.name);
    if (!port || Number.isNaN(port)) throw new EmailProviderConfigurationError("SMTP_PORT non valido", this.name);
    if (!isValidEmail(user)) throw new EmailProviderConfigurationError("SMTP_USER non configurato o non valido", this.name);
    if (!pass) throw new EmailProviderConfigurationError("SMTP_PASS non configurato", this.name);
    if (!isValidEmail(from)) throw new EmailProviderConfigurationError("EMAIL_FROM non configurata o non valida", this.name);
    if (!recipients.length) throw new Error(providerSafeError(this.name, "destinatario email non valido"));

    const transport = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
    });

    const info = await transport.sendMail({
      from: payload.senderName ? `${payload.senderName} <${from}>` : from,
      to: recipients,
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
      replyTo: isValidEmail(replyTo) ? replyTo.trim().toLowerCase() : undefined,
    }) as SmtpSendInfo;
    console.info("[email-provider:smtp] risposta SMTP", {
      recipients,
      messageId: info.messageId || null,
      response: info.response || null,
      host,
      port,
      secure,
    });

    return {
      provider: this.name,
      messageId: info.messageId || info.response || null,
    };
  }
}
