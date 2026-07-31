import "server-only";

import type { MailInput, SendResult } from "./types";

/**
 * Resend transport — **Markii's own mail only** (G1).
 *
 * Plain `fetch` rather than the SDK: the API is one POST, and this keeps the
 * dependency surface small on a path that runs in every function.
 */

const ENDPOINT = "https://api.resend.com/emails";

function config() {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  return apiKey && from ? { apiKey, from } : null;
}

export function isResendConfigured() {
  return config() !== null;
}

export async function sendViaResend(input: MailInput): Promise<SendResult> {
  const cfg = config();
  if (!cfg) {
    return {
      sent: false,
      provider: "none",
      reason: "Platform email is not configured (RESEND_API_KEY / EMAIL_FROM).",
    };
  }
  if (!input.html && !input.text) {
    return { sent: false, provider: "resend", reason: "Email needs an html or text body." };
  }

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: cfg.from,
        to: Array.isArray(input.to) ? input.to : [input.to],
        subject: input.subject,
        ...(input.html ? { html: input.html } : {}),
        ...(input.text ? { text: input.text } : {}),
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
      }),
    });

    const body = (await res.json().catch(() => null)) as
      | { id?: string; message?: string; name?: string }
      | null;

    if (!res.ok) {
      // Surfaced, not swallowed: the most common failure here is a from-address
      // whose domain is not verified on the account, and a silent failure makes
      // that look like a delivery problem for days.
      const detail = body?.message ?? body?.name ?? `HTTP ${res.status}`;
      console.error("[email] resend send failed", detail);
      return { sent: false, provider: "resend", reason: detail };
    }

    return { sent: true, provider: "resend", id: body?.id ?? "unknown" };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error("[email] resend request threw", e);
    return { sent: false, provider: "resend", reason };
  }
}
