/**
 * Sign-up review (G12) — the pure half.
 *
 * The auth rate limits refuse a sign-up burst; what they cannot do is tell a
 * person that one happened. `rate_limit_counters` holds hashed subjects on
 * purpose, so nothing can be read back out of it. This reads the thing that
 * *is* recorded — every org's `billingEmail` at creation — and groups the last
 * day's sign-ups by email domain, so "this domain signed up 40 times today"
 * reaches an inbox rather than staying a number nobody looks at.
 *
 * **Surfaces, never enforces.** Deciding a burst is abuse is a judgement about
 * a specific merchant that this code has no business making — a co-working
 * space, an agency onboarding clients, or a university all look like one.
 * Anything automatic here would be the rate limit again, just later.
 *
 * Kept free of the database and the mail transport so the grouping and the
 * threshold are unit-testable; `signup-review-sweep.ts` does the I/O.
 */

export type SignupRow = {
  slug: string;
  name: string;
  billingEmail: string;
  createdAt: Date;
};

export type SignupBurst = {
  domain: string;
  count: number;
  /** Oldest first, so the shape of the burst is readable. */
  orgs: { slug: string; name: string; email: string; createdAt: Date }[];
};

/**
 * The domain part of an address, case-folded. Null for anything that is not
 * shaped like one — it cannot happen for a row provisioning wrote, but a
 * digest should skip a malformed row rather than group everything odd under
 * one heading.
 */
export function domainOf(email: string): string | null {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at === normalized.length - 1) return null;
  return normalized.slice(at + 1);
}

/** Reads an integer override, or the default. A non-number is ignored, not obeyed. */
function fromEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

/**
 * How many sign-ups from one domain in a day earn a line in the digest.
 *
 * Low on purpose, and for the same reason the sign-up limit's domain dimension
 * is coarse: at this platform's size five accounts a day from one host is
 * unusual whether the host is a disposable-mail service or `gmail.com`, and
 * the digest costs one email to read. The day a consumer domain crosses it
 * on real traffic is the day to raise it — that is a good day.
 */
export const SIGNUP_REVIEW_THRESHOLD = fromEnv("SIGNUP_REVIEW_THRESHOLD", 5);

/** The look-back. One day, matching the cron that sends it. */
export const SIGNUP_REVIEW_WINDOW_MS = 24 * 60 * 60_000;

/**
 * Group sign-ups by domain and keep the domains at or over the threshold,
 * largest first. A domain below the threshold is absent, not reported as
 * "fine" — the digest is the exceptions and nothing else.
 *
 * `exclude` is for the platform's own domain: an address at `markii.shop` can
 * only be verified by Markii, so a burst there is staff, seeds or the
 * integration suite, never a stranger to review — and without the exclusion
 * every test run would page the support inbox about its own fixtures.
 */
export function signupBursts(
  rows: SignupRow[],
  threshold = SIGNUP_REVIEW_THRESHOLD,
  exclude: readonly string[] = [],
): SignupBurst[] {
  const excluded = new Set(exclude.map((d) => d.trim().toLowerCase()).filter(Boolean));
  const byDomain = new Map<string, SignupBurst>();
  for (const row of rows) {
    const domain = domainOf(row.billingEmail);
    if (!domain || excluded.has(domain)) continue;
    let burst = byDomain.get(domain);
    if (!burst) {
      burst = { domain, count: 0, orgs: [] };
      byDomain.set(domain, burst);
    }
    burst.count += 1;
    burst.orgs.push({
      slug: row.slug,
      name: row.name,
      email: row.billingEmail.trim().toLowerCase(),
      createdAt: row.createdAt,
    });
  }

  const bursts = [...byDomain.values()].filter((b) => b.count >= threshold);
  for (const b of bursts) b.orgs.sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime());
  return bursts.sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
}
