import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, createTestStore, signUpMerchant, sql } from "./helpers";

/**
 * Custom storefront domain verification (§2, migration 0031).
 *
 * The pure parts — normalisation, TXT matching, record derivation — are unit
 * tested in `lib/domains/records.test.ts`. What only a real request can show is
 * the wiring, and the wiring is where the hole was: `customDomain` was a field
 * on `PATCH /api/sites/:id` that any `cms.write` role could write straight into
 * the routing table, with nothing asking whether the org owned the hostname.
 *
 * Four properties are worth a round trip, and none is reachable from a unit test:
 *
 *   1. The field is **refused by name** on both site routes, and the row is
 *      unchanged afterwards — asserted against the database, not the response.
 *   2. A pending claim is **not exclusive**, so a squatter cannot park one on a
 *      hostname and lock its real owner out. A *verified* claim is exclusive,
 *      and that is enforced by a partial unique index rather than by a
 *      check-then-write that races.
 *   3. An unverified domain **never reaches `storefrontUrl`**, which feeds order
 *      email, `llms.txt`, and every JSON-LD `url`.
 *   4. A DNS check that finds nothing **does not move the status** — in either
 *      direction. A resolver blip must not un-verify a live storefront.
 *
 * Where a test needs a *verified* domain it writes the status directly, with a
 * note. Publishing a real TXT record from a test suite is not possible, and the
 * DNS read itself is covered by the unit tests plus the negative case below,
 * which does perform a real lookup.
 */
