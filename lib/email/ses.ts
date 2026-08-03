import "server-only";

import { signRequest, type AwsCredentials } from "./sigv4";
import type { MailInput, SendResult } from "./types";

/**
 * SES v2 transport — **merchant mail only** (G1): order confirmations, shipping
 * and refund notices, digital delivery, abandoned cart, shopper account mail.
 * Sent from the merchant's own verified domain, never Markii's.
 *
 * There is no Resend fallback here and there must never be one. A merchant's
 * order confirmations going out from `markii.shop` would put their bounces on
 * Markii's sending reputation — the single failure the two-provider split
 * exists to prevent. When this cannot send, it says so and stops.
 *
 * **Still required before real mail flows**, none of which is code:
 *
 * 1. AWS credentials and a region (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
 *    `AWS_REGION`).
 * 2. **Sandbox escape** — an AWS support request with a queue in front of it.
 *    Until it is granted, SES accepts mail only to verified addresses, so this
 *    module will sign and send correctly and AWS will still refuse most of it.
 * 3. An SES **configuration set** with an SNS destination pointed at
 *    `/api/webhooks/ses`, so bounces and complaints reach the suppression list.
 *    Set `SES_CONFIGURATION_SET` to its name.
 * 4. Per-merchant domain verification, which is a product feature rather than a
 *    setup step — see `lib/email/identity.ts`.
 */

export type SesSender = {
  /** `orders@acme.com` — always on the merchant's own verified domain. */
  address: string;
  /** Display name in the From header. */
  name?: string | null;
  replyTo?: string | null;
};

export type SesConfig = {
  region: string;
  credentials: AwsCredentials;
  configurationSet?: string;
};

export function sesConfig(): SesConfig | null {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const region = process.env.AWS_REGION;
  if (!accessKeyId || !secretAccessKey || !region) return null;
  return {
    region,
    credentials: {
      accessKeyId,
      secretAccessKey,
      ...(process.env.AWS_SESSION_TOKEN ? { sessionToken: process.env.AWS_SESSION_TOKEN } : {}),
    },
    ...(process.env.SES_CONFIGURATION_SET
      ? { configurationSet: process.env.SES_CONFIGURATION_SET }
      : {}),
  };
}

export function isSesConfigured(): boolean {
  return sesConfig() !== null;
}

function host(region: string): string {
  return `email.${region}.amazonaws.com`;
}

/** An SES API error, unwrapped far enough to be actionable in a log line. */
type SesError = { message?: string; Message?: string; __type?: string };

async function call(
  cfg: SesConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; reason: string }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const signed = signRequest({
    method,
    host: host(cfg.region),
    path,
    body: payload,
    region: cfg.region,
    service: "ses",
    credentials: cfg.credentials,
    ...(payload ? { headers: { "content-type": "application/json" } } : {}),
  });

  try {
    const res = await fetch(signed.url, {
      method: signed.method,
      headers: signed.headers,
      ...(signed.body ? { body: signed.body } : {}),
    });
    const data = (await res.json().catch(() => null)) as (Record<string, unknown> & SesError) | null;

    if (!res.ok) {
      const reason =
        data?.message ?? data?.Message ?? data?.__type ?? `SES returned HTTP ${res.status}`;
      // Surfaced, not swallowed. The two most common causes — an unverified
      // domain and an account still in the sandbox — both look like silent
      // non-delivery from the outside, for days.
      console.error("[email] ses request failed", method, path, reason);
      return { ok: false, reason: String(reason) };
    }
    return { ok: true, data: data ?? {} };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error("[email] ses request threw", method, path, e);
    return { ok: false, reason };
  }
}

/**
 * Send one message from a merchant's verified sender.
 *
 * The sender is a required argument rather than an env var: there is no
 * platform-wide merchant From address, and defaulting to one is precisely the
 * mistake this signature exists to make impossible.
 */
