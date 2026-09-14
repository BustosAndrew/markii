import { createHash } from "node:crypto";
import { ApiError } from "@/lib/api";
import { requestContextFrom } from "@/lib/auth/request-context";
import { rateLimitHeaders, type RateLimitDecision, type RateLimitPolicy } from "@/lib/rate-limit";
import { consumeRateLimit } from "@/lib/rate-limit-store";

/**
 * Rate limits on the unauthenticated auth routes (G12).
 *
 * These are the routes anyone can hit with no credential, and each is worth
 * something to an abuser: sign-up mints a free month per address (D45 takes no
 * card, so the address is the only cost), sign-in is where a leaked password
 * list is tried, and a password reset sends mail on Markii's own reputation.
 *
 * **Two dimensions per route, checked together.** A per-address limit stops one
 * machine; a per-subject limit — the email being tried, or the domain being
 * signed up under — stops the same attempt spread across many. Either alone
 * leaves the other shape open, and both are cheap: one upsert each.
 *
 * **Supabase's own limits do not cover this.** Every auth call here is made
 * server-side (D30), so what Supabase sees is Vercel's address, shared by every
 * merchant and shopper on the platform. Its per-IP limit would therefore be
 * spent by an attacker on *everyone's* behalf — a credential-stuffing run would
 * lock the whole platform out of sign-in — which is why the counting has to
 * happen here, where the caller's own address is still known.
 *
 * **Fails open, like the MCP limiter**, and for the same reason: this is an
 * abuse control, and the things standing between an attacker and an account —
 * the password, MFA, the confirmation mail — do not depend on it.
 */

export type AuthLimitScope = "signUp" | "signIn" | "passwordReset";

type ScopedPolicies = {
  /** Per client address. Skipped when no address is known (see `consumeAuthLimit`). */
  ip: RateLimitPolicy;
  /** Per subject — the email for sign-in and reset, the email *domain* for sign-up. */
  subject: RateLimitPolicy;
};

const HOUR = 60 * 60_000;
const QUARTER_HOUR = 15 * 60_000;

/** Reads an integer override, or the default. A non-number override is ignored, not obeyed. */
function fromEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

/**
 * The defaults are set where a person will not meet them and a script will.
 *
 * - **Sign-up per address: 10/hour.** A household or office behind one NAT
 *   creating ten merchant accounts in an hour is not a thing that happens.
 * - **Sign-up per email domain: 50/hour.** Coarse on purpose — this is the
 *   brake on `a1@throwaway.example` … `a999@throwaway.example`, and it has to
 *   sit above anything `gmail.com` could plausibly produce for a platform of
 *   this size. Raise it the day it is hit by real traffic; that is a good day.
 * - **Sign-in per address: 30 / 15 min; per email: 10 / 15 min.** Ten wrong
 *   passwords for one account in a quarter hour is a lockout on every serious
 *   platform. The address limit is looser because a shared office address
 *   carries many people's typos.
 * - **Reset per email: 3/hour; per address: 10/hour.** Each one is an email
 *   sent from `markii.shop`, and a reset form pointed at one address is a way
 *   to make Markii spam it.
 *
 * Overridable by env for an incident, never below one.
 */
export const AUTH_RATE_LIMITS: Record<AuthLimitScope, ScopedPolicies> = {
  signUp: {
    ip: { limit: fromEnv("AUTH_RATE_LIMIT_SIGNUP_IP", 10), windowMs: HOUR },
    subject: { limit: fromEnv("AUTH_RATE_LIMIT_SIGNUP_DOMAIN", 50), windowMs: HOUR },
  },
  signIn: {
    ip: { limit: fromEnv("AUTH_RATE_LIMIT_SIGNIN_IP", 30), windowMs: QUARTER_HOUR },
    subject: { limit: fromEnv("AUTH_RATE_LIMIT_SIGNIN_EMAIL", 10), windowMs: QUARTER_HOUR },
  },
  passwordReset: {
    ip: { limit: fromEnv("AUTH_RATE_LIMIT_RESET_IP", 10), windowMs: HOUR },
    subject: { limit: fromEnv("AUTH_RATE_LIMIT_RESET_EMAIL", 3), windowMs: HOUR },
  },
};