describe("custom domain verification", () => {
  const merchant = new Client();
  const rival = new Client();
  const cleanup = new Cleanup();

  let orgId: string;
  let rivalOrgId: string;
  let site: any;
  let rivalSite: any;
  /** Unregistered by construction, so a real lookup finds nothing. */
  let hostname: string;

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "domains");
    cleanup.merchantEmails.push(email);
    orgId = (await merchant.get("/api/me")).json.org.id;
    site = (await createTestStore(cleanup, "domains", { orgId })).site;

    const rivalAccount = await signUpMerchant(rival, "domrival");
    cleanup.merchantEmails.push(rivalAccount.email);
    rivalOrgId = (await rival.get("/api/me")).json.org.id;
    rivalSite = (await createTestStore(cleanup, "domrival", { orgId: rivalOrgId })).site;

    hostname = `shop-${Date.now()}${Math.floor(Math.random() * 1000)}.example.com`;
  }, 180_000);

  afterAll(async () => {
    await cleanup.run();
  });

  it("refuses customDomain by name on both site routes, and writes nothing", async () => {
    // Precondition. Without it a 4xx proves only that an unauthenticated caller
    // is turned away — see tests/README.md on why `refused()` is not enough.
    const me = await merchant.get("/api/me");
    expect(me.status, "merchant session must be live").toBe(200);
    expect(me.json.org.id).toBe(orgId);

    const patched = await merchant.patch(`/api/sites/${site.id}`, {
      customDomain: "seized.example.com",
    });
    expect(patched.status, "PATCH must refuse customDomain by name").toBe(400);
    expect(JSON.stringify(patched.json)).toMatch(/domains\.connect/);

    const created = await merchant.post("/api/sites", {
      name: `Domain Guard ${Date.now()}`,
      slug: `domain-guard-${Date.now()}`,
      customDomain: "seized.example.com",
    });
    expect(created.status, "POST must refuse customDomain by name").toBe(400);

    /**
     * Refused, not stripped. A caller who believes they connected a domain and
     * did not is worse off than one who got an error — and the database is
     * where that is settled, since the response could agree with itself.
     */
    const [after] = await sql`select custom_domain, domain_status from sites where id = ${site.id}`;
    expect(after.custom_domain).toBeNull();
    expect(after.domain_status).toBe("none");
    const [ghost] = await sql`select id from sites where custom_domain = 'seized.example.com'`;
    expect(ghost, "no site anywhere may hold the refused hostname").toBeUndefined();
  }, 60_000);

  it("connects a claim that is pending, tokened, and routes nothing", async () => {
    const res = await merchant.invoke("domains.connect", { siteId: site.id, domain: hostname });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.result.status).toBe("pending");

    const txt = res.json.result.records.find((r: any) => r.purpose === "ownership");
    expect(txt.type).toBe("TXT");
    expect(txt.name).toBe(`_markii-verify.${hostname}`);
    expect(txt.value).toMatch(/^markii-domain-verification=[0-9a-f]{32}$/);

    const [row] = await sql`
      select custom_domain, domain_status, domain_verification_token, domain_verified_at
      from sites where id = ${site.id}`;
    expect(row.custom_domain).toBe(hostname);
    expect(row.domain_status, "a claim is pending, never verified").toBe("pending");
    expect(row.domain_verification_token).toMatch(/^[0-9a-f]{32}$/);
    expect(row.domain_verified_at).toBeNull();

    /**
     * The resolver only ever selects `verified` rows, so a pending claim routes
     * nothing. Asserted at the same level the proxy reads it.
     */
    const routable = await sql`
      select id from sites where custom_domain = ${hostname} and domain_status = 'verified'`;
    expect(routable.length).toBe(0);
  }, 60_000);

  it("keeps an unverified domain out of storefrontUrl", async () => {
    /**
     * `storefrontUrl` feeds the dashboard, order confirmation emails, `llms.txt`
     * and every JSON-LD `url`. A hostname that routes nothing must not appear in
     * any of them — the Markii subdomain always answers, so it is the honest
     * fallback until the domain verifies.
     */
    const res = await merchant.get(`/api/sites/${site.id}`);
    expect(res.status).toBe(200);
    expect(res.json.customDomain, "the claim is still reported").toBe(hostname);
    expect(res.json.domainStatus).toBe("pending");
    expect(res.json.storefrontUrl).not.toContain(hostname);
    expect(res.json.storefrontUrl).toContain(site.slug);

    // The token is not on the site payload — it belongs to one screen.
    expect(res.json.domainVerificationToken).toBeUndefined();
  }, 60_000);

  it("reports ownership and pointing as separate facts", async () => {
    const res = await merchant.get(`/api/sites/${site.id}/domain`);
    expect(res.status).toBe(200);
    expect(res.json.domain).toBe(hostname);
    expect(res.json.status).toBe("pending");
    /**
     * Two facts, never one tick. `status` is what Markii gates routing on;
     * `pointsToMarkii` is whether the merchant's DNS actually delivers traffic.
     * A merchant who published one record and not the other needs to know which.
     */
    expect(res.json).toHaveProperty("pointsToMarkii");
    expect(res.json.pointsToMarkii).toBe(false);
    expect(res.json.records.some((r: any) => r.purpose === "pointing")).toBe(true);
    /**
     * Null while unverified, and that is the correct state rather than a
     * failure: Markii does not attach a hostname to its hosting project before
     * ownership is proved, so "not registered" here would be misread as broken.
     */
    expect(res.json.platform).toBeNull();
  }, 60_000);

  it("lists every storefront org-wide, without claiming a live reading", async () => {
    const res = await merchant.get("/api/settings/domains");
    expect(res.status).toBe(200);

    const mine = res.json.items.find((i: any) => i.siteId === site.id);
    expect(mine.domain).toBe(hostname);
    expect(mine.status).toBe("pending");

    /**
     * **Absent, not false.** The endpoint reads no DNS — a fan-out of one
     * resolver round trip per store would make this the slowest page in the
     * dashboard — so a `pointsToMarkii` here could only ever be stale, and a
     * stale "not pointing" sends a merchant off to break DNS that works.
     */
    expect(mine).not.toHaveProperty("pointsToMarkii");
    expect(res.json.dnsCheckedLive, "screens must not infer freshness").toBe(false);

    // A worklist: the row anyone has to act on comes first.
    expect(res.json.items[0].status).toBe("pending");
    expect(res.json.counts.pending).toBeGreaterThanOrEqual(1);

    // Org-scoped like everything else — another merchant's stores are not here.
    expect(res.json.items.some((i: any) => i.siteId === rivalSite.id)).toBe(false);
  }, 60_000);

  it("does not verify a domain whose record was never published, and says why", async () => {
    // A real DNS lookup against a hostname that does not exist.
    const res = await merchant.invoke("domains.verify", { siteId: site.id });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.result.verified).toBe(false);
    expect(res.json.result.status).toBe("pending");
    expect(res.json.result.problem, "the merchant must be told what is missing").toMatch(
      /_markii-verify/,
    );

    const [row] = await sql`
      select domain_status, domain_checked_at, domain_last_error from sites where id = ${site.id}`;
    expect(row.domain_status, "a failed check must not move the status").toBe("pending");
    expect(row.domain_checked_at, "but it must record that it looked").not.toBeNull();
    expect(row.domain_last_error).toBeTruthy();
  }, 60_000);

  it("lets a second org hold a pending claim on the same hostname", async () => {
    /**
     * **The anti-squatting property.** If pending claims were exclusive, anyone
     * could park one on a hostname and lock its real owner out of ever
     * connecting it. Neither claim routes, so nothing is at stake until one of
     * them proves ownership.
     */
    const res = await rival.invoke("domains.connect", { siteId: rivalSite.id, domain: hostname });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.result.status).toBe("pending");

    const holders = await sql`select id from sites where custom_domain = ${hostname}`;
    expect(holders.length, "both claims coexist").toBe(2);
  }, 60_000);

  it("refuses a connect once another storefront has verified the hostname", async () => {
    /**
     * Verified directly, because a test cannot publish a TXT record. This is
     * exactly the row state a successful `domains.verify` writes.
     */
    await sql`update sites set domain_status = 'verified', domain_verified_at = now()
              where id = ${site.id}`;

    const res = await rival.invoke("domains.connect", {
      siteId: rivalSite.id,
      domain: hostname,
    });
    expect(res.status, "a verified holder makes the hostname exclusive").toBe(409);
    // Deliberately does not name the holder: who else sells from a domain is not
    // this caller's business to learn.
    expect(JSON.stringify(res.json)).not.toContain(site.slug);
  }, 60_000);

  it("enforces exclusivity in the database, not only in the action", async () => {
    /**
     * The check-then-write in `connectDomain` can lose a race; the index cannot.
     * Two storefronts answering for one hostname is the failure this prevents,
     * so it is asserted against Postgres directly.
     */
    let violated = false;
    try {
      await sql`update sites set domain_status = 'verified', domain_verified_at = now()
                where id = ${rivalSite.id}`;
    } catch (e) {
      violated = String((e as { code?: string }).code) === "23505";
    }
    expect(violated, "a second verified row on one hostname must be impossible").toBe(true);

    const [rivalRow] = await sql`select domain_status from sites where id = ${rivalSite.id}`;
    expect(rivalRow.domain_status).toBe("pending");
  }, 60_000);

  it("never downgrades a verified domain on a failed DNS check", async () => {
    /**
     * The TXT record still does not exist. If a check that finds nothing could
     * un-verify, a resolver blip during routine polling would take a live
     * storefront offline — a far worse outcome than a stale `verified`.
     */
    const res = await merchant.invoke("domains.verify", { siteId: site.id });
    expect(res.status).toBe(200);
    expect(res.json.result.status).toBe("verified");

    const [row] = await sql`select domain_status from sites where id = ${site.id}`;
    expect(row.domain_status).toBe("verified");

    /**
     * Registration is a post-commit effect, so the only honest word here is
     * "attempted". Without platform credentials it must say so plainly rather
     * than claim the domain is serving — this deployment has none.
     */
    expect(["queued", "configuration_required"]).toContain(
      res.json.result.platformRegistration,
    );
  }, 60_000);

  it("never reports a verified domain as serving without platform credentials", async () => {
    /**
     * The trap this closes: ownership proved and DNS pointed, so two of three
     * ticks are green — and the storefront still answers nothing, because
     * Vercel drops a hostname that is not registered to the project. The
     * response must carry that third fact rather than let a screen infer
     * success from the absence of a problem.
     */
    const res = await merchant.get(`/api/sites/${site.id}/domain`);
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("verified");
    expect(res.json.platform, "a verified domain must report platform state").not.toBeNull();

    if (!res.json.platform.configured) {
      // Unknown, never false — and the message must not read as the merchant's
      // task, because a missing credential is not theirs to fix.
      expect(res.json.platform.registered).toBeNull();
      expect(res.json.platform.problem).toMatch(/Markii's to fix/);
    }
  }, 60_000);

  it("writes nothing on a dry run", async () => {
    const other = `dry-${Date.now()}.example.com`;
    const res = await rival.invoke(
      "domains.connect",
      { siteId: rivalSite.id, domain: other },
      { dryRun: true },
    );
    expect(res.status).toBe(200);
    expect(res.json.result.wouldConnect).toBe(other);

    const [row] = await sql`select custom_domain from sites where id = ${rivalSite.id}`;
    expect(row.custom_domain, "a dry run must not claim the hostname").toBe(hostname);
  }, 60_000);

  it("releases the old hostname when a verified domain is replaced", async () => {
    /**
     * Reachable only through the action — the settings screen disables the field
     * once verified and offers Remove instead. The registry is the boundary that
     * matters though: an agent or MCP client calls this directly.
     *
     * What this asserts is the *local* half — the row moves and the old
     * hostname is left claimable by anyone else. The other half, detaching it
     * from the hosting platform, cannot be seen from here: without platform
     * credentials the effect reports `configuration_required`, and with them it
     * would mutate the real Vercel project. That half is proved separately.
     */
    const replacement = `moved-${Date.now()}.example.com`;
    const before = hostname;

    const res = await merchant.invoke("domains.connect", {
      siteId: site.id,
      domain: replacement,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);

    const [row] = await sql`select custom_domain, domain_status from sites where id = ${site.id}`;
    expect(row.custom_domain).toBe(replacement);
    // Back to pending: a new hostname has proved nothing yet.
    expect(row.domain_status).toBe("pending");

    // The old host is no longer held as verified by anyone, so it is free again.
    const stillHeld = await sql`
      select id from sites where custom_domain = ${before} and domain_status = 'verified'`;
    expect(stillHeld.length).toBe(0);

    // Put it back so the disconnect test below still exercises a verified removal.
    await sql`update sites set custom_domain = ${before}, domain_status = 'verified',
              domain_verified_at = now() where id = ${site.id}`;
  }, 60_000);

  it("disconnects back to a coherent empty state", async () => {
    const res = await merchant.invoke("domains.disconnect", { siteId: site.id });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.result.stoppedServing, "this one was live").toBe(true);

    const [row] = await sql`
      select custom_domain, domain_status, domain_verification_token, domain_verified_at,
             domain_checked_at, domain_last_error
      from sites where id = ${site.id}`;
    expect(row.custom_domain).toBeNull();
    expect(row.domain_status).toBe("none");
    expect(row.domain_verification_token).toBeNull();
    expect(row.domain_verified_at).toBeNull();
    expect(row.domain_checked_at).toBeNull();
    expect(row.domain_last_error).toBeNull();

    // And the storefront is back on its Markii address rather than nowhere.
    const site_ = await merchant.get(`/api/sites/${site.id}`);
    expect(site_.json.storefrontUrl).toContain(site.slug);
  }, 60_000);

  it("refuses a Markii hostname as a custom domain", async () => {
    /**
     * `proxy.ts` treats these as platform hosts and never consults the
     * custom-domain table, so a claim on one would sit in the database looking
     * connected and route nothing — a state with no error and no explanation.
     */
    const res = await merchant.invoke("domains.connect", {
      siteId: site.id,
      domain: `${site.slug}.localhost`,
    });
    expect(res.status).toBe(400);
  }, 60_000);

  it("keeps one org out of another's domain settings", async () => {
    const res = await rival.invoke("domains.connect", {
      siteId: site.id,
      domain: `cross-${Date.now()}.example.com`,
    });
    // 404, never 403: a 403 confirms the site id exists in another org.
    expect(res.status).toBe(404);
  }, 60_000);
});
