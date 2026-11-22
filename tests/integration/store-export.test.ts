import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { parseStoreExport, type StoreExportDocument } from "@/lib/store-export/format";
import { importStore, StoreImportError, type ImportStorage } from "@/lib/store-export/import";
import { unzip } from "@/lib/zip";
import { Cleanup, Client, createTestStore, signUpMerchant, sql } from "./helpers";

/**
 * Store export → self-hosted import, end to end (D53, 2026-11-21).
 *
 * A store with something in every relationship that can go wrong — a category
 * under a parent, ids inside JSON, a customer with a membership bought by an
 * order that was partly refunded, a sold file shared at org level, a published
 * version naming its documents by id — is exported through the real action,
 * downloaded through the real link, unzipped, and imported into a second org
 * in this same database. Then every link is followed on the far side.
 *
 * Same database is the hard case, not the easy one: every id collides unless
 * it is remapped, so a link the importer forgot points at the *source* store
 * and the assertions catch it.
 */
const storageClient = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

describe("store export and import", () => {
  const merchant = new Client();
  const cleanup = new Cleanup();
  const stamp = `${Date.now()}`;
  const paths: { bucket: string; path: string }[] = [];
  const fileBytes = new TextEncoder().encode(`the product itself ${stamp}`);
  let src: Awaited<ReturnType<typeof createTestStore>>;
  let ids: Record<string, number> = {};
  let imageUrl = "";
  let doc: StoreExportDocument;
  let targetOrg = "";
  let imported: { siteId: number; slug: string };

  const storage: ImportStorage = {
    async putPrivate(path, bytes, contentType) {
      const { error } = await storageClient.storage.from("digital-assets").upload(path, bytes, { contentType });
      if (error) throw new Error(error.message);
      paths.push({ bucket: "digital-assets", path });
    },
    async putPublic(path, bytes, contentType) {
      const { error } = await storageClient.storage.from("public-media").upload(path, bytes, { contentType });
      if (error) throw new Error(error.message);
      paths.push({ bucket: "public-media", path });
      return storageClient.storage.from("public-media").getPublicUrl(path).data.publicUrl;
    },
  };

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "export");
    cleanup.merchantEmails.push(email);
    const orgId = (await merchant.get("/api/me")).json.org.id;
    src = await createTestStore(cleanup, "export", { orgId });
    const site = src.site.id;
    const [p0, p1, p2] = src.products;

    // A public image the store uploaded, and a sold file in private storage.
    const imagePath = `${orgId}/store-export-test-${stamp}.png`;
    await storageClient.storage.from("public-media").upload(imagePath, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), { contentType: "image/png" });
    paths.push({ bucket: "public-media", path: imagePath });
    imageUrl = storageClient.storage.from("public-media").getPublicUrl(imagePath).data.publicUrl;
    const filePath = `${orgId}/store-export-test-${stamp}.txt`;
    await storageClient.storage.from("digital-assets").upload(filePath, fileBytes, { contentType: "text/plain" });
    paths.push({ bucket: "digital-assets", path: filePath });

    const [parent] = await sql`insert into categories (site_id, name, slug) values (${site}, 'Parent', 'parent') returning id`;
    const [child] = await sql`insert into categories (site_id, name, slug, parent_id) values (${site}, 'Child', 'child', ${parent.id}) returning id`;
    await sql`update products set category_id = ${child.id}, images = ${sql.json([imageUrl])},
      suggested_product_ids = ${sql.json([p1.id])}, add_ons = ${sql.json([{ productId: p2.id, mandatory: false }])}
      where id = ${p0.id}`;
    const [variant] = await sql`insert into variants (product_id, title, option_values, price_minor)
      values (${p0.id}, 'Large', ${sql.json({ Size: "L" })}, 1500) returning id`;
    const [loc] = await sql`insert into locations (site_id, name, is_default) values (${site}, 'Main', true) returning id`;
    await sql`insert into inventory_ledger (variant_id, location_id, available_delta, reason, actor_type, invocation_id)
      values (${variant.id}, ${loc.id}, 7, 'count', 'system', 'inv_source_only')`;
    const [coll] = await sql`insert into collections (site_id, title, handle) values (${site}, 'Picks', 'picks') returning id`;
    await sql`insert into collection_products (collection_id, product_id, position) values (${coll.id}, ${p2.id}, 0)`;
    const [tier] = await sql`insert into membership_tiers (site_id, name, handle) values (${site}, 'Insiders', 'insiders') returning id`;
    const [customer] = await sql`insert into customers (site_id, email, first_name, auth_user_id)
      values (${site}, ${`buyer-${stamp}@example.com`}, 'Ada', 'auth-on-source-only') returning id`;
    await sql`insert into customer_addresses (customer_id, line1, city, country) values (${customer.id}, '1 Main St', 'Springfield', 'US')`;
    const [order] = await sql`insert into orders (site_id, product_id, customer_id, amount_cents, currency, provider, status, financial_status, subtotal_minor, refunded_minor, email)
      values (${site}, ${p0.id}, ${customer.id}, 1500, 'USD', 'x402', 'success', 'partially_refunded', 1500, 500, ${`buyer-${stamp}@example.com`}) returning id`;
    const [line] = await sql`insert into order_lines (order_id, product_id, variant_id, location_id, title, quantity, unit_price_minor, subtotal_minor, total_minor)
      values (${order.id}, ${p0.id}, ${variant.id}, ${loc.id}, 'Test Product One', 1, 1500, 1500, 1500) returning id`;
    const [refund] = await sql`insert into refunds (order_id, amount_minor, net_sales_minor, currency, rail, actor_type, invocation_id)
      values (${order.id}, 500, 500, 'USD', 'x402', 'system', 'inv_source_only') returning id`;
    await sql`insert into refund_lines (refund_id, order_line_id, quantity, subtotal_minor) values (${refund.id}, ${line.id}, 1, 500)`;
    await sql`insert into order_events (order_id, type, message, actor_type) values (${order.id}, 'placed', 'Order placed', 'system')`;
    await sql`insert into customer_memberships (customer_id, tier_id, source, order_id) values (${customer.id}, ${tier.id}, 'purchase', ${order.id})`;
    const [discount] = await sql`insert into discounts (site_id, code, title, type, percentage_bps, applies_to_scope, applies_to_ids, customer_eligibility, eligible_customer_ids)
      values (${site}, 'TEN', 'Ten off', 'percentage', 1000, 'products', ${sql.json([p0.id])}, 'specific', ${sql.json([customer.id])}) returning id`;
    const [zone] = await sql`insert into shipping_zones (site_id, name, countries) values (${site}, 'US', ${sql.json(["US"])}) returning id`;
    await sql`insert into shipping_rates (zone_id, name, type, price_minor) values (${zone.id}, 'Standard', 'flat', 500)`;
    await sql`insert into tax_settings (site_id) values (${site})`;
    // An org-level file (no site) — it travels because a product of this store sells it.
    const [asset] = await sql`insert into digital_assets (org_id, storage_path, file_name, content_type, size_bytes)
      values (${orgId}, ${filePath}, 'guide.txt', 'text/plain', ${fileBytes.byteLength}) returning id`;
    await sql`insert into product_digital_assets (product_id, asset_id) values (${p0.id}, ${asset.id})`;
    await sql`insert into download_grants (token, order_id, order_line_id, asset_id, customer_id)
      values (${`grant-${stamp}`}, ${order.id}, ${line.id}, ${asset.id}, ${customer.id})`;
    await sql`insert into licence_keys (org_id, product_id, key, order_id, customer_id) values (${orgId}, ${p0.id}, ${`KEY-${stamp}`}, ${order.id}, ${customer.id})`;
    await sql`insert into site_designs (site_id, draft_theme_id, draft_head_html, published_head_html)
      values (${site}, 'studio', '<script>track()</script>', '<script>track()</script>')`;
    const tree = { id: "root", type: "page", props: {}, children: [{ id: "n1", type: "image", props: { src: imageUrl }, children: [] }] };
    const [page] = await sql`insert into site_documents (site_id, kind, handle, title, draft_tree, published_tree, published_handle, published_title)
      values (${site}, 'page', 'about', 'About', ${sql.json(tree)}, ${sql.json(tree)}, 'about', 'About') returning id`;
    await sql`insert into site_design_versions (site_id, version, snapshot, published_by)
      values (${site}, 1, ${sql.json({ themeId: "studio", tokens: {}, headHtml: "<script>track()</script>", documents: [{ id: page.id, kind: "page", handle: "about", title: "About", seo: {}, tree }] })}, 'user:someone')`;

    ids = { site, p0: p0.id, p1: p1.id, p2: p2.id, parent: parent.id, child: child.id, variant: variant.id, loc: loc.id, coll: coll.id, tier: tier.id, customer: customer.id, order: order.id, line: line.id, refund: refund.id, discount: discount.id, asset: asset.id, page: page.id };

    const [target] = await sql`insert into organizations (id, name, slug, owner_id, billing_email, currency, country)
      values (${`org_import_${stamp}`}, 'Import target', ${`import-target-${stamp}`}, ${`owner-${stamp}`}, ${`import-${stamp}@markii.shop`}, 'USD', 'US') returning id`;
    targetOrg = target.id;
    cleanup.orgIds.push(targetOrg);
  }, 240_000);

  afterAll(async () => {
    if (imported) cleanup.siteIds.push(imported.siteId);
    await cleanup.run();
    for (const bucket of ["public-media", "digital-assets"]) {
      const mine = paths.filter((p) => p.bucket === bucket).map((p) => p.path);
      if (mine.length) await storageClient.storage.from(bucket).remove(mine);
    }
  }, 120_000);

  it("previews the export without making a file", async () => {
    const res = await merchant.post(`/api/actions/store.export?dryRun=1`, { siteId: ids.site });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.dryRun).toBe(true);
    expect(res.json.result).toMatchObject({ url: "", counts: { products: 3, customers: 1, orders: 1, digitalAssets: 1 } });
  });

  it("exports through the action, and keeps the link out of the audit log", async () => {
    const res = await merchant.post(`/api/actions/store.export`, { siteId: ids.site });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const result = res.json.result;
    expect(result.headCodeLeftOut).toBe(true);
    expect(result.files).toMatchObject({ digitalAssets: 1, publicMedia: 1 });

    const [row] = await sql`select result from action_invocations where id = ${res.json.invocationId}`;
    expect(JSON.stringify(row.result)).not.toContain(result.url);

    const archive = await fetch(result.url);
    expect(archive.status).toBe(200);
    const files = unzip(new Uint8Array(await archive.arrayBuffer()));
    expect([...files.keys()].sort()).toEqual(["README.md", "store.json"]);
    expect(files.get("README.md")!.toString("utf8")).toContain("personal data");
    doc = parseStoreExport(files.get("store.json")!.toString("utf8"));
  });

  it("leaves credentials, logins, payout details and custom scripts behind", () => {
    const text = JSON.stringify(doc.tables);
    expect(text).not.toContain("<script>");
    expect(text).not.toContain("auth-on-source-only");
    expect(text).not.toContain("0xtestwallet");
    expect(text).not.toContain("inv_source_only");
    expect(doc.tables.digitalAssets[0]).not.toHaveProperty("storagePath");
    expect(doc.tables.sites[0]).not.toHaveProperty("orgId");
    expect(doc.counts).toMatchObject({ categories: 2, variants: 1, inventoryLedger: 1, refunds: 1, downloadGrants: 1, licenceKeys: 1, siteDesignVersions: 1 });
  });

  it("imports into another org with every link pointing at the new store", async () => {
    // Download tokens are unique across a deployment, so the source's grant must be gone — as it is
    // when the source store lives on another deployment, which is the case this exists for.
    await sql`delete from download_grants where token = ${`grant-${stamp}`}`;
    imported = await importStore({ db, doc, orgId: targetOrg, slug: `imported-${stamp}`, storage });
    const site = imported.siteId;
    expect(site).not.toBe(ids.site);

    const [s] = await sql`select org_id, status, wallet_address, name from sites where id = ${site}`;
    expect(s).toMatchObject({ org_id: targetOrg, status: "draft", wallet_address: null, name: src.site.name });

    const cats = await sql`select id, slug, parent_id from categories where site_id = ${site} order by slug`;
    const newChild = cats.find((c) => c.slug === "child")!;
    const newParent = cats.find((c) => c.slug === "parent")!;
    expect(newChild.parent_id).toBe(newParent.id);

    const prods = await sql`select id, slug, category_id, suggested_product_ids, add_ons, images from products where site_id = ${site} order by slug`;
    const bySlug = Object.fromEntries(prods.map((p) => [p.slug, p]));
    const one = bySlug["test-product-one"];
    expect(one.category_id).toBe(newChild.id);
    expect(one.suggested_product_ids).toEqual([bySlug["test-product-two"].id]);
    expect(one.add_ons).toEqual([{ productId: bySlug["test-product-three"].id, mandatory: false }]);
    // The image was copied into this deployment's storage, not left pointing at the source's file.
    expect(one.images[0]).not.toBe(imageUrl);
    expect((await fetch(one.images[0])).status).toBe(200);

    const [v] = await sql`select id from variants where product_id = ${one.id}`;
    const [loc] = await sql`select id from locations where site_id = ${site}`;
    const [ledger] = await sql`select sum(available_delta)::int as n, max(invocation_id) as inv from inventory_ledger where variant_id = ${v.id} and location_id = ${loc.id}`;
    expect(ledger).toMatchObject({ n: 7, inv: null });

    const [cp] = await sql`select cp.product_id from collection_products cp join collections c on c.id = cp.collection_id where c.site_id = ${site}`;
    expect(cp.product_id).toBe(bySlug["test-product-three"].id);

    const [cust] = await sql`select id, auth_user_id, email from customers where site_id = ${site}`;
    expect(cust.auth_user_id).toBeNull();
    expect((await sql`select count(*)::int as n from customer_addresses where customer_id = ${cust.id}`)[0].n).toBe(1);

    const [order] = await sql`select id, customer_id, product_id from orders where site_id = ${site}`;
    expect(order).toMatchObject({ customer_id: cust.id, product_id: one.id });
    const [line] = await sql`select id, variant_id, location_id from order_lines where order_id = ${order.id}`;
    expect(line).toMatchObject({ variant_id: v.id, location_id: loc.id });
    const [rl] = await sql`select rl.order_line_id, r.invocation_id from refund_lines rl join refunds r on r.id = rl.refund_id where r.order_id = ${order.id}`;
    expect(rl).toMatchObject({ order_line_id: line.id, invocation_id: null });

    const [tier] = await sql`select id from membership_tiers where site_id = ${site}`;
    const [m] = await sql`select tier_id, order_id from customer_memberships where customer_id = ${cust.id}`;
    expect(m).toMatchObject({ tier_id: tier.id, order_id: order.id });

    const [coll] = await sql`select id from collections where site_id = ${site}`;
    void coll;
    const [d] = await sql`select applies_to_ids, eligible_customer_ids from discounts where site_id = ${site}`;
    expect(d).toMatchObject({ applies_to_ids: [one.id], eligible_customer_ids: [cust.id] });

    // The sold file: a new row in the target org, a new copy in storage, the same bytes.
    const [asset] = await sql`select a.id, a.org_id, a.storage_path from digital_assets a join product_digital_assets pa on pa.asset_id = a.id where pa.product_id = ${one.id}`;
    expect(asset.org_id).toBe(targetOrg);
    expect(asset.id).not.toBe(ids.asset);
    const { data } = await storageClient.storage.from("digital-assets").download(asset.storage_path);
    expect(new Uint8Array(await data!.arrayBuffer())).toEqual(fileBytes);
    const [grant] = await sql`select asset_id, order_line_id, token from download_grants where order_id = ${order.id}`;
    expect(grant).toMatchObject({ asset_id: asset.id, order_line_id: line.id, token: `grant-${stamp}` });
    const [key] = await sql`select org_id, order_id from licence_keys where product_id = ${one.id}`;
    expect(key).toMatchObject({ org_id: targetOrg, order_id: order.id });

    const [design] = await sql`select draft_head_html, published_head_html from site_designs where site_id = ${site}`;
    expect(design).toEqual({ draft_head_html: "", published_head_html: "" });
    const [page] = await sql`select id, draft_tree from site_documents where site_id = ${site}`;
    expect(JSON.stringify(page.draft_tree)).not.toContain(imageUrl);
    expect(JSON.stringify(page.draft_tree)).toContain(one.images[0]);
    const [version] = await sql`select snapshot from site_design_versions where site_id = ${site}`;
    expect(version.snapshot.documents[0].id).toBe(page.id);
    expect(version.snapshot).not.toHaveProperty("headHtml");
  });

  it("refuses rather than half-importing", async () => {
    // The address is taken now.
    await expect(importStore({ db, doc, orgId: targetOrg, slug: imported.slug, storage })).rejects.toThrow(StoreImportError);
    // A second copy in the same database would duplicate the shoppers' download links.
    await expect(importStore({ db, doc, orgId: targetOrg, slug: `again-${stamp}`, storage })).rejects.toThrow(/Download links/);
    expect((await sql`select count(*)::int as n from sites where slug = ${`again-${stamp}`}`)[0].n).toBe(0);
    // An export from a schema this deployment does not have.
    expect(() => parseStoreExport(JSON.stringify({ ...doc, schema: "9999_from_the_future" }))).toThrow(/Upgrade/);
    expect(() => parseStoreExport(JSON.stringify({ format: "markii.theme" }))).toThrow(/not a Markii store export/);
  });
});
