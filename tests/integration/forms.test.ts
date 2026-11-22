import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, createTestStore, signUpMerchant } from "./helpers";
import { BASE_URL } from "./setup";

/**
 * Storefront forms (`docs/BUILDER.md` §15 step 12) against a real database and
 * dev server. What only this shows: a plain HTML post lands as a stored,
 * labelled submission; the blocklist refuses before anything is stored; the
 * rate limits fire on the address and on the sender; the notification is
 * attempted and its outcome recorded; and deleting a form keeps what was sent.
 *
 * Notifications go to Resend's test inbox (`delivered@resend.dev`), so a run
 * mails no real person.
 */
describe("storefront forms", () => {
  const merchant = new Client();
  const cleanup = new Cleanup();
  let siteId: number;
  let slug: string;
  let formId: number;
  let ipCounter = 0;

  const act = (id: string, input: unknown) => merchant.post(`/api/actions/${id}`, input);
  const ok = async (id: string, input: unknown) => {
    const res = await act(id, input);
    expect(res.status, `${id}: ${JSON.stringify(res.json)}`).toBe(200);
    return res.json;
  };
  /** A fresh client address per call unless one is given, so the per-address limit only fires where a test means it to. */
  const freshIp = () => `198.51.100.${(ipCounter++ % 250) + 1}`;
  const post = async (handle: string, body: Record<string, string>, opts: { json?: boolean; ip?: string } = {}) => {
    const res = await fetch(`${BASE_URL}/_sites/${slug}/api/forms/${handle}`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "x-forwarded-for": opts.ip ?? freshIp(),
        "content-type": opts.json ? "application/json" : "application/x-www-form-urlencoded",
      },
      body: opts.json ? JSON.stringify(body) : new URLSearchParams(body).toString(),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      // HTML or empty
    }
    return { status: res.status, location: res.headers.get("location"), retryAfter: res.headers.get("retry-after"), json };
  };
  const submissions = async (q = "") => (await merchant.get(`/api/sites/${siteId}/form-submissions${q}`)).json;
  const valid = (email: string) => ({ name: "Mei", email, message: "Do you ship to Canada?", _return: "/pages/contact" });

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "forms");
    cleanup.merchantEmails.push(email);
    const orgId = (await merchant.get("/api/me")).json.org.id;
    const store = await createTestStore(cleanup, "forms", { orgId });
    siteId = store.site.id;
    slug = store.slug;
  }, 180_000);

  afterAll(async () => cleanup.run(), 120_000);

  it("creates a form that is live at its own page at once", async () => {
    const created = await ok("forms.createForm", {
      siteId,
      name: "Contact us",
      notifyEmail: "delivered@resend.dev",
      successMessage: "Thanks — we answer within a day.",
      fields: [
        { name: "name", label: "Your name", type: "text", required: true },
        { name: "email", label: "Email", type: "email", required: true },
        { name: "message", label: "Message", type: "textarea", required: true },
      ],
    });
    expect(created.result).toMatchObject({ handle: "contact-us", path: "/forms/contact-us" });
    formId = created.result.formId;

    const page = await fetch(`${BASE_URL}/_sites/${slug}/forms/contact-us`, { headers: { "x-forwarded-for": freshIp() } });
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toMatch(/<form [^>]*method="post"/);
    expect(html).toContain("/api/forms/contact-us");
  });

  it("stores a plain HTML post with its labels, sends the notification, and says so", async () => {
    const res = await post("contact-us", valid("mei@example.com"));
    expect(res.status).toBe(303);
    expect(res.location).toMatch(/\/forms\/contact-us\?status=sent&from=%2Fpages%2Fcontact$/);

    // Locally the store's address is the path form, already under BASE_URL; a subdomain address is mapped onto it.
    const landing = res.location!.startsWith(BASE_URL) ? res.location! : res.location!.replace(/^https?:\/\/[^/]+/, `${BASE_URL}/_sites/${slug}`);
    const sent = await fetch(landing, { headers: { "x-forwarded-for": freshIp() } });
    expect(await sent.text()).toContain("Thanks — we answer within a day.");

    const [item] = (await submissions("?form=contact-us")).items;
    expect(item).toMatchObject({ email: "mei@example.com", form: { handle: "contact-us", name: "Contact us", exists: true } });
    expect(item.values).toEqual([
      { name: "name", label: "Your name", value: "Mei" },
      { name: "email", label: "Email", value: "mei@example.com" },
      { name: "message", label: "Message", value: "Do you ship to Canada?" },
    ]);
    // The send was attempted and its outcome recorded — never left pending, never claimed off.
    expect(["sent", "failed"]).toContain(item.notify.status);
    if (item.notify.status === "failed") expect(item.notify.error).toBeTruthy();
  });

  it("answers JSON callers in JSON, and names what is wrong", async () => {
    expect((await post("contact-us", valid("json@example.com"), { json: true })).status).toBe(201);

    const bad = await post("contact-us", { name: "Mei", email: "nope", message: "hi" }, { json: true });
    expect(bad.status).toBe(400);
    expect(bad.json.error.details.fields.map((f: { field: string }) => f.field)).toEqual(["email"]);

    const html = await post("contact-us", { name: "Mei", email: "nope", message: "hi" });
    expect(html.status).toBe(303);
    expect(html.location).toContain("status=invalid&field=email");
  });

  it("refuses a blocked sender before anything is stored — and says only that it could not be sent", async () => {
    const block = await ok("forms.blockSender", { siteId, pattern: "junk.test", note: "spam run" });
    expect(block.result.pattern).toBe("@junk.test");
    const before = (await submissions()).total;

    const refused = await post("contact-us", valid("bot@mail.junk.test"), { json: true });
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe("SUBMISSION_REFUSED");
    expect(JSON.stringify(refused.json)).not.toMatch(/block/i);
    expect((await post("contact-us", valid("bot@junk.test"))).location).toContain("status=refused");
    expect((await submissions()).total).toBe(before);

    await ok("forms.unblockSender", { siteId, entryId: block.result.entryId });
    expect((await post("contact-us", valid("bot@junk.test"), { json: true })).status).toBe(201);
  });

  it("rate-limits one address, and one sender across addresses", async () => {
    const ip = "203.0.113.200";
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await post("contact-us", valid(`ip${i}@example.com`), { json: true, ip })).status);
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
    const limited = await post("contact-us", valid("ip9@example.com"), { json: true, ip });
    expect(Number(limited.retryAfter)).toBeGreaterThan(0);

    const sender = [] as number[];
    for (let i = 0; i < 4; i++) sender.push((await post("contact-us", valid("repeat@example.com"), { json: true })).status);
    expect(sender).toEqual([201, 201, 201, 429]);
  });

  it("places a form on a designed page, and refuses to publish one that names no form", async () => {
    await ok("builder.startDesign", { siteId });
    const summary = (await merchant.get(`/api/builder/sites/${siteId}`)).json;
    const homeId = summary.pages[0].id;
    const section = (await merchant.get(`/api/builder/sites/${siteId}/pages/${homeId}`)).json.tree.children[0];

    const bad = await ok("builder.addBlock", { siteId, pageId: homeId, parentId: section.id, type: "form", props: { formHandle: "no-such-form" } });
    const blocked = await act("builder.publish", { siteId });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error.details.checks.map((c: { code: string }) => c.code)).toContain("UNKNOWN_FORM");

    await ok("builder.setProps", { siteId, pageId: homeId, nodeId: bad.result.nodeId, props: { formHandle: "contact-us" } });
    await ok("builder.publish", { siteId });
    const home = await (await fetch(`${BASE_URL}/_sites/${slug}/`, { headers: { "x-forwarded-for": freshIp() } })).text();
    expect(home).toContain("/api/forms/contact-us");
    expect(home).toContain('name="_return" value="/"');

    // In use on a page: the form cannot be deleted out from under it.
    const inUse = await act("forms.deleteForm", { formId });
    expect(inUse.status).toBe(409);
    expect(inUse.json.error.details.reason).toBe("in_use");
  });

  it("keeps submissions when their form is deleted, and erases one only by hand", async () => {
    const other = await ok("forms.createForm", { siteId, name: "Wholesale", fields: [{ name: "email", label: "Email", type: "email", required: true }] });
    expect((await post("wholesale", { email: "buyer@example.com" }, { json: true })).status).toBe(201);
    const [sent] = (await submissions("?form=wholesale")).items;
    expect(sent.notify.status).toBe("off");

    const gone = await ok("forms.deleteForm", { formId: other.result.formId });
    expect(gone.result.submissionsKept).toBe(1);
    const [kept] = (await submissions("?form=wholesale")).items;
    expect(kept).toMatchObject({ id: sent.id, form: { handle: "wholesale", exists: false }, email: "buyer@example.com" });
    expect((await post("wholesale", { email: "late@example.com" }, { json: true })).status).toBe(404);

    await ok("forms.deleteSubmission", { submissionId: sent.id });
    expect((await submissions("?form=wholesale")).total).toBe(0);
  });
});
