import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, signUpMerchant, sql } from "./helpers";

/**
 * The hosting-platform hop, against the **real Vercel project** (§2 step two).
 *
 * Gated separately from the rest of the suite, like `stripe-fee-invoice.test.ts`:
 * it attaches and detaches real domains on a live project, which is not
 * something `pnpm test:integration` should quietly start meaning.
 *
 * ```bash
 * # the dev server needs a REAL root domain — tenant hosts are skipped on localhost
 * ROOT_DOMAIN=markii.shop DEMO_SKIP_PAYMENT_VERIFICATION=1 pnpm dev
 *
 * MARKII_VERCEL_TESTS=1 pnpm exec cross-env MARKII_ALLOW_INTEGRATION_TESTS=1 \
 *   vitest run --project integration domain-platform
 * ```
 *
 * **What only this can show.** Every other test of this path runs with `fetch`
 * stubbed or `ROOT_DOMAIN=localhost`, where no platform call happens at all — so
 * they prove the decisions and not the wiring. The bug class here is an
 * orphaned external resource: a hostname left attached after the row naming it
 * is gone. That is invisible from the database, invisible from the API
 * response, and only a real project listing can catch it.
 *
 * Everything it creates is removed in `afterAll`, and the final assertion is
 * that the project is back exactly where it started.
 */
const ENABLED = process.env.MARKII_VERCEL_TESTS === "1";
const TOKEN = process.env.VERCEL_TOKEN;
const PROJECT = process.env.VERCEL_PROJECT_ID;
const TEAM = process.env.VERCEL_TEAM_ID || null;
const ROOT = process.env.ROOT_DOMAIN;

/** Reads the project's domains. The one source that can see an orphan. */
async function projectDomains(): Promise<string[]> {
  const q = TEAM ? `&teamId=${encodeURIComponent(TEAM)}` : "";
  const res = await fetch(
    `https://api.vercel.com/v9/projects/${PROJECT}/domains?limit=100${q}`,
    { headers: { authorization: `Bearer ${TOKEN}` } },
  );
  if (!res.ok) throw new Error(`could not list project domains: HTTP ${res.status}`);
  const body = (await res.json()) as { domains?: { name: string }[] };
  return (body.domains ?? []).map((d) => d.name).sort();
}

async function detach(host: string): Promise<void> {
  const q = TEAM ? `?teamId=${encodeURIComponent(TEAM)}` : "";
  await fetch(
    `https://api.vercel.com/v9/projects/${PROJECT}/domains/${encodeURIComponent(host)}${q}`,
    { method: "DELETE", headers: { authorization: `Bearer ${TOKEN}` } },
  ).catch(() => {});
}

const describeMaybe = ENABLED ? describe : describe.skip;

if (!ENABLED) {
  // Says so out loud rather than reporting a silent pass — a skipped proof that
  // looks like a green one is how an unverified hop gets believed.
  console.log(
    "\n  domain-platform: SKIPPED. Set MARKII_VERCEL_TESTS=1 (with VERCEL_TOKEN,\n" +
      "  VERCEL_PROJECT_ID and a real ROOT_DOMAIN) to exercise the live Vercel hop.\n",
  );
}

describeMaybe("custom domain — hosting platform lifecycle", () => {
  const merchant = new Client();
  const cleanup = new Cleanup();

  let baseline: string[] = [];
  let siteId: number;
  let slug: string;
  let renamedSlug: string;

  beforeAll(async () => {
    if (!TOKEN || !PROJECT) throw new Error("VERCEL_TOKEN and VERCEL_PROJECT_ID are required.");
    if (!ROOT || ROOT === "localhost" || ROOT.endsWith(".localhost")) {
      throw new Error(
        `ROOT_DOMAIN is "${ROOT}". The dev server must run with a real root domain, or tenant ` +
          "hosts are skipped entirely and this suite would pass without testing anything.",
      );
    }

    baseline = await projectDomains();

    const { email } = await signUpMerchant(merchant, "vercelhop");
    cleanup.merchantEmails.push(email);

    const stamp = `${Date.now()}`;
    slug = `zz-platform-${stamp}`;
    renamedSlug = `zz-renamed-${stamp}`;

    const created = await merchant.post("/api/sites", { name: `Platform Test ${stamp}`, slug });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    siteId = created.json.id;
    cleanup.siteIds.push(siteId);
  }, 180_000);

  afterAll(async () => {
    // Belt and braces: the test asserts the app detached these, but a failure
    // partway must not leave a hostname on a real project.
    if (ROOT) {
      await detach(`${slug}.${ROOT}`);
      await detach(`${renamedSlug}.${ROOT}`);
    }
    await cleanup.run();
  }, 120_000);

  it("attaches the storefront's own hostname when it goes live", async () => {
    const before = await projectDomains();
    expect(before, "a draft must not be attached — it would spend a domain slot").not.toContain(
      `${slug}.${ROOT}`,
    );

    const deployed = await merchant.post(`/api/sites/${siteId}/deploy`);
    expect(deployed.status).toBe(200);
    expect(deployed.json.status).toBe("live");
    /**
     * Reported rather than assumed. A `storefrontUrl` returned alongside
     * `hostAttached: false` would be a link that fails TLS.
     */
    expect(deployed.json.hostAttached, deployed.json.hostProblem ?? "").toBe(true);

    expect(await projectDomains()).toContain(`${slug}.${ROOT}`);
  }, 120_000);

  it("moves the hostname when the slug changes, leaving no orphan", async () => {
    /**
     * The leak this proves closed. A slug **is** the address, so renaming moves
     * the host — and before the fix nothing released the old one, because the
     * row no longer named it. It would have stayed on the project forever.
     */
    const patched = await merchant.patch(`/api/sites/${siteId}`, { slug: renamedSlug });
    expect(patched.status, JSON.stringify(patched.json)).toBe(200);

    const after = await projectDomains();
    expect(after, "the new address must be attached").toContain(`${renamedSlug}.${ROOT}`);
    expect(after, "the old address must not be orphaned").not.toContain(`${slug}.${ROOT}`);
  }, 120_000);

  it("releases the hostname when the storefront is deleted", async () => {
    const deleted = await merchant.del(`/api/sites/${siteId}`);
    expect(deleted.status).toBe(200);

    const after = await projectDomains();
    expect(after).not.toContain(`${renamedSlug}.${ROOT}`);

    // The row is gone from the database too, so nothing could have released it
    // later — this is the only moment it could have happened.
    const rows = await sql`select id from sites where id = ${siteId}`;
    expect(rows.length).toBe(0);
  }, 120_000);

  it("leaves the project exactly as it found it", async () => {
    // The assertion that actually catches an orphan: not "the ones I know about
    // are gone", but "nothing was added that I did not remove".
    expect(await projectDomains()).toEqual(baseline);
  }, 120_000);
});
