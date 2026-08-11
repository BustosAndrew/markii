import { createHmac } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "./helpers";
import { BASE_URL } from "./setup";

/**
 * Webhook mode agreement (§17).
 *
 * **The failure this guards against is silent by construction.** Stripe issues a
 * signing secret per endpoint, endpoints are per-mode, and every secret is a
 * `whsec_…` in both — so a live-mode secret configured against a test-mode key
 * cannot be detected at startup. `lib/stripe-mode.ts` compares `sk_`/`pk_`
 * prefixes and is structurally blind to it. The symptom is that every event
 * 400s, nothing is written to `stripe_webhook_events` (an unverified payload is
 * not evidence of anything), and subscriptions quietly stop mirroring while the
 * app looks healthy.
 *
 * These drive the real route with real HMACs. Every event type used here has
 * **no handler**, so nothing downstream can be touched — the subject is the
 * verify-and-route decision, not any handler.
 */

const SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";
const KEY = process.env.STRIPE_SECRET_KEY ?? "";
const KEY_IS_LIVE = !KEY.startsWith("sk_test") && !KEY.startsWith("rk_test");

function post(body: string, secret: string | null) {
  const timestamp = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret) {
    const v1 = createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
    headers["stripe-signature"] = `t=${timestamp},v1=${v1}`;
  }
  return fetch(`${BASE_URL}/api/webhooks/stripe`, { method: "POST", body, headers }).then(
    async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }),
  );
}

/** An event type nothing subscribes to, so routing is all that is exercised. */
function event(id: string, livemode: boolean) {
  return JSON.stringify({
    id,
    type: "reporting.report_run.succeeded",
    created: Math.floor(Date.now() / 1000),
    livemode,
    data: { object: { id: "rr_test" } },
  });
}

const ids: string[] = [];
const newId = () => {
  const id = `evt_modetest_${Date.now()}_${Math.floor(Math.random() * 10_000)}`;
  ids.push(id);
  return id;
};

describe.skipIf(!SECRET)("stripe webhook mode agreement", () => {
  afterAll(async () => {
    for (const id of ids) {
      await sql`delete from stripe_webhook_events where id = ${id}`;
    }
  });

  it("rejects an unsigned request without recording anything", async () => {
    const id = newId();
    const res = await post(event(id, !KEY_IS_LIVE), null);

    expect(res.status).toBe(400);
    // An unverified payload must leave no trace — otherwise anyone who finds
    // the URL can fill this table.
    const rows = await sql`select id from stripe_webhook_events where id = ${id}`;
    expect(rows).toHaveLength(0);
  });

  it("rejects a wrongly-signed request without recording anything", async () => {
    const id = newId();
    const res = await post(event(id, !KEY_IS_LIVE), "whsec_not_the_configured_secret_000000");

    expect(res.status).toBe(400);
    const rows = await sql`select id from stripe_webhook_events where id = ${id}`;
    expect(rows).toHaveLength(0);
  });

  /**
   * A correctly-signed event whose mode disagrees with `STRIPE_SECRET_KEY`.
   * Verified, so `livemode` is Stripe's claim rather than the payload's — and
   * acting on it would resolve ids against the other mode's data.
   */
  it("ignores a verified event from the wrong mode, and records why", async () => {
    const id = newId();
    const res = await post(event(id, !KEY_IS_LIVE), SECRET);

    // 200, not an error: retrying for three days cannot fix a mode mismatch.
    expect(res.status).toBe(200);
    expect(res.json.handled).toBe(false);
    expect(res.json.reason).toMatch(/mode mismatch/i);

    const [row] = await sql`select status, detail from stripe_webhook_events where id = ${id}`;
    expect(row.status).toBe("ignored");
    // `ignored` must always carry a reason — this table exists to answer what
    // Stripe sent and what was done about it.
    expect(row.detail).toMatch(/mode mismatch/i);
  });

  it("accepts a verified event whose mode agrees, and routes it normally", async () => {
    const id = newId();
    const res = await post(event(id, KEY_IS_LIVE), SECRET);

    expect(res.status).toBe(200);
    const [row] = await sql`select status, detail from stripe_webhook_events where id = ${id}`;
    // Reaches handler routing rather than being turned away at the mode gate.
    expect(row.status).toBe("ignored");
    expect(row.detail).toMatch(/no handler|unrecognised/i);
    expect(row.detail).not.toMatch(/mode mismatch/i);
  });
});
