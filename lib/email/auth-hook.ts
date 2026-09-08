import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, sites } from "../db";
import { verifySiteRef } from "../auth/site-ref";
import {
  confirmSignupEmail,
  type AuthMailContext,
  emailChangeEmail,
  emailChangeCurrentEmail,
  emailChangeNewEmail,
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
    /**
     * The address an email change is moving *to*, present only during one.
     *
     * Optional because it is absent from every other action, and because a
     * build that stopped receiving it must degrade rather than throw — the
     * recipient logic below falls back to the current address and the copy
     * falls back to not naming a destination.
     */
    new_email?: string | null;
    app_metadata?: Record<string, unknown> | null;
    /** User-writable. Only ever read through a signature check. */
    user_metadata?: Record<string, unknown> | null;
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

/**
 * Which address this particular message goes to.
 *
 * **Not always `user.email`, and that was a real defect.** With Supabase's
 * *Secure email change* enabled, one change produces two messages:
 * `email_change_current` to the address on the account, and `email_change_new`
 * to the address it is moving to. Both were being sent to the current address.
 *
 * That is not a cosmetic misdelivery. The second message exists to prove the
 * new address is reachable by whoever asked; delivering its token to the old
 * address means the change can complete for an address nobody has demonstrated
 * control of — a typo, or someone else's inbox — which is precisely the
 * guarantee the two-email flow is there to provide.
 *
 * `email_change` (the single-message flow, when secure change is off) stays on
 * the current address: Supabase sends only one, and the account holder is who
 * it is for.
 */
export function recipientOf(payload: HookPayload): string {
  if (actionOf(payload) === "email_change_new") {
    // Falls back rather than throwing: a missing `new_email` should still
    // deliver *something* to a real address, not 500 the whole hook.
    return payload.user.new_email || payload.user.email;
  }
  return payload.user.email;
}

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
  { id: string; render: (ctx: AuthMailContext) => RenderedEmail } | null
> = {
  signup: { id: "auth_confirm_signup", render: confirmSignupEmail },
  invite: { id: "auth_confirm_signup", render: confirmSignupEmail },
  recovery: { id: "auth_reset_password", render: resetPasswordEmail },
  magiclink: { id: "auth_magic_link", render: magicLinkEmail },
  email_change: { id: "auth_email_change", render: emailChangeEmail },
  /**
   * The two halves of a secure email change say different things, because they
   * are read by people in different situations. The message to the **current**
   * address is the one that stops an account takeover, so it names the
   * destination and leads with "did you ask for this"; the one to the **new**
   * address is an ordinary confirmation. Rendering one template for both left
   * the security-critical mail unable to tell its reader what would change.
   */
  email_change_current: { id: "auth_email_change_current", render: emailChangeCurrentEmail },
  email_change_new: { id: "auth_email_change_new", render: emailChangeNewEmail },
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
  const app = payload.user.app_metadata as Record<string, unknown> | null;

  /**
   * `app_metadata` is authoritative and is checked first — service-role only,
   * so it cannot be influenced by the account holder.
   */
  const stamped = app?.user_kind === "customer" && typeof app?.site_id === "number"
    ? (app.site_id as number)
    : null;

  /**
   * The signup-confirmation case, and the reason `site-ref.ts` exists. Supabase
   * fires this hook *inside* `auth.signUp()`, before the route can stamp
   * `app_metadata` — so a brand-new shopper arrives here looking exactly like an
   * unmarked user, which routes to staff. Without this, every shopper's *first*
   * email would come from Markii rather than their merchant. Confirmed live.
   *
   * The ref lives in user-writable `user_metadata`, so it is trusted only
   * because it is **HMAC-verified**; a forged one resolves to null and falls
   * through to the staff branch exactly as an absent one does.
   */
  const signed =
    stamped === null
      ? verifySiteRef((payload.user.user_metadata as Record<string, unknown> | null)?.site_ref)
      : null;

  const siteId = stamped ?? signed;
  if (siteId === null) {
    // Unmarked and unsigned: staff, or a shopper predating both. Staff is the
    // safe direction — see the note on this function.
    return { stream: "platform", reason: "staff" };
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
