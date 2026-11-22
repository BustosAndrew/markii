import { is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as schema from "../db/schema";

/**
 * What a store export carries, table by table (D53) — and, as importantly,
 * what it leaves out and why.
 *
 * **Every table in the schema is in exactly one of `STORE_TABLES` or
 * `LEFT_OUT`**, and `spec.test.ts` fails the moment a new table is in neither.
 * A store export is a promise to a merchant that their store came with them;
 * a table added later and never classified would silently break it, and the
 * merchant would find out on the other side, with the source store gone.
 *
 * Rows travel **as they are**, keyed by the Drizzle property names, with three
 * kinds of change and no others:
 *
 * - `omit` columns are never written into the file. They are credentials,
 *   state that only means something on this deployment (a lease, a login on
 *   Markii's auth project, a verified domain), or the source's own audit
 *   pointers. The importer leaves them to their column defaults.
 * - Foreign keys are remapped by the importer from Drizzle's own metadata —
 *   nothing here lists them, so a new foreign key is remapped without anyone
 *   remembering to.
 * - `remap` rewrites ids that live **inside JSON**, which no foreign key can
 *   see: a product's suggested products, a discount's targets, a published
 *   version's document ids.
 *
 * `scope` says which rows belong to the store. `site` is a `site_id` column;
 * `parent` is a foreign key into a table earlier in the list, so a variant is
 * exported because its product was. **The list order is the insert order**,
 * and the test holds every foreign key to point at an earlier table.
 */

export type IdMaps = Map<string, Map<number, number>>;

export type Row = Record<string, unknown>;

export type StoreTable = {
  /** The key in the export file, and in the id maps: the Drizzle export name. */
  key: string;
  table: PgTable;
  scope:
    | { kind: "root" }
    | { kind: "site"; column: string }
    | { kind: "parent"; column: string; parent: string }
    /** Rows the store reaches by more than one path — see `digitalAssets`. */
    | { kind: "custom"; reason: string };
  omit?: string[];
  /** Why each omitted column stays behind, for the README and for review. */
  omitReason?: string;
  /**
   * Strips what must not leave this deployment from **inside** a column,
   * where `omit` cannot reach — run at **export**, so the file never holds it.
   * (Doing this at import instead is how head code from past versions once
   * rode along in the file: the test that caught it is in
   * `tests/integration/store-export.test.ts`.)
   */
  scrub?: (row: Row) => Row;
  /** Rewrites ids inside JSON to the importing deployment's — run at **import**. */
  remap?: (row: Row, ids: IdMaps) => Row;
};

const mapList = (values: unknown, map: Map<number, number> | undefined): number[] =>
  Array.isArray(values)
    ? values.flatMap((v) => {
        const next = typeof v === "number" ? map?.get(v) : undefined;
        return next === undefined ? [] : [next];
      })
    : [];

/** The source's audit pointers: invocations that stay in the source's log. */
const AUDIT_POINTER = ["invocationId"];

export const STORE_TABLES: StoreTable[] = [
  {
    key: "sites",
    table: schema.sites,
    scope: { kind: "root" },
    omit: [
      "orgId",
      "customDomain",
      "domainStatus",
      "domainVerificationToken",
      "domainVerifiedAt",
      "domainCheckedAt",
      "domainLastError",
      "walletAddress",
      "paymentProviders",
      "status",
    ],
    omitReason:
      "A domain is proved again where the store now lives; payout and payment rails are connected " +
      "again by a person (they move only through payments.connectRail); the store arrives as a draft.",
  },
  { key: "categories", table: schema.categories, scope: { kind: "site", column: "siteId" } },
  { key: "membershipTiers", table: schema.membershipTiers, scope: { kind: "site", column: "siteId" } },
  {
    key: "products",
    table: schema.products,
    scope: { kind: "site", column: "siteId" },
    omit: ["searchVector"],
    omitReason: "Generated from the product's own columns.",
    remap: (row, ids) => {
      const products = ids.get("products");
      return {
        ...row,
        suggestedProductIds: mapList(row.suggestedProductIds, products),
        addOns: Array.isArray(row.addOns)
          ? row.addOns.flatMap((a: { productId: number; mandatory: boolean }) => {
              const productId = products?.get(a.productId);
              return productId === undefined ? [] : [{ ...a, productId }];
            })
          : [],
      };
    },
  },
  { key: "productOptions", table: schema.productOptions, scope: { kind: "parent", column: "productId", parent: "products" } },
  { key: "variants", table: schema.variants, scope: { kind: "parent", column: "productId", parent: "products" } },
  { key: "locations", table: schema.locations, scope: { kind: "site", column: "siteId" } },
  {
    key: "inventoryLedger",
    table: schema.inventoryLedger,
    scope: { kind: "parent", column: "variantId", parent: "variants" },
    omit: AUDIT_POINTER,
  },
  { key: "collections", table: schema.collections, scope: { kind: "site", column: "siteId" } },
  { key: "collectionProducts", table: schema.collectionProducts, scope: { kind: "parent", column: "collectionId", parent: "collections" } },
  {
    key: "customers",
    table: schema.customers,
    scope: { kind: "site", column: "siteId" },
    omit: ["authUserId"],
    omitReason:
      "A shopper's login lives in this deployment's auth project. They sign up again where the store " +
      "now lives, with the same email, and find their orders and memberships waiting.",
  },
  { key: "customerAddresses", table: schema.customerAddresses, scope: { kind: "parent", column: "customerId", parent: "customers" } },
  { key: "orders", table: schema.orders, scope: { kind: "site", column: "siteId" } },
  { key: "customerMemberships", table: schema.customerMemberships, scope: { kind: "parent", column: "customerId", parent: "customers" } },
  { key: "orderLines", table: schema.orderLines, scope: { kind: "parent", column: "orderId", parent: "orders" } },
  { key: "refunds", table: schema.refunds, scope: { kind: "parent", column: "orderId", parent: "orders" }, omit: AUDIT_POINTER },
  { key: "refundLines", table: schema.refundLines, scope: { kind: "parent", column: "refundId", parent: "refunds" } },
  { key: "fulfillments", table: schema.fulfillments, scope: { kind: "parent", column: "orderId", parent: "orders" }, omit: AUDIT_POINTER },
  { key: "fulfillmentLines", table: schema.fulfillmentLines, scope: { kind: "parent", column: "fulfillmentId", parent: "fulfillments" } },
  { key: "orderEvents", table: schema.orderEvents, scope: { kind: "parent", column: "orderId", parent: "orders" }, omit: AUDIT_POINTER },
  {
    key: "discounts",
    table: schema.discounts,
    scope: { kind: "site", column: "siteId" },
    remap: (row, ids) => ({
      ...row,
      appliesToIds: mapList(
        row.appliesToIds,
        row.appliesToScope === "products" ? ids.get("products") : row.appliesToScope === "collections" ? ids.get("collections") : undefined,
      ),
      eligibleCustomerIds: mapList(row.eligibleCustomerIds, ids.get("customers")),
    }),
  },
  { key: "discountRedemptions", table: schema.discountRedemptions, scope: { kind: "parent", column: "discountId", parent: "discounts" } },
  { key: "shippingZones", table: schema.shippingZones, scope: { kind: "site", column: "siteId" } },
  { key: "shippingRates", table: schema.shippingRates, scope: { kind: "parent", column: "zoneId", parent: "shippingZones" } },
  { key: "taxSettings", table: schema.taxSettings, scope: { kind: "site", column: "siteId" } },
  {
    key: "digitalAssets",
    table: schema.digitalAssets,
    scope: {
      kind: "custom",
      reason:
        "An asset belongs to the org and may be shared between its stores, so the store's own assets " +
        "and every asset attached to one of its products both travel.",
    },
  },
  { key: "productDigitalAssets", table: schema.productDigitalAssets, scope: { kind: "parent", column: "productId", parent: "products" } },
  { key: "licenceKeys", table: schema.licenceKeys, scope: { kind: "parent", column: "productId", parent: "products" } },
  /**
   * Kept, tokens and all, so a download link a shopper already holds keeps
   * working once the store's domain points at its new home — for a digital
   * product the link is the product.
   */
  { key: "downloadGrants", table: schema.downloadGrants, scope: { kind: "parent", column: "orderId", parent: "orders" } },
  {
    key: "siteDesigns",
    table: schema.siteDesigns,
    scope: { kind: "site", column: "siteId" },
    omit: ["draftHeadHtml", "publishedHeadHtml", "agentLockSessionId", "agentLockExpiresAt"],
    omitReason:
      "Custom scripts never travel with a design (D53) — they are added again with setHeadCode. " +
      "The brand agent's edit lease means nothing on another deployment.",
  },
  { key: "siteDocuments", table: schema.siteDocuments, scope: { kind: "site", column: "siteId" } },
  {
    key: "siteDesignVersions",
    table: schema.siteDesignVersions,
    scope: { kind: "site", column: "siteId" },
    /**
     * A snapshot names its documents by id, and restore matches on that id
     * (`builder.restoreVersion`). A document deleted since that publish has no
     * new id, so it gets a negative one — unique within the snapshot and never
     * a real row, so restoring inserts it afresh exactly as it would have.
     */
    scrub: (row) => {
      // Head code never travels, and a version's snapshot holds the head code of its day.
      const snapshot = row.snapshot as Record<string, unknown> | null;
      if (!snapshot || !("headHtml" in snapshot)) return row;
      const { headHtml: _dropped, ...rest } = snapshot;
      void _dropped;
      return { ...row, snapshot: rest };
    },
    remap: (row, ids) => {
      const snapshot = row.snapshot as { documents?: { id: number }[] } | null;
      if (!snapshot) return row;
      const documents = ids.get("siteDocuments");
      return {
        ...row,
        snapshot: {
          ...snapshot,
          documents: (snapshot.documents ?? []).map((d, i) => ({ ...d, id: documents?.get(d.id) ?? -(i + 1) })),
        },
      };
    },
  },
  { key: "siteSavedBlocks", table: schema.siteSavedBlocks, scope: { kind: "site", column: "siteId" } },
  { key: "siteRedirects", table: schema.siteRedirects, scope: { kind: "site", column: "siteId" } },
  { key: "blogPosts", table: schema.blogPosts, scope: { kind: "site", column: "siteId" } },
];

/**
 * Every table a store export deliberately does not carry, with the reason.
 * A reason is required: "forgot" is the failure this list exists to prevent.
 */
export const LEFT_OUT: Record<string, string> = {
  organizations: "The importing org is chosen on the other side; plan and billing are that deployment's.",
  staff: "People sign in on the new deployment and are invited there.",
  apiTokens: "Credentials. Mint new ones where the store now lives.",
  storefrontKeys: "Credentials. A storefront key opens this deployment's shopper routes only.",
  mfaRecoveryCodes: "Credentials for staff sign-in on this deployment.",
  integrations: "Credentials for third-party accounts; connect them again.",
  actionInvocations: "This deployment's audit log. Its actors and invocation ids mean nothing elsewhere.",
  agentSessions: "Agent conversations on this deployment.",
  agentProposals: "Agent proposals on this deployment.",
  agentUsage: "This deployment's metering of agent tokens.",
  agentTraffic: "Analytics history — large, and not needed to run the store.",
  carts: "Transient: shopper baskets that expire.",
  cartLines: "Transient: shopper baskets that expire.",
  checkoutSessions: "Transient: checkouts in flight. Completed ones are orders, which travel.",
  inventoryReservations: "Transient: stock held for checkouts in flight.",
  downloadEvents: "Access log of downloads on this deployment.",
  usageRecords: "Markii's meter of the merchant's sales, for Markii's own fee.",
  feeAssessments: "Markii's fee invoices to the merchant.",
  t12NetSales: "Markii's fee rollup.",
  dunningNotices: "Markii's billing reminders to the merchant.",
  readinessIssueStates: "Derived per request; recomputed where the store now lives.",
  readinessSnapshots: "Derived per request; recomputed where the store now lives.",
  emailIdentities: "Sending domains are verified with this deployment's mail provider.",
  emailSuppressions: "This deployment's sending reputation, shared across its merchants.",
  emailDeliveries: "This deployment's send log.",
  stripeWebhookEvents: "This deployment's webhook receipts.",
  sitePreviewSessions: "Editor preview links on this deployment.",
  rateLimitCounters: "This deployment's request counters.",
};

/** Every Drizzle table the schema exports, by its export name. */
export function schemaTables(): Map<string, PgTable> {
  const out = new Map<string, PgTable>();
  for (const [name, value] of Object.entries(schema)) {
    if (isPgTable(value)) out.set(name, value);
  }
  return out;
}

function isPgTable(value: unknown): value is PgTable {
  return is(value, PgTable);
}

export const tableSpec = (key: string) => STORE_TABLES.find((t) => t.key === key);