/**
 * The counter key for a subject.
 *
 * **Hashed, because `rate_limit_counters` must not become a list of every
 * email address anyone has ever typed into a sign-in form.** The table's own
 * rule is that keys hold ids, never secrets; an email is not a secret but it
 * is personal data, and a table nothing prunes is the wrong place to keep it.
 * A truncated SHA-256 is plenty — collisions would merely make two strangers
 * share a generous allowance, and nothing authorizes on the key.
 *
 * Sign-up is keyed on the **domain**, which is the thing a disposable-address
 * service has in common across a thousand sign-ups. Lowercased and trimmed
 * first, or `Me@Example.com` and `me@example.com` would count separately.
 *
 * Returns null when the input does not look like an address at all — a body
 * with no `email`, or garbage in it — so the address dimension still counts
 * and the subject one is simply not applicable, rather than every malformed
 * request sharing one `"invalid"` bucket.
 */
export function subjectKeyFor(scope: AuthLimitScope, email: unknown): string | null {
  if (typeof email !== "string") return null;
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at === normalized.length - 1) return null;
  const subject = scope === "signUp" ? normalized.slice(at + 1) : normalized;
  const digest = createHash("sha256").update(subject).digest("hex").slice(0, 32);
  return `auth:${scope}:subject:${digest}`;
}

export function ipKeyFor(scope: AuthLimitScope, ip: string): string {
  return `auth:${scope}:ip:${ip}`;
}

export type AuthLimitRefusal = {
  allowed: false;
  dimension: "ip" | "subject";
  decision: RateLimitDecision;
  policy: RateLimitPolicy;
};

export type AuthLimitResult = { allowed: true } | AuthLimitRefusal;

/**
 * Count this attempt on both dimensions and say whether it may proceed.
 *
 * **Counted before validation, on purpose.** A script spraying malformed
 * bodies is still a script spraying; if only well-formed attempts counted,
 * the limiter would be sidestepped by getting the password rules wrong. Callers
 * therefore invoke this as soon as they have read the body and before parsing
 * it.
 *
 * **No address, no address limit.** `requestContextFrom` returns null off a
 * trusted proxy, and the alternative — pooling every addressless caller into
 * one bucket — would rate-limit the whole world together the moment the
 * header went missing. Behind Vercel the header is always present, so in
 * production both dimensions always apply; the null case is a bare origin,
 * where the subject limit still holds.
 */
export async function consumeAuthLimit(
  scope: AuthLimitScope,
  req: Request,
  email: unknown,
): Promise<AuthLimitResult> {
  const policies = AUTH_RATE_LIMITS[scope];
  const { ip } = requestContextFrom(req);

  if (ip) {
    const decision = await consumeRateLimit(ipKeyFor(scope, ip), policies.ip);
    if (!decision.allowed) return { allowed: false, dimension: "ip", decision, policy: policies.ip };
  }

  const subjectKey = subjectKeyFor(scope, email);
  if (subjectKey) {
    const decision = await consumeRateLimit(subjectKey, policies.subject);
    if (!decision.allowed) {
      return { allowed: false, dimension: "subject", decision, policy: policies.subject };
    }
  }

  return { allowed: true };
}

/** "Try again in 3 minutes" — whole minutes, never "in 0 minutes". */
export function retryCopy(decision: RateLimitDecision): string {
  const minutes = Math.max(1, Math.ceil(decision.retryAfterSeconds / 60));
  return `Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

/**
 * The refusal as an `ApiError`, carrying `Retry-After`.
 *
 * **One message for both dimensions.** Saying "too many attempts for this
 * account" would confirm the account exists — the limiter counts submitted
 * addresses whether or not they are registered, but a shopper reading the copy
 * cannot know that. The 429 itself is the signal a client needs.
 */
export function rateLimited(refusal: AuthLimitRefusal): ApiError {
  return new ApiError(
    "RATE_LIMITED",
    429,
    `Too many attempts. ${retryCopy(refusal.decision)}`,
    { retryAfterSeconds: refusal.decision.retryAfterSeconds },
    rateLimitHeaders(refusal.decision, refusal.policy),
  );
}

/**
 * The JSON body as an object, or an empty one — never a throw.
 *
 * The routes used to call `req.json()` straight into zod, which meant a body
 * that was not JSON at all surfaced as a 500 before any counting could happen.
 * Read leniently here so the attempt is counted first and the malformed body
 * is then refused by the schema as a 400, the same as any other bad input.
 */
export async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  const raw = await req.text();
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Convenience for the JSON routes: consume, and throw the 429 if refused. */
export async function enforceAuthLimit(
  scope: AuthLimitScope,
  req: Request,
  email: unknown,
): Promise<void> {
  const result = await consumeAuthLimit(scope, req, email);
  if (!result.allowed) throw rateLimited(result);
}
