import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Cleanup,
  Client,
  createTestStore,
  refused,
  signUpMerchant,
  sql,
  trackCart,
  trackOrderCascade,
} from "./helpers";
import { BASE_URL } from "./setup";

/**
 * Digital delivery end to end (§18.8) — the D5 beachhead.
 *
 * The arithmetic and the redemption gate are unit-tested in
 * `lib/commerce/delivery.test.ts`. What only a real request can show is the
 * wiring: that a paid order actually issues a grant, that the download route
 * redirects to storage rather than serving bytes, that the limit holds against
 * a real counter, and that a refund takes the file back.
 */
describe("digital delivery", () => {
  const merchant = new Client();
  const shopper = new Client();
  const cleanup = new Cleanup();

  let slug: string;
  let site: any;
  let digitalProduct: any;
  let orgId: string;
  let assetId: number;
  /** Rows this file created outside Cleanup's vocabulary. */
  const assetIds: number[] = [];

  const cart = (p = "") => `/_sites/${slug}/api/cart${p}`;
  const checkout = (p = "") => `/_sites/${slug}/api/checkout${p}`;

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "delivery");
    cleanup.merchantEmails.push(email);
    orgId = (await merchant.get("/api/me")).json.org.id;

    const store = await createTestStore(cleanup, "delivery", { orgId });
    slug = store.slug;
    site = store.site;
    [digitalProduct] = store.products;

    // A real file through the real multipart route — the upload path is part of
    // what is under test, not a fixture to fake around.
    const form = new FormData();
    form.set(
      "file",
      new Blob([new Uint8Array(2048).fill(65)], { type: "application/zip" }),
      "test-course.zip",
    );
    form.set("siteId", String(site.id));
    form.set("label", "Test course");

    const res = await merchant.postForm("/api/digital-assets", form);
    if (res.status !== 201) throw new Error(`asset upload failed: ${JSON.stringify(res.json)}`);
    assetId = res.json.id;
    assetIds.push(assetId);

    await merchant.invoke("delivery.attachAsset", {
      productId: digitalProduct.id,
      assetId,
    });
  });

  afterAll(async () => {
    for (const id of assetIds) await sql`delete from digital_assets where id = ${id}`;
    await cleanup.run();
  });

  async function buy(quantity = 1) {
    const c = await shopper.post(cart(), { productId: digitalProduct.id, quantity });
    await trackCart(cleanup, c.json.token);

    const session = await shopper.post(checkout("/session"), {
      cartToken: c.json.token,
      rail: "x402",
    });
    expect(session.status).toBe(201);
    cleanup.checkoutSessionIds.push(session.json.id);

    const paid = await shopper.post(checkout(`/session/${session.json.id}/complete`), {
      paymentReference: `0xdl${Date.now().toString(16)}${Math.floor(Math.random() * 1e6).toString(16)}`,
    });
    expect(paid.status).toBe(200);
    await trackOrderCascade(cleanup, paid.json.orderId);
    return paid.json;
  }

  it("hands over the download in the same exchange that pays for it", async () => {
    const paid = await buy();

    // The D5 story finishing: bought and *received*, no address, nothing pending.
    expect(paid.delivery.downloads).toHaveLength(1);
    const [dl] = paid.delivery.downloads;
    expect(dl.fileName).toBe("test-course.zip");
    expect(dl.sizeBytes).toBe(2048);
    expect(dl.url).toContain("/download/");
    // The link points at the grant, never at storage — a storage URL would be
    // dead within minutes of the receipt being written.
    expect(dl.url).not.toContain("/storage/v1/");
  });

  it("redirects to storage rather than serving the bytes itself", async () => {
    const paid = await buy();
    const url = paid.delivery.downloads[0].url;

    const res = await fetch(url, { redirect: "manual" });
    // G5: proxying would pay egress twice and time out on a large file.
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/storage/v1/object/sign/");
    // And the redirect must not be cacheable — a signed URL outliving its cache
    // entry is a dead link, or worse, a shared one.
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("counts each redemption and meters the bytes for G5", async () => {
    const paid = await buy();
    const url = paid.delivery.downloads[0].url;

    await fetch(url, { redirect: "manual" });
    await fetch(url, { redirect: "manual" });

    const [grant] = await sql`select download_count, last_downloaded_at from download_grants
      where order_id = ${paid.orderId}`;
    expect(grant.download_count).toBe(2);
    expect(grant.last_downloaded_at).not.toBeNull();

    const events = await sql`select bytes from download_events e
      join download_grants g on g.id = e.grant_id where g.order_id = ${paid.orderId}`;
    expect(events).toHaveLength(2);
    expect(events.every((e: any) => e.bytes === 2048)).toBe(true);
  });

  it("enforces a download limit and says which one was hit", async () => {
    await merchant.invoke("delivery.setDownloadPolicy", {
      productId: digitalProduct.id,
      downloadLimit: 2,
      downloadExpiryDays: null,
    });

    const paid = await buy();
    const url = paid.delivery.downloads[0].url;
    expect(paid.delivery.downloads[0].downloadLimit).toBe(2);

    expect((await fetch(url, { redirect: "manual" })).status).toBe(302);
    expect((await fetch(url, { redirect: "manual" })).status).toBe(302);

    const third = await fetch(url, { redirect: "manual" });
    expect(third.status).toBe(410);
    const body = await third.json();
    expect(body.error.code).toBe("LIMIT_REACHED");
    expect(body.error.details.downloadLimit).toBe(2);

    // Reset for the tests that follow.
    await merchant.invoke("delivery.setDownloadPolicy", {
      productId: digitalProduct.id,
      downloadLimit: null,
      downloadExpiryDays: null,
    });
  });

  it("a merchant can give a legitimate buyer their downloads back", async () => {
    await merchant.invoke("delivery.setDownloadPolicy", {
      productId: digitalProduct.id,
      downloadLimit: 1,
      downloadExpiryDays: null,
    });
    const paid = await buy();
    const url = paid.delivery.downloads[0].url;
    await fetch(url, { redirect: "manual" });
    expect((await fetch(url, { redirect: "manual" })).status).toBe(410);

    const [g] = await sql`select id from download_grants where order_id = ${paid.orderId}`;
    const r = await merchant.invoke("delivery.reissueDownload", { grantId: g.id, resetCount: true });
    expect(r.json.ok).toBe(true);
    expect((await fetch(url, { redirect: "manual" })).status).toBe(302);

    await merchant.invoke("delivery.setDownloadPolicy", {
      productId: digitalProduct.id,
      downloadLimit: null,
      downloadExpiryDays: null,
    });
  });

  it("a refund takes the file back", async () => {
    const paid = await buy();
    const url = paid.delivery.downloads[0].url;
    expect((await fetch(url, { redirect: "manual" })).status).toBe(302);

    const detail = await merchant.get(`/api/orders/${paid.orderId}`);
    const refund = await merchant.invoke("orders.refund", {
      orderId: paid.orderId,
      lines: [{ orderLineId: detail.json.lines[0].id, quantity: 1 }],
    });
    expect(refund.json.ok).toBe(true);
    // Buy, download, refund, keep the file — the whole digital-goods fraud
    // pattern, closed.
    expect(refund.json.result.downloadsRevoked).toBe(1);

    const after = await fetch(url, { redirect: "manual" });
    expect(after.status).toBe(403);
    expect((await after.json()).error.code).toBe("REVOKED");
  });

  it("issues licence keys per unit and returns them to the pool on refund", async () => {
    const added = await merchant.invoke("delivery.addLicenceKeys", {
      productId: digitalProduct.id,
      keys: ["KEY-AAA-111", "KEY-BBB-222", "KEY-CCC-333"],
    });
    expect(added.json.result.added).toBe(3);

    const paid = await buy(2);
    // Keys are per unit — unlike downloads, the key *is* the thing being sold.
    expect(paid.delivery.licenceKeys).toHaveLength(2);

    const detail = await merchant.get(`/api/orders/${paid.orderId}`);
    const refund = await merchant.invoke("orders.refund", {
      orderId: paid.orderId,
      lines: [{ orderLineId: detail.json.lines[0].id, quantity: 2 }],
    });
    // Unused keys are inventory the merchant paid for; burning them on a
    // refunded order quietly shrinks their stock.
    expect(refund.json.result.licenceKeysReturned).toBe(2);

    const free = await sql`select count(*)::int n from licence_keys
      where product_id = ${digitalProduct.id} and assigned_at is null`;
    expect(free[0].n).toBe(3);
  });

  it("ignores a re-submitted key list rather than doubling the pool", async () => {
    const again = await merchant.invoke("delivery.addLicenceKeys", {
      productId: digitalProduct.id,
      keys: ["KEY-AAA-111", "KEY-BBB-222", "KEY-DDD-444"],
    });
    expect(again.json.result.added).toBe(1);
    expect(again.json.result.duplicatesIgnored).toBe(2);
  });

  it("keeps the licence keys out of the audit log", async () => {
    const [row] = await sql`select input from action_invocations
      where action_id = 'delivery.addLicenceKeys' order by occurred_at desc limit 1`;
    // The keys are the product. An audit row holding them is a list of stock to
    // steal, readable by anyone who can read the audit trail.
    expect(JSON.stringify(row.input)).not.toContain("KEY-AAA-111");
    expect(JSON.stringify(row.input)).toContain("redacted");
  });

  it("404s an unknown token without confirming whether it could exist", async () => {
    const res = await fetch(`${BASE_URL}/_sites/${slug}/download/not-a-real-token`, {
      redirect: "manual",
    });
    expect(res.status).toBe(404);
  });

  it("keeps another org out of the assets and grants", async () => {
    const outsider = new Client();
    const { email } = await signUpMerchant(outsider, "delivery-outsider");
    cleanup.merchantEmails.push(email);

    expect(
      refused(await outsider.invoke("delivery.deleteAsset", { assetId })),
    ).toBe(true);
    expect(
      refused(
        await outsider.invoke("delivery.attachAsset", {
          productId: digitalProduct.id,
          assetId,
        }),
      ),
    ).toBe(true);

    const list = await outsider.get("/api/digital-assets");
    expect(list.json.items).toHaveLength(0);
  });
});