export async function sendViaSes(input: MailInput, sender: SesSender): Promise<SendResult> {
  const cfg = sesConfig();
  if (!cfg) {
    return {
      sent: false,
      provider: "none",
      reason:
        "Merchant email is not configured — AWS SES needs AWS_ACCESS_KEY_ID, " +
        "AWS_SECRET_ACCESS_KEY and AWS_REGION (docs/BACKEND.md §6).",
    };
  }
  if (!input.html && !input.text) {
    return { sent: false, provider: "ses", reason: "Email needs an html or text body." };
  }

  const to = Array.isArray(input.to) ? input.to : [input.to];
  const replyTo = input.replyTo ?? sender.replyTo ?? null;

  const result = await call(cfg, "POST", "/v2/email/outbound-emails", {
    FromEmailAddress: sender.name ? `${quoteName(sender.name)} <${sender.address}>` : sender.address,
    Destination: { ToAddresses: to },
    ...(replyTo ? { ReplyToAddresses: [replyTo] } : {}),
    /**
     * The configuration set is what routes bounce and complaint events to SNS.
     * Without it SES still sends, but nothing ever reaches the suppression list
     * and the account drifts toward a bounce-rate suspension unseen.
     */
    ...(cfg.configurationSet ? { ConfigurationSetName: cfg.configurationSet } : {}),
    Content: {
      Simple: {
        Subject: { Data: input.subject, Charset: "UTF-8" },
        Body: {
          ...(input.html ? { Html: { Data: input.html, Charset: "UTF-8" } } : {}),
          ...(input.text ? { Text: { Data: input.text, Charset: "UTF-8" } } : {}),
        },
      },
    },
  });

  if (!result.ok) return { sent: false, provider: "ses", reason: result.reason };
  return { sent: true, provider: "ses", id: String(result.data.MessageId ?? "unknown") };
}

/**
 * Quote a display name for a From header.
 *
 * A store called `Acme, Inc.` produces `Acme, Inc. <orders@acme.com>`, where the
 * comma reads as an address separator and the message is rejected — or worse,
 * sent to a second recipient. Store names are merchant-controlled, so this is
 * escaping untrusted input into a structured header, not cosmetics.
 */
export function quoteName(name: string): string {
  const clean = name.replace(/[\r\n]/g, " ").trim();
  return `"${clean.replace(/["\\]/g, "\\$&")}"`;
}

// ---------------------------------------------------------------------------
// Domain identities
// ---------------------------------------------------------------------------

export type SesIdentityState = {
  /** SES's DKIM status: `SUCCESS`, `PENDING`, `FAILED`, `TEMPORARY_FAILURE`, … */
  dkimStatus: string;
  verifiedForSending: boolean;
  tokens: string[];
};

/**
 * Register a domain with SES and get the DKIM CNAME tokens to publish.
 *
 * Easy DKIM (SES generates the key pair) rather than BYODKIM: it removes a
 * private key from the flow entirely, and the merchant's task reduces to three
 * CNAME records.
 */
export async function createSesIdentity(
  domain: string,
): Promise<{ ok: true; tokens: string[] } | { ok: false; reason: string }> {
  const cfg = sesConfig();
  if (!cfg) return { ok: false, reason: "AWS SES is not configured." };

  const res = await call(cfg, "POST", "/v2/email/identities", {
    EmailIdentity: domain,
    DkimSigningAttributes: { NextSigningKeyLength: "RSA_2048_BIT" },
  });
  if (!res.ok) return res;

  const dkim = (res.data.DkimAttributes ?? {}) as { Tokens?: string[] };
  return { ok: true, tokens: dkim.Tokens ?? [] };
}

/** Ask SES where verification actually stands. Never trust our own cached row. */
export async function getSesIdentity(
  domain: string,
): Promise<{ ok: true; state: SesIdentityState } | { ok: false; reason: string }> {
  const cfg = sesConfig();
  if (!cfg) return { ok: false, reason: "AWS SES is not configured." };

  const res = await call(cfg, "GET", `/v2/email/identities/${encodeURIComponent(domain)}`);
  if (!res.ok) return res;

  const dkim = (res.data.DkimAttributes ?? {}) as { Status?: string; Tokens?: string[] };
  return {
    ok: true,
    state: {
      dkimStatus: dkim.Status ?? "UNKNOWN",
      verifiedForSending: res.data.VerifiedForSendingStatus === true,
      tokens: dkim.Tokens ?? [],
    },
  };
}

export async function deleteSesIdentity(
  domain: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const cfg = sesConfig();
  if (!cfg) return { ok: false, reason: "AWS SES is not configured." };

  const res = await call(cfg, "DELETE", `/v2/email/identities/${encodeURIComponent(domain)}`);
  return res.ok ? { ok: true } : res;
}
