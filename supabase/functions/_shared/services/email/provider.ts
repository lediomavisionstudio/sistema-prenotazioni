import { ResendEmailProvider } from "./resend.ts";
import { SmtpEmailProvider } from "./smtp.ts";

export type EmailProviderName = "smtp" | "resend";

export type TransactionalEmailPayload = {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  senderName?: string;
  senderEmail?: string;
  replyTo?: string;
};

export type TransactionalEmailResult = {
  provider: EmailProviderName;
  messageId: string | null;
};

export interface TransactionalEmailProvider {
  readonly name: EmailProviderName;
  send(payload: TransactionalEmailPayload): Promise<TransactionalEmailResult>;
}

export class EmailProviderConfigurationError extends Error {
  constructor(message: string, readonly provider: EmailProviderName) {
    super(message);
    this.name = "EmailProviderConfigurationError";
  }
}

export function getConfiguredEmailProviderName(): EmailProviderName {
  const provider = (Deno.env.get("EMAIL_PROVIDER") || "smtp").trim().toLowerCase();
  return provider === "resend" ? "resend" : "smtp";
}

export function createEmailProvider(): TransactionalEmailProvider {
  const provider = getConfiguredEmailProviderName();
  if (provider === "resend") return new ResendEmailProvider();
  return new SmtpEmailProvider();
}

export async function sendTransactionalEmail(payload: TransactionalEmailPayload): Promise<TransactionalEmailResult> {
  const provider = createEmailProvider();
  return await provider.send(payload);
}

export function isValidEmail(email: string | null | undefined): email is string {
  return !!email && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(email.trim());
}

export function normalizeRecipients(to: string | string[]): string[] {
  return (Array.isArray(to) ? to : [to])
    .map((email) => email.trim().toLowerCase())
    .filter((email, index, list) => isValidEmail(email) && list.indexOf(email) === index);
}

export function providerSafeError(provider: EmailProviderName, message: string) {
  return `${provider}: ${message}`;
}
