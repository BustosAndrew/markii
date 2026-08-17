import { invokeAction } from "./actions";
import { apiGet } from "./client";
import { callWhenLive } from "./planned";

const EMAIL_SECTION = "API §24";

/**
 * ✅ LIVE — `GET /api/settings/email` and the five `email.*` actions are routed.
 *
 * **Live does not mean mail is sent.** This deployment has no AWS credentials,
 * so every send is recorded as `not_configured`. That is a fact the response
 * carries (`providerConfigured`, `customerEmail.code`) rather than something a
 * screen should infer, and it is why the flag here is `true`: the endpoint
 * answers truthfully, and gating it to `false` would replace a real answer with
 * a "coming soon" that is less accurate.
 */
const EMAIL_API_LIVE = true;

/**
 * Whether customer mail goes out, and from whose address.
 *
 * - `ready` — sending from the merchant's own verified domain.
 * - `unverified_sender` — **still sending** (`canSend: true`), but from the
 *   storefront's `{slug}.markii.shop` address, because the merchant has not
 *   verified a domain of their own (D44).
 * - `configuration_required` — Markii's problem: no AWS credentials on this
 *   deployment. Nothing the merchant does will help.
 *
 * **`unverified_sender` replaced `domain_verification_required`, and it is not a
 * rename.** The old code meant mail was *refused*; mail now sends from a
 * fallback address, so `canSend` is true where it used to be false. A screen
 * still treating that state as "not sending" would tell a merchant their
 * receipts are broken while their customers receive them.
 *
 * `senderAddress` is null for `unverified_sender`: the address is per storefront,
 * so an org with several stores has several.
 */
export type CustomerEmailStatus = {
  canSend: boolean;
  code: "ready" | "configuration_required" | "unverified_sender";
  message: string;
  senderAddress: string | null;
};

export type SendingDomain = {
  id: number;
  domain: string;
  senderAddress: string;
  fromName: string | null;
  replyTo: string | null;
  status: "pending" | "verified" | "failed" | "temporary_failure";
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  problem: string | null;
  /** The CNAMEs to publish. Derived from SES's current tokens, never a stored copy. */
  dns: { type: "CNAME"; name: string; value: string }[];
};

export type Suppression = {
  email: string;
  reason: "bounce" | "complaint" | "manual";
  detail: string | null;
  createdAt: string;
  /**
   * False for complaints. That consent was withdrawn by the recipient, and
   * `email.unsuppressAddress` refuses — so no screen should offer the button.
   */
  removable: boolean;
};

export type EmailSettings = {
  customerEmail: CustomerEmailStatus;
  domains: SendingDomain[];
  suppressions: Suppression[];
  /**
   * Markii's own mail to the merchant — sign-in, invoices, notices. Reported
   * separately and **never merged** into one "email: OK": a merchant whose
   * password reset arrived would otherwise conclude their order confirmations
   * work, and they do not.
   */
  platformEmail: { status: "ready" | "configuration_required"; scope: string };
  /** When false, nothing above can work regardless of what the merchant does. */
  providerConfigured: boolean;
  /**
   * Health of the **shared** fallback sender — `{slug}.markii.shop` (D44).
   *
   * Only relevant while this merchant has no verified domain of their own, but
   * when it breaks it breaks for *every* such merchant simultaneously, and none
   * of them can fix it. `ok: false` here is a Markii incident, not a merchant
   * task — word it that way, and do not put a "verify your domain" call to
   * action next to it.
   */
  fallbackSender: {
    ok: boolean;
    domain: string | null;
    verifiedForSending: boolean | null;
    dkimStatus: string | null;
    problem: string | null;
  };
};

export function getEmailSettings(init?: RequestInit) {
  return callWhenLive(EMAIL_API_LIVE, EMAIL_SECTION, () =>
    apiGet<EmailSettings>("/api/settings/email", undefined, init),
  );
}

/**
 * Register a sending domain with SES and get back the DKIM CNAMEs to publish.
 *
 * Refuses rather than writing a row with no tokens — a merchant cannot act on a
 * verification step that has no records to publish. A **dry run does not contact
 * AWS**: creating an SES identity is a durable side effect no rollback withdraws.
 *
 * Every `email.*` schema is `.strict()`, so an unrecognised field is a validation
 * error rather than a silently ignored one.
 */
export function addSendingDomain(
  body: {
    domain: string;
    /** Mailbox part only — the full sender is `${fromLocalPart}@${domain}`. */
    fromLocalPart?: string;
    fromName?: string | null;
    replyTo?: string | null;
  },
  init?: RequestInit,
) {
  return invokeAction<{
    identityId: number;
    domain: string;
    senderAddress: string;
    status: SendingDomain["status"];
    dns: SendingDomain["dns"];
    note: string;
  }>("email.addSendingDomain", body, init);
}

/**
 * Re-read verification status from SES. **Pull, not push** — nothing in this
 * deployment schedules jobs, so the merchant's "check again" is what advances it.
 *
 * `checked: false` with a `problem` means AWS was unreachable, which is reported
 * rather than thrown and never downgrades an already-verified domain.
 */
export function verifySendingDomain(body: { identityId: number }, init?: RequestInit) {
  return invokeAction<{
    identityId: number;
    domain?: string;
    status: SendingDomain["status"];
    checked: boolean;
    verifiedAt?: string | null;
    problem?: string | null;
    canSend?: boolean;
  }>("email.verifySendingDomain", body, init);
}

/**
 * High risk, and the reason is not obvious from the button: removing the domain
 * silently stops every customer email. Nothing errors — customers simply stop
 * hearing from the store, which is why `sendingStopped` comes back and should be
 * confirmed before the call, not explained after it.
 */
export function removeSendingDomain(body: { identityId: number }, init?: RequestInit) {
  return invokeAction<{
    identityId: number;
    domain: string;
    removed: true;
    sendingStopped: boolean;
  }>("email.removeSendingDomain", body, init);
}

export function suppressAddress(
  body: { email: string; note?: string },
  init?: RequestInit,
) {
  return invokeAction<{ email: string; suppressed: boolean; reason?: "manual" }>(
    "email.suppressAddress",
    body,
    init,
  );
}

/**
 * Refuses with `409` for a `complaint` — that consent was withdrawn by the
 * recipient, and re-enabling it from a dashboard button would put an AWS policy
 * violation one click away. Use `Suppression.removable` to not offer it at all.
 */
export function unsuppressAddress(body: { email: string }, init?: RequestInit) {
  return invokeAction<{ email: string; removed: boolean }>(
    "email.unsuppressAddress",
    body,
    init,
  );
}
