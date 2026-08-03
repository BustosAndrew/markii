import "server-only";

import { createVerify } from "node:crypto";

/**
 * Amazon SNS message verification.
 *
 * **This endpoint must be authenticated, and a shared secret will not do it.**
 * SNS does not send one — it signs. An unverified bounce webhook is a remote
 * suppression button: anyone who found the URL could post fabricated complaints
 * and stop a merchant from mailing their own customers, silently, with the
 * damage looking exactly like a deliverability problem.
 *
 * Verification is: rebuild the canonical string SNS signs, fetch the signing
 * certificate, check the RSA signature. The certificate URL is validated
 * against an AWS host **before** it is fetched — a signature check that
 * downloads its own trust anchor from an attacker-supplied URL verifies
 * nothing, and doubles as SSRF.
 */

export type SnsEnvelope = {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Subject?: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL?: string;
  SigningCertUrl?: string;
  SubscribeURL?: string;
  Token?: string;
};

/** Fields SNS signs, in the order it signs them, per message type. */
const SIGNED_FIELDS: Record<string, string[]> = {
  Notification: ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"],
  SubscriptionConfirmation: [
    "Message",
    "MessageId",
    "SubscribeURL",
    "Timestamp",
    "Token",
    "TopicArn",
    "Type",
  ],
  UnsubscribeConfirmation: [
    "Message",
    "MessageId",
    "SubscribeURL",
    "Timestamp",
    "Token",
    "TopicArn",
    "Type",
  ],
};

/**
 * An AWS-controlled SNS host over HTTPS, and nothing else.
 *
 * `endsWith(".amazonaws.com")` would accept `evil-amazonaws.com` and
 * `sns.us-east-1.amazonaws.com.attacker.net`; the anchored pattern will not.
 */
export function isAwsSnsUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return url.protocol === "https:" && /^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname);
}

export function canonicalString(envelope: SnsEnvelope): string | null {
  const fields = SIGNED_FIELDS[envelope.Type];
  if (!fields) return null;

  let out = "";
  for (const field of fields) {
    const value = (envelope as unknown as Record<string, string | undefined>)[field];
    // `Subject` is genuinely optional and is omitted entirely when absent —
    // including it as an empty string produces a string SNS never signed.
    if (value === undefined || value === null) continue;
    out += `${field}\n${value}\n`;
  }
  return out;
}

/** Certificates change rarely; refetching one per notification would be silly. */
const certCache = new Map<string, string>();

async function signingCertificate(url: string): Promise<string | null> {
  const cached = certCache.get(url);
  if (cached) return cached;

  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const pem = await res.text();
    if (!pem.includes("BEGIN CERTIFICATE")) return null;
    certCache.set(url, pem);
    return pem;
  } catch {
    return null;
  }
}

export async function verifySnsMessage(
  envelope: SnsEnvelope,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const certUrl = envelope.SigningCertURL ?? envelope.SigningCertUrl;
  if (!certUrl || !isAwsSnsUrl(certUrl)) {
    return { ok: false, reason: "Signing certificate URL is not an AWS SNS endpoint." };
  }

  const canonical = canonicalString(envelope);
  if (canonical === null) return { ok: false, reason: `Unknown SNS message type ${envelope.Type}.` };

  const pem = await signingCertificate(certUrl);
  if (!pem) return { ok: false, reason: "Could not retrieve the SNS signing certificate." };

  // SNS still emits SignatureVersion 1 (SHA1) on older topics; 2 is SHA256.
  const algorithm = envelope.SignatureVersion === "1" ? "RSA-SHA1" : "RSA-SHA256";
  try {
    const verifier = createVerify(algorithm);
    verifier.update(canonical, "utf8");
    return verifier.verify(pem, envelope.Signature, "base64")
      ? { ok: true }
      : { ok: false, reason: "SNS signature did not verify." };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "Signature check failed." };
  }
}

/**
 * Confirm a topic subscription by fetching the URL SNS supplied.
 *
 * Only reached after the signature verified, and the URL is host-checked again
 * here rather than trusted from the caller — this is a server-side GET to an
 * address that arrived in a request body, which is the shape of every SSRF.
 */
export async function confirmSubscription(subscribeUrl: string): Promise<boolean> {
  if (!isAwsSnsUrl(subscribeUrl)) return false;
  try {
    const res = await fetch(subscribeUrl);
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// SES event payloads
// ---------------------------------------------------------------------------

export type SesEventRecipient = { emailAddress: string; diagnosticCode?: string };

export type SesEvent = {
  eventType?: string;
  notificationType?: string;
  mail?: { messageId?: string; destination?: string[] };
  bounce?: {
    bounceType?: string;
    bounceSubType?: string;
    bouncedRecipients?: SesEventRecipient[];
  };
  complaint?: {
    complaintFeedbackType?: string;
    complainedRecipients?: SesEventRecipient[];
  };
};

export type SuppressionSignal = {
  email: string;
  reason: "bounce" | "complaint";
  detail: string | null;
  messageId: string | null;
};

/**
 * What in an SES event should stop us mailing an address.
 *
 * **Only `Permanent` bounces suppress.** A `Transient` bounce is a full mailbox
 * or a greylisting server — suppressing on those would permanently cut off
 * customers whose inbox was briefly full, and the merchant would never learn
 * why their receipts stopped arriving. Complaints always suppress: the
 * recipient asked not to hear from that store again.
 */
export function suppressionSignals(event: SesEvent): SuppressionSignal[] {
  const messageId = event.mail?.messageId ?? null;
  const type = event.eventType ?? event.notificationType;

  if (type === "Bounce" && event.bounce?.bounceType === "Permanent") {
    return (event.bounce.bouncedRecipients ?? []).map((r) => ({
      email: r.emailAddress,
      reason: "bounce" as const,
      detail: event.bounce?.bounceSubType ?? r.diagnosticCode ?? null,
      messageId,
    }));
  }

  if (type === "Complaint") {
    return (event.complaint?.complainedRecipients ?? []).map((r) => ({
      email: r.emailAddress,
      reason: "complaint" as const,
      detail: event.complaint?.complaintFeedbackType ?? null,
      messageId,
    }));
  }

  return [];
}
