import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sweepSignupReview } from "@/lib/auth/signup-review-sweep";
import { SIGNUP_REVIEW_THRESHOLD } from "@/lib/auth/signup-review";
import { isResendConfigured } from "@/lib/email";
import { sql } from "./helpers";
import { BASE_URL } from "./setup";

/**
 * The sign-up review digest (G12), against the real table and the real
 * transport.
 *
 * The burst is **inserted, not signed up**: five real sign-ups take minutes,
 * and every fixture this suite creates lives at the platform domain, which
 * the digest excludes on purpose (see `signupBursts`). A unique domain per
 * run keeps the assertion clean on a shared database.
 *
 * The sweep is called in-process with the recipient overridden to Resend's
 * delivered sink, so the run proves the mail leaves without a copy landing
 * in the support inbox. The cron route is then hit over HTTP to show the
 * digest rides the daily job and reports itself; whether *that* call sends is
 * a fact about the rest of the database at that moment, so it is not asserted.
 */
describe("sign-up review digest", () => {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const domain = `burst-${stamp}.example`;
  const ids: string[] = [];

  beforeAll(async () => {
    for (let i = 0; i < SIGNUP_REVIEW_THRESHOLD; i++) {
      const id = `org_srv_${stamp}_${i}`;
      ids.push(id);
      await sql`
        insert into organizations (id, name, slug, owner_id, billing_email, created_at)
        values (${id}, ${`Review ${i}`}, ${`review-${stamp}-${i}`}, ${`user_srv_${stamp}`},
                ${`a${i}@${domain}`}, now() - interval '1 hour')
      `;
    }
  });

  afterAll(async () => {
    await sql`delete from organizations where id in ${sql(ids)}`;
  });

  it("flags the domain and sends one digest naming it", async () => {
    const previous = process.env.SIGNUP_REVIEW_TO;
    process.env.SIGNUP_REVIEW_TO = "delivered@resend.dev";
    try {
      const result = await sweepSignupReview();
      expect(result.domains).toContain(domain);
      expect(result.flaggedSignups).toBeGreaterThanOrEqual(SIGNUP_REVIEW_THRESHOLD);
      expect(result.to).toBe("delivered@resend.dev");

      if (isResendConfigured()) {
        expect(result.sent).toBe(true);
        expect(result.reason).toBeNull();
      } else {
        // Refused and said why — never reported as sent.
        expect(result.sent).toBe(false);
        expect(result.reason).toBeTruthy();
      }
    } finally {
      if (previous === undefined) delete process.env.SIGNUP_REVIEW_TO;
      else process.env.SIGNUP_REVIEW_TO = previous;
    }
  }, 60_000);

  /**
   * Rows at the platform domain are the suite's own fixtures and are never
   * flagged — the property that keeps every test run from paging support.
   */
  it("never lists the platform's own domain", async () => {
    const root = process.env.ROOT_DOMAIN?.trim().toLowerCase();
    if (!root) return;
    const result = await sweepSignupReview();
    expect(result.domains).not.toContain(root);
  }, 60_000);

  it("rides the daily cron and reports itself in the response", async () => {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new Error("CRON_SECRET is not set in this test process.");

    // Remove the burst first so this HTTP run has nothing of ours to mail.
    await sql`delete from organizations where id in ${sql(ids)}`;

    const res = await fetch(`${BASE_URL}/api/cron/trial-reminders`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.signupReview).toBeDefined();
    expect(body.signupReview.error).toBeUndefined();
    expect(typeof body.signupReview.signups).toBe("number");
    expect(body.signupReview.domains).not.toContain(domain);
  }, 60_000);
});
