import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, sites } from "../db";
import {
  confirmSignupEmail,
  emailChangeEmail,
  magicLinkEmail,
  resetPasswordEmail,
  type RenderedEmail,
} from "./templates";

/**
 * Supabase Send Email Hook — payload verification and routing (§24).
 *
 * **Enabling this hook replaces Supabase's mailer entirely, for the whole
 * project.** It is not scoped to shoppers: staff password resets and invites
 * come through here too, and if this handler does not deal with them, the team
 * loses its own auth mail the moment the hook goes live. That is the single
 * biggest risk in this feature and the reason `routeFor` branches on
 * `user_kind` before anything else.
 */

/** Supabase signs with Standard Webhooks: `v1,<base64 sig>` over `id.timestamp.body`. */
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

export type HookHeaders = {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
};

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Verifies the Standard Webhooks signature.
 *
 * The secret arrives from Supabase as `v1,whsec_…`; the bytes that sign the
 * payload are the **base64-decoded** part after the prefix. Signing the literal
 * string instead is the classic way to get a verifier that rejects every real
 * request while passing its own tests.
 */
export function verifyHookSignature(
  body: string,
  headers: HookHeaders,
  secret: string,
  now: Date = new Date(),
): VerifyResult {
  if (!headers.id || !headers.timestamp || !headers.signature) {
    return { ok: false, reason: "missing webhook signature headers" };
  }

  const sent = Number(headers.timestamp);
  if (!Number.isFinite(sent)) return { ok: false, reason: "invalid timestamp" };
  /**
   * A replay window, not decoration: without it a captured request re-sent
   * later would re-send a still-valid auth token to the same address.
   */
  if (Math.abs(Math.floor(now.getTime() / 1000) - sent) > SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: "timestamp outside tolerance" };
  }

  const raw = secret.startsWith("v1,") ? secret.slice(3) : secret;
  const key = Buffer.from(raw.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key)
    .update(`${headers.id}.${headers.timestamp}.${body}`)
    .digest("base64");

  /**
   * The header may carry several space-separated versioned signatures during a
   * secret roll. Accepting any match is what lets a secret be rotated without
   * dropping events — the same reasoning as the Stripe receiver.
   */
  const candidates = headers.signature
    .split(" ")
    .map((part) => (part.startsWith("v1,") ? part.slice(3) : part));

  const expectedBuf = Buffer.from(expected);
  const matched = candidates.some((candidate) => {
    const buf = Buffer.from(candidate);
    return buf.length === expectedBuf.length && timingSafeEqual(buf, expectedBuf);
  });

  return matched ? { ok: true } : { ok: false, reason: "signature mismatch" };
}

export type HookPayload = {
  user: {
    id: string;
    email: string;
    app_metadata?: Record<string, unknown> | null;
  };
  email_data: {
    token: string;
    token_hash: string;
    redirect_to: string;
    email_action_type: string;
    site_url?: string;
  };
};

export type AuthAction =
  | "signup"
  | "recovery"
  | "magiclink"
  | "invite"
  | "email_change"
  | "email_change_current"
  | "email_change_new"
  | "unknown";

export function actionOf(payload: HookPayload): AuthAction {
  const raw = payload.email_data.email_action_type;
  const known: AuthAction[] = [
    "signup",
    "recovery",
    "magiclink",
    "invite",
    "email_change",
    "email_change_current",
    "email_change_new",
  ];
  return (known as string[]).includes(raw) ? (raw as AuthAction) : "unknown";
}

/**
 * The URL the shopper clicks.
 *
 * Built from `token_hash` against Supabase's verify endpoint rather than from
 * the six-digit `token`, because that is the link-based flow — and the redirect
 * is carried through so the shopper lands back on the storefront they started
 * on rather than on Markii.
 */
export function actionUrl(payload: HookPayload, supabaseUrl: string): string {
  const url = new URL(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/verify`);
  url.searchParams.set("token", payload.email_data.token_hash);
  url.searchParams.set("type", payload.email_data.email_action_type);
  if (payload.email_data.redirect_to) {
    url.searchParams.set("redirect_to", payload.email_data.redirect_to);
  }
  return url.toString();
}

export const TEMPLATE_FOR: Record<
  AuthAction,
  { id: string; render: (ctx: { storeName: string; actionUrl: string; toEmail: string }) => RenderedEmail } | null
> = {
  signup: { id: "auth_confirm_signup", render: confirmSignupEmail },
  invite: { id: "auth_confirm_signup", render: confirmSignupEmail },
  recovery: { id: "auth_reset_password", render: resetPasswordEmail },
  magiclink: { id: "auth_magic_link", render: magicLinkEmail },
  email_change: { id: "auth_email_change", render: emailChangeEmail },
  email_change_current: { id: "auth_email_change", render: emailChangeEmail },
  email_change_new: { id: "auth_email_change", render: emailChangeEmail },
  unknown: null,
};

export type Recipient =
  | { stream: "platform"; reason: "staff" }
  /** A shopper, and the merchant whose domain the mail must come from. */
  | { stream: "merchant"; orgId: string; siteId: number; slug: string; storeName: string }
  | { stream: "refuse"; reason: string };

/**
 * Who sends this message.
 *
 * **Staff first, and unmarked users are staff** — `userKindOf` already treats
 * absence as staff, and that is the safe direction here too: a staff member
 * whose mail was misrouted to a merchant domain would be a cross-tenant leak of
 * an auth token, while a shopper misrouted to Markii's stream is only unbranded.
 */
export async function routeFor(payload: HookPayload): Promise<Recipient> {
  const kind = (payload.user.app_metadata as Record<string, unknown> | null)?.user_kind;
  if (kind !== "customer") return { stream: "platform", reason: "staff" };

  const rawSite = (payload.user.app_metadata as Record<string, unknown> | null)?.site_id;
  const siteId = typeof rawSite === "number" ? rawSite : null;
  if (!siteId) {
    /**
     * A shopper created before `site_id` was stamped. There is no honest way to
     * guess the merchant — one address can be a customer of several stores — and
     * guessing wrong sends an auth token from the wrong merchant's domain.
     */
    return { stream: "refuse", reason: "shopper has no site_id in app_metadata" };
  }

  const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
  if (!site) return { stream: "refuse", reason: `site ${siteId} no longer exists` };

  return {
    stream: "merchant",
    orgId: site.orgId,
    siteId: site.id,
    // Carried for the fallback sender: `accounts@{slug}.{ROOT_DOMAIN}` when the
    // merchant has not verified a domain of their own.
    slug: site.slug,
    storeName: site.name,
  };
}
