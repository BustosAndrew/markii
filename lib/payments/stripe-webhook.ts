import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stripe webhook signature verification (§17).
 *
 * **The signature is the only authentication this endpoint has.** The URL is
 * public and the payload is attacker-controllable text; without verification,
 * anyone who found the path could post an `invoice.paid` and mark a merchant's
 * subscription current, or an `account.updated` and change what a store is
 * allowed to do. Verified events are the *only* ones that may touch state.
 *
 * Hand-rolled over `node:crypto` rather than pulling in the Stripe SDK, matching
 * `lib/email/sigv4.ts` and `lib/email/sns.ts`. The scheme is small and stable:
 * HMAC-SHA256 over `${timestamp}.${rawBody}`, keyed with the endpoint secret.
 * When the SDK arrives for creating charges, `stripe.webhooks.constructEvent`
 * may replace this — it does the same three checks.
 *
 * Three checks, and each one matters:
 *
 * 1. **Signed payload must be the raw body.** `JSON.parse` then re-stringify
 *    changes key order and whitespace, and the HMAC no longer matches. The route
 *    reads `req.text()` once and passes that exact string.
 * 2. **Constant-time comparison.** A `===` on the digest leaks it a byte at a
 *    time to anyone who can measure the response.
 * 3. **Timestamp tolerance.** Without it a valid signature is valid forever, and
 *    a captured `charge.refunded` can be replayed at will.
 */

/** Stripe's own default, and the value its docs assume. */
const DEFAULT_TOLERANCE_SECONDS = 300;

export type StripeSignatureResult =
  | { ok: true; timestamp: number }
  | { ok: false; reason: string };

/**
 * Parses a `Stripe-Signature` header: `t=1786000000,v1=abc…,v1=def…`.
 *
 * **Multiple `v1` values are normal, not suspicious** — during a secret roll
 * Stripe signs with both, and treating the header as a single signature breaks
 * every event for the length of the rollover.
 */
function parseHeader(header: string): { timestamp: number | null; signatures: string[] } {
  let timestamp: number | null = null;
  const signatures: string[] = [];

  for (const part of header.split(",")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === "t") {
      const n = Number(value);
      if (Number.isFinite(n)) timestamp = n;
    } else if (key === "v1") {
      signatures.push(value);
    }
  }
  return { timestamp, signatures };
}

/** Length-safe hex comparison. Mismatched lengths short-circuit before the HMAC. */
function matches(expected: string, candidate: string): boolean {
  if (candidate.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(candidate, "hex"));
  } catch {
    // Non-hex candidate — Buffer.from truncates silently, so the byte lengths
    // can still differ after the string-length check above.
    return false;
  }
}

export function verifyStripeSignature(input: {
  /** The **raw** request body, exactly as received. */
  payload: string;
  /** The `Stripe-Signature` header. */
  header: string | null;
  /** The endpoint's signing secret (`whsec_…`). */
  secret: string;
  toleranceSeconds?: number;
  /** Injectable for tests; seconds since epoch. */
  nowSeconds?: number;
}): StripeSignatureResult {
  if (!input.header) return { ok: false, reason: "missing Stripe-Signature header" };
  if (!input.secret) return { ok: false, reason: "no signing secret configured" };

  const { timestamp, signatures } = parseHeader(input.header);
  if (timestamp == null) return { ok: false, reason: "signature header has no timestamp" };
  if (signatures.length === 0) return { ok: false, reason: "signature header has no v1 signature" };

  const expected = createHmac("sha256", input.secret)
    .update(`${timestamp}.${input.payload}`, "utf8")
    .digest("hex");

  if (!signatures.some((candidate) => matches(expected, candidate))) {
    return { ok: false, reason: "signature does not match" };
  }

  /**
   * Checked **after** the HMAC, deliberately: an attacker should not be able to
   * distinguish "wrong secret" from "stale timestamp" by response alone.
   */
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > tolerance) {
    return { ok: false, reason: "timestamp outside tolerance" };
  }

  return { ok: true, timestamp };
}

/**
 * The subset of a Stripe event this codebase reads. Not a full type — the SDK's
 * `Stripe.Event` covers hundreds of shapes, and inventing a partial copy of it
 * here would rot the moment Stripe adds a field.
 */
export type StripeEventEnvelope = {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  /**
   * Present only on Connect events, naming the connected account they concern.
   * **Its absence means the event is the platform's own**, which is the
   * distinction the whole routing decision rests on (`docs/BACKEND.md`).
   */
  account?: string;
  data: { object: Record<string, unknown> };
  request?: { id: string | null; idempotency_key: string | null };
};

export function parseStripeEvent(payload: string): StripeEventEnvelope | null {
  try {
    const parsed = JSON.parse(payload) as StripeEventEnvelope;
    if (typeof parsed?.id !== "string" || typeof parsed?.type !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}
