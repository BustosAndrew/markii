import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export type PaymentProviders = { x402: boolean; stripe: boolean };
export type AddOn = { productId: number; mandatory: boolean };

export const sites = pgTable(
  "sites",
  {
    id: serial("id").primaryKey(),
    /**
     * Owning organization — the root of every tenancy check (§16).
     *
     * Nothing else hangs `orgId` off itself: categories, products, orders, and
     * traffic all reach their org through `siteId`, so there is exactly one
     * place tenancy can be got wrong, and one place to fix it. A denormalized
     * copy on four more tables would be faster and would eventually disagree
     * with this one.
     *
     * `NOT NULL` since migration 0005. A nullable version failed closed — an
     * unassigned site matched no org filter — but "invisible" is a weaker
     * guarantee than "cannot exist".
     */
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    customDomain: text("custom_domain"),
    status: text("status", { enum: ["draft", "live", "paused"] })
      .notNull()
      .default("draft"),
    themeId: text("theme_id", {
      enum: ["studio", "atlas", "noir", "bloom"],
    })
      .notNull()
      .default("studio"),
    indexed: boolean("indexed").notNull().default(true),
    agentDiscovery: boolean("agent_discovery").notNull().default(true),
    purchasesEnabled: boolean("purchases_enabled").notNull().default(true),
    paymentProviders: jsonb("payment_providers")
      .$type<PaymentProviders>()
      .notNull()
      .default({ x402: true, stripe: false }),
    walletAddress: text("wallet_address"),
    googleSiteVerification: text("google_site_verification"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("sites_slug_uq").on(t.slug), index("sites_org_idx").on(t.orgId)],
);

export const categories = pgTable(
  "categories",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    parentId: integer("parent_id").references((): AnyPgColumn => categories.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    imageUrl: text("image_url"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("categories_site_slug_uq").on(t.siteId, t.slug),
    index("categories_site_idx").on(t.siteId),
  ],
);

export const products = pgTable(
  "products",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    categoryId: integer("category_id").references(() => categories.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    priceCents: integer("price_cents").notNull(),
    currency: text("currency").notNull().default("USD"),
    sku: text("sku"),
    stock: integer("stock").notNull().default(0),
    images: jsonb("images").$type<string[]>().notNull().default([]),
    enabled: boolean("enabled").notNull().default(true),
    suggestedProductIds: jsonb("suggested_product_ids").$type<number[]>().notNull().default([]),
    addOns: jsonb("add_ons").$type<AddOn[]>().notNull().default([]),
    /**
     * Digital delivery policy (§18.8). Both null by default, which means
     * unlimited downloads that never expire.
     *
     * **Whether a product is digital is derived, not stored** — it is digital if
     * it has assets or licence keys attached. A separate `isDigital` flag would
     * be a second source of truth that can disagree with the attachments, and
     * the disagreement would surface as a paid order delivering nothing.
     */
    downloadLimit: integer("download_limit"),
    downloadExpiryDays: integer("download_expiry_days"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("products_site_slug_uq").on(t.siteId, t.slug),
    index("products_site_idx").on(t.siteId),
    index("products_category_idx").on(t.categoryId),
  ],
);

export const orders = pgTable(
  "orders",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id").references(() => sites.id, { onDelete: "set null" }),
    productId: integer("product_id").references(() => products.id, { onDelete: "set null" }),
    /**
     * Set for orders placed by a known shopper (§18.3). Null for the existing
     * agent-driven x402 orders, which carry no customer identity — and `set null`
     * on delete so a customer's erasure request does not destroy the merchant's
     * financial record.
     */
    customerId: integer("customer_id").references(() => customers.id, { onDelete: "set null" }),
    quantity: integer("quantity").notNull().default(1),
    status: text("status", { enum: ["pending", "success", "cancel", "failed"] })
      .notNull()
      .default("pending"),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("USDC"),
    provider: text("provider", { enum: ["x402", "stripe"] }).notNull().default("x402"),
    txHash: text("tx_hash"),
    agentUserAgent: text("agent_user_agent").notNull().default(""),
    agentName: text("agent_name").notNull().default("Other"),
    agentWalletAddress: text("agent_wallet_address"),
    /**
     * The money broken out, frozen from the checkout session (§18.7).
     *
     * `amountCents` stays the total and stays named as it is — the v1 `Cents`
     * fields do not get renamed (`CLAUDE.md`). But a refund cannot be metered
     * correctly from a total alone: net sales exclude tax and shipping
     * (`docs/PRICING.md` §4.1), so refunding $50 that contained $4 tax and $5
     * postage must meter −$41, and there is no way to know that after the fact
     * unless the split was written down when the order was created.
     */
    subtotalMinor: integer("subtotal_minor").notNull().default(0),
    discountMinor: integer("discount_minor").notNull().default(0),
    taxMinor: integer("tax_minor").notNull().default(0),
    shippingMinor: integer("shipping_minor").notNull().default(0),
    /** Gross refunded so far, across every refund on this order. */
    refundedMinor: integer("refunded_minor").notNull().default(0),
    /**
     * Where the money stands, kept beside `status` rather than folded into it.
     *
     * `status` is v1's payment outcome and existing code branches on `success`;
     * widening that enum would silently change what every one of those branches
     * means. Refund state is a second axis and gets its own column.
     */
    financialStatus: text("financial_status", {
      enum: ["pending", "paid", "partially_refunded", "refunded", "voided"],
    })
      .notNull()
      .default("pending"),
    /** Manual fulfillment only — Markii does not do fulfillment logistics (`docs/PLAN.md` §3). */
    fulfillmentStatus: text("fulfillment_status", {
      enum: ["unfulfilled", "partially_fulfilled", "fulfilled", "not_required"],
    })
      .notNull()
      .default("unfulfilled"),
    /**
     * Where confirmations and refund notices go. Copied from the checkout
     * session rather than read through `customerId`, because guests have no
     * customer record and a deleted customer must not silently orphan the
     * merchant's ability to contact a buyer about their own order.
     */
    email: text("email"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("orders_site_idx").on(t.siteId),
    index("orders_created_idx").on(t.createdAt),
    index("orders_financial_status_idx").on(t.financialStatus),
    index("orders_fulfillment_status_idx").on(t.fulfillmentStatus),
  ],
);

export const agentTraffic = pgTable(
  "agent_traffic",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    productId: integer("product_id").references(() => products.id, { onDelete: "set null" }),
    path: text("path").notNull(),
    agentUserAgent: text("agent_user_agent").notNull().default(""),
    agentName: text("agent_name").notNull().default("Other"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("traffic_site_idx").on(t.siteId),
    index("traffic_created_idx").on(t.createdAt),
  ],
);

/**
 * Per-org integration credentials.
 *
 * `provider` used to be the primary key, which silently made the table
 * single-tenant: the second organization to connect Stripe would have
 * overwritten the first one's credentials. The key is now `(orgId, provider)`,
 * with a surrogate id so the row can be referenced.
 */
export const integrations = pgTable(
  "integrations",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: ["x402", "google", "stripe"] }).notNull(),
    status: text("status", { enum: ["connected", "not_connected", "error"] })
      .notNull()
      .default("not_connected"),
    config: jsonb("config").$type<Record<string, string>>().notNull().default({}),
    message: text("message"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("integrations_org_provider_uq").on(t.orgId, t.provider),
    index("integrations_org_idx").on(t.orgId),
  ],
);

// ---------------------------------------------------------------------------
// Tenancy — Organization → Stores → Staff (§16)
// ---------------------------------------------------------------------------

export type StaffRole =
  | "owner"
  | "administrator"
  | "catalog_manager"
  | "commerce_manager"
  | "analyst"
  | "developer"
  | "viewer";

export const PLAN_IDS = ["starter", "growth", "scale"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

/**
 * An org owns billing; stores are the existing `sites`. A user may belong to
 * several orgs (agencies build stores for clients), so membership lives in
 * `staff` rather than on the user.
 *
 * Identity comes from Supabase Auth; `owner_id` and `staff.user_id` hold
 * `auth.users.id`. There is deliberately **no foreign key** to `auth.users`:
 * it lives in another schema owned by `supabase_auth_admin`, and coupling our
 * migration chain to Supabase's internal schema is a bad trade for a constraint
 * we can enforce in the action registry.
 */
export const organizations = pgTable(
  "organizations",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    ownerId: text("owner_id").notNull(),
    billingEmail: text("billing_email").notNull(),
    /** Billing currency, ISO 4217. Minor-unit exponent derives from this, never a constant (D31). */
    currency: text("currency").notNull().default("USD"),
    country: text("country").notNull().default("US"),
    planId: text("plan_id", { enum: PLAN_IDS }).notNull().default("starter"),
    /**
     * Add-ons and purchased extras. Entitlements are otherwise **derived** from
     * `planId` in `lib/plans.ts` rather than stored — a denormalized copy drifts
     * from the plan table the moment pricing changes, and then gates disagree.
     */
    addOnAgentOps: boolean("add_on_agent_ops").notNull().default(false),
    addOnChargebackAssist: boolean("add_on_chargeback_assist").notNull().default(false),
    extraStorefronts: integer("extra_storefronts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("organizations_slug_uq").on(t.slug), index("organizations_owner_idx").on(t.ownerId)],
);

export const staff = pgTable(
  "staff",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** `auth.users.id`. Null while the invitation is outstanding. */
    userId: text("user_id"),
    name: text("name").notNull().default(""),
    email: text("email").notNull(),
    role: text("role", {
      enum: [
        "owner",
        "administrator",
        "catalog_manager",
        "commerce_manager",
        "analyst",
        "developer",
        "viewer",
      ],
    }).notNull(),
    /**
     * Per-store scoping: an array of site ids, or `"all"`.
     *
     * The default is written as raw SQL because `.default("all")` emits
     * `DEFAULT 'all'` — a bare token that is not valid JSON, so the CREATE TABLE
     * fails outright. jsonb needs the quotes to be part of the value.
     */
    storeIds: jsonb("store_ids")
      .$type<number[] | "all">()
      .notNull()
      .default(sql`'"all"'::jsonb`),
    status: text("status", { enum: ["active", "invited", "disabled"] })
      .notNull()
      .default("invited"),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("staff_org_email_uq").on(t.orgId, t.email),
    index("staff_user_idx").on(t.userId),
    index("staff_org_idx").on(t.orgId),
  ],
);

// ---------------------------------------------------------------------------
// Commerce core — variants & inventory (§18.1, Phase C)
// ---------------------------------------------------------------------------

/**
 * A product's option axes — "Size", "Color". `values` is ordered; the variant
 * matrix is the cartesian product of every option's values.
 */
export const productOptions = pgTable(
  "product_options",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
    values: jsonb("values").$type<string[]>().notNull().default([]),
  },
  (t) => [
    uniqueIndex("product_options_product_name_uq").on(t.productId, t.name),
    index("product_options_product_idx").on(t.productId),
  ],
);

/**
 * A sellable variant. **Money is in minor units with a `Minor` suffix** (D31) —
 * the exponent comes from the currency, never a hardcoded 100.
 */
export const variants = pgTable(
  "variants",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /** Display title, derived from `optionValues` — "Navy / L". */
    title: text("title").notNull(),
    /** `{ Color: "Navy", Size: "L" }`. The identity of a variant within its product. */
    optionValues: jsonb("option_values").$type<Record<string, string>>().notNull().default({}),
    sku: text("sku"),
    barcode: text("barcode"),
    priceMinor: integer("price_minor").notNull(),
    compareAtMinor: integer("compare_at_minor"),
    costMinor: integer("cost_minor"),
    weightGrams: integer("weight_grams"),
    requiresShipping: boolean("requires_shipping").notNull().default(true),
    taxable: boolean("taxable").notNull().default(true),
    taxCode: text("tax_code"),
    imageId: text("image_id"),
    /** `deny` stops at zero; `continue` allows overselling deliberately. */
    inventoryPolicy: text("inventory_policy", { enum: ["deny", "continue"] })
      .notNull()
      .default("deny"),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("variants_product_idx").on(t.productId),
    // A product cannot have two variants for the same option combination.
    uniqueIndex("variants_product_options_uq").on(t.productId, t.optionValues),
  ],
);

// ---------------------------------------------------------------------------
// Customers (§18.3)
// ---------------------------------------------------------------------------

/**
 * A shopper record, per store.
 *
 * **Not the same thing as a login.** Guest checkout creates a customer with no
 * `authUserId`; an account links one later. Keeping them separate is what lets a
 * merchant have customers before shopper accounts exist at all.
 *
 * **PII rules (§18.3):** never log or prompt-inject these records, support
 * export and deletion, and marketing consent is explicit, timestamped, and never
 * defaulted on.
 *
 * `ordersCount` and `totalSpentMinor` are **derived**, never stored — a
 * denormalised total drifts after the first refund and then the customer list
 * disagrees with the orders list. Same reasoning as inventory levels and plan
 * entitlements.
 */
export const customers = pgTable(
  "customers",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    /**
     * `auth.users.id` when this shopper has an account (D32 — staff and shoppers
     * share one Supabase project). Null for guests. No foreign key: the `auth`
     * schema is owned by `supabase_auth_admin`.
     */
    authUserId: text("auth_user_id"),
    email: text("email").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    phone: text("phone"),
    /** Never defaults to true. Consent is given, not assumed. */
    acceptsMarketing: boolean("accepts_marketing").notNull().default(false),
    /** When consent was given. Null whenever `acceptsMarketing` is false. */
    marketingConsentAt: timestamp("marketing_consent_at", { withTimezone: true }),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One customer record per email per store. The same person shopping at two
    // merchants is two records — they are the merchants' customers, not Markii's.
    uniqueIndex("customers_site_email_uq").on(t.siteId, t.email),
    index("customers_site_idx").on(t.siteId),
    index("customers_auth_user_idx").on(t.authUserId),
  ],
);

export const customerAddresses = pgTable(
  "customer_addresses",
  {
    id: serial("id").primaryKey(),
    customerId: integer("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    name: text("name"),
    line1: text("line1").notNull(),
    line2: text("line2"),
    city: text("city").notNull(),
    province: text("province"),
    postalCode: text("postal_code"),
    /** ISO 3166-1 alpha-2. */
    country: text("country").notNull(),
    phone: text("phone"),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("customer_addresses_customer_idx").on(t.customerId)],
);

/**
 * Merchandising collections (§18.2).
 *
 * **Collections are not categories.** Categories (§3) are catalog taxonomy — where
 * a product lives. Collections are merchandising — how products are grouped for
 * sale ("Summer Sale", "Under £20"). A product has one category and many
 * collections. `docs/API.md` §18.2 is explicit that these must not be merged.
 */
export type CollectionRule = {
  field: "title" | "price" | "stock" | "sku";
  op: "eq" | "contains" | "gt" | "lt" | "starts_with";
  value: string;
};

export const collections = pgTable(
  "collections",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    handle: text("handle").notNull(),
    description: text("description"),
    imageUrl: text("image_url"),
    /** `manual` = an explicit product list; `automated` = whatever matches `rules`. */
    type: text("type", { enum: ["manual", "automated"] })
      .notNull()
      .default("manual"),
    rules: jsonb("rules").$type<CollectionRule[]>().notNull().default([]),
    rulesMatch: text("rules_match", { enum: ["all", "any"] })
      .notNull()
      .default("all"),
    sortOrder: text("sort_order", {
      enum: ["manual", "best_selling", "price_asc", "price_desc", "created_desc"],
    })
      .notNull()
      .default("manual"),
    /** Null until published — an unpublished collection is invisible to storefronts. */
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("collections_site_handle_uq").on(t.siteId, t.handle),
    index("collections_site_idx").on(t.siteId),
  ],
);

/** Manual membership and ordering. Unused by automated collections. */
export const collectionProducts = pgTable(
  "collection_products",
  {
    collectionId: integer("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    productId: integer("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.collectionId, t.productId] }),
    index("collection_products_product_idx").on(t.productId),
  ],
);

/** Stock-holding locations. One default per store until multi-location matters. */
export const locations = pgTable(
  "locations",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("locations_site_idx").on(t.siteId)],
);

/**
 * Inventory as an **append-only ledger**, never a mutable integer (§18.1).
 *
 * A running total you overwrite cannot answer "why is this number 3?", cannot be
 * reconciled against a physical count, and cannot be undone — and reconciliation,
 * audit, and the Agent Ops undo path all depend on being able to. Levels are
 * derived by summing this table.
 *
 * Rows are **never updated or deleted**. A mistake is corrected by appending its
 * inverse, which is also what makes an agent's action reversible.
 */
export const inventoryLedger = pgTable(
  "inventory_ledger",
  {
    id: serial("id").primaryKey(),
    variantId: integer("variant_id")
      .notNull()
      .references(() => variants.id, { onDelete: "cascade" }),
    locationId: integer("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    /** Change to on-hand stock. Negative for sales and shrinkage. */
    availableDelta: integer("available_delta").notNull().default(0),
    /**
     * Change to stock reserved for unpaid orders. Reserved at payment
     * authorization, released on expiry or failure (§18.4).
     */
    committedDelta: integer("committed_delta").notNull().default(0),
    reason: text("reason").notNull(),
    /** Ties the entry to the action that caused it (§22), so undo can find it. */
    invocationId: text("invocation_id"),
    actorType: text("actor_type", { enum: ["user", "agent", "token", "system"] }).notNull(),
    actorId: text("actor_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("inventory_ledger_variant_idx").on(t.variantId),
    index("inventory_ledger_location_idx").on(t.locationId),
    index("inventory_ledger_created_idx").on(t.createdAt),
  ],
);

/**
 * Scoped API / MCP tokens (§16, §22 rule 6): programmatic access carries an
 * explicit role and is **never** a user's session cookie.
 *
 * Only a SHA-256 hash is stored. The plaintext is shown once at creation and is
 * unrecoverable afterwards — a token table that can be read back is a list of
 * live credentials waiting for one bad backup.
 */
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    /** Same role vocabulary as staff: a token can never exceed what a human could do. */
    role: text("role", {
      enum: [
        "owner",
        "administrator",
        "catalog_manager",
        "commerce_manager",
        "analyst",
        "developer",
        "viewer",
      ],
    }).notNull(),
    /** SHA-256 of the plaintext. Unique so a lookup is a single indexed probe. */
    tokenHash: text("token_hash").notNull(),
    /** Leading characters, for telling tokens apart in a list. Not a secret. */
    prefix: text("prefix").notNull(),
    storeIds: jsonb("store_ids").$type<number[] | "all">().notNull().default(sql`'"all"'::jsonb`),
    createdByUserId: text("created_by_user_id"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    /** Soft revoke: the row stays so past audit entries remain attributable. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("api_tokens_hash_uq").on(t.tokenHash),
    index("api_tokens_org_idx").on(t.orgId),
  ],
);

/**
 * Audit trail for the action registry (`docs/API.md` §22 rule 5): every
 * invocation, whether it came from a click, an agent turn, an MCP client, or CI.
 *
 * Dry runs are not recorded — nothing happened. Failures are, because "who tried
 * what and was refused" is the half of an audit log that matters during an
 * incident.
 */
export const actionInvocations = pgTable(
  "action_invocations",
  {
    id: text("id").primaryKey(),
    actionId: text("action_id").notNull(),
    actorType: text("actor_type", { enum: ["user", "agent", "token", "system"] }).notNull(),
    actorId: text("actor_id"),
    /**
     * Nullable **only because organizations do not exist yet**. Phase A makes it
     * `NOT NULL` with a foreign key — an unattributable invocation is not an
     * audit record.
     */
    orgId: text("org_id"),
    riskTier: text("risk_tier", { enum: ["read", "low", "medium", "high"] }).notNull(),
    /** Validated input, post-parse. Actions handling secrets must redact in `redactInput`. */
    input: jsonb("input").$type<unknown>().notNull(),
    result: jsonb("result").$type<unknown>(),
    diff: jsonb("diff").$type<DiffEntry[]>().notNull().default([]),
    ok: boolean("ok").notNull(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    undoable: boolean("undoable").notNull().default(false),
    undoneByInvocationId: text("undone_by_invocation_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("action_invocations_occurred_idx").on(t.occurredAt),
    index("action_invocations_action_idx").on(t.actionId),
    index("action_invocations_actor_idx").on(t.actorType, t.actorId),
  ],
);

// ---------------------------------------------------------------------------
// Cart & checkout (§18.4)
// ---------------------------------------------------------------------------

/**
 * A shopper's cart.
 *
 * **No totals are stored here.** `docs/API.md` §18.4 returns `subtotalMinor`,
 * `taxMinor`, `totalMinor` and friends on the cart, but they are computed on
 * every read from the current catalog — see `lib/commerce/pricing.ts`. A stored
 * total is a number someone will eventually trust: it goes stale the moment a
 * merchant edits a price, and the whole non-negotiable rule of this section is
 * that money is recomputed server-side and never taken on faith.
 *
 * The `token` is the shopper's only credential for this cart, so it is a random
 * 256-bit value rather than the row id. A guessable cart id is someone else's
 * address and email.
 */
export const carts = pgTable(
  "carts",
  {
    id: serial("id").primaryKey(),
    /** Unguessable bearer token — this *is* the shopper's authentication. */
    token: text("token").notNull(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    /** Set once the shopper identifies themselves; guests stay null (§18.3). */
    customerId: integer("customer_id").references(() => customers.id, { onDelete: "set null" }),
    email: text("email"),
    /**
     * Codes as typed by the shopper. Whether they are *valid* is decided at
     * pricing time, not here — discounts are §18.5 and do not exist yet, so an
     * accepted code would be a promise the checkout cannot keep.
     */
    discountCodes: jsonb("discount_codes").$type<string[]>().notNull().default([]),
    shippingAddress: jsonb("shipping_address").$type<CartAddress | null>(),
    shippingRateId: text("shipping_rate_id"),
    /**
     * Fixed by the first line added. Mixing currencies in one cart is refused
     * rather than silently converted — an invented FX rate is a fabricated
     * price.
     */
    currency: text("currency").notNull().default("USD"),
    status: text("status", { enum: ["open", "abandoned", "converted"] })
      .notNull()
      .default("open"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("carts_token_uq").on(t.token),
    index("carts_site_idx").on(t.siteId),
    index("carts_customer_idx").on(t.customerId),
    index("carts_status_expires_idx").on(t.status, t.expiresAt),
  ],
);

/**
 * A line in a cart.
 *
 * `variantId` is nullable and `productId` is not, which is the honest shape of a
 * catalog mid-migration: variants arrived in §18.1, but every product predating
 * them still sells at the product's own price and stock. Requiring a variant
 * would break every existing product and the live x402 path. Price resolution
 * prefers the variant and falls back to the product — in one place,
 * `lib/commerce/pricing.ts`, so the fallback cannot drift.
 */
export const cartLines = pgTable(
  "cart_lines",
  {
    id: serial("id").primaryKey(),
    cartId: integer("cart_id")
      .notNull()
      .references(() => carts.id, { onDelete: "cascade" }),
    productId: integer("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    variantId: integer("variant_id").references(() => variants.id, { onDelete: "cascade" }),
    quantity: integer("quantity").notNull().default(1),
    /** Product ids of chosen add-ons, matching `products.addOns[].productId`. */
    addOnIds: jsonb("add_on_ids").$type<number[]>().notNull().default([]),
    /**
     * What the item cost when it went in the cart. **Never used to charge** —
     * it exists so the shopper can be *told* the price changed under them.
     * Recomputation is authoritative; this is the disclosure.
     */
    unitPriceMinorAtAdd: integer("unit_price_minor_at_add").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("cart_lines_cart_idx").on(t.cartId),
    // One line per product/variant pair — adding the same item twice raises the
    // quantity instead of growing a second line the shopper has to notice.
    uniqueIndex("cart_lines_cart_item_uq").on(t.cartId, t.productId, t.variantId),
  ],
);

/**
 * A checkout attempt: the point where a cart's prices stop moving.
 *
 * The amounts here are a **frozen quote** — the numbers the shopper was shown
 * and agreed to pay. They are computed server-side from the catalog at the
 * moment the session opens and are never accepted from a request body. If the
 * catalog changes afterwards, the session is what gets honoured or invalidated;
 * the cart is not silently repriced under an authorized payment.
 */
export const checkoutSessions = pgTable(
  "checkout_sessions",
  {
    id: text("id").primaryKey(),
    cartId: integer("cart_id")
      .notNull()
      .references(() => carts.id, { onDelete: "cascade" }),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    customerId: integer("customer_id").references(() => customers.id, { onDelete: "set null" }),
    email: text("email"),
    /**
     * Peer payment rails, not a hierarchy. x402 is the one that works
     * end-to-end today; that makes it the default demo path, not the identity.
     */
    provider: text("provider", { enum: ["stripe", "x402"] }).notNull(),
    status: text("status", {
      enum: ["requires_payment", "processing", "completed", "failed", "expired"],
    })
      .notNull()
      .default("requires_payment"),
    subtotalMinor: integer("subtotal_minor").notNull(),
    discountMinor: integer("discount_minor").notNull().default(0),
    taxMinor: integer("tax_minor").notNull().default(0),
    shippingMinor: integer("shipping_minor").notNull().default(0),
    totalMinor: integer("total_minor").notNull(),
    currency: text("currency").notNull(),
    shippingAddress: jsonb("shipping_address").$type<CartAddress | null>(),
    /**
     * Which discounts made up `discountMinor`, frozen with the quote (§18.5).
     *
     * Re-evaluating at completion would be wrong twice over: a code that hit its
     * limit in between would silently raise the price the shopper already
     * agreed to, and the redemption records would not match the money.
     */
    appliedDiscounts: jsonb("applied_discounts")
      .$type<{ discountId: number; code: string | null; amountMinor: number }[]>()
      .notNull()
      .default([]),
    /**
     * The priced lines, frozen with the quote — what becomes `order_lines` on
     * completion (§18.7).
     *
     * Rebuilding lines from the catalog at completion instead would let a price
     * edit made during the 15-minute reservation window produce line totals
     * that do not sum to `subtotalMinor`. The order would then charge one
     * amount and itemise another, and a refund computed from the lines would
     * return the wrong money. The session is where prices stop moving; the line
     * detail has to stop with them.
     */
    lineSnapshot: jsonb("line_snapshot")
      .$type<CheckoutLineSnapshot[]>()
      .notNull()
      .default([]),
    /** Stripe PaymentIntent id, or the x402 transaction hash. */
    paymentReference: text("payment_reference"),
    /** Set on completion. The session is the only thing that may create it. */
    orderId: integer("order_id").references(() => orders.id, { onDelete: "set null" }),
    failureReason: text("failure_reason"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("checkout_sessions_cart_idx").on(t.cartId),
    index("checkout_sessions_site_idx").on(t.siteId),
    index("checkout_sessions_status_expires_idx").on(t.status, t.expiresAt),
    // A payment reference settles exactly one checkout. This is the database
    // half of replay protection: two concurrent completions of the same Stripe
    // intent or the same on-chain transaction cannot both create an order.
    uniqueIndex("checkout_sessions_payment_ref_uq").on(t.paymentReference),
  ],
);

/**
 * Stock held for an in-flight checkout (§18.4: "reserved at payment
 * authorization, released on expiry or failure").
 *
 * The `inventory_ledger` still records every movement — this table records
 * *state*, which an append-only ledger cannot express without scanning it: what
 * is currently held, by which session, and when it goes stale. Release is then
 * an indexed lookup rather than a replay of history, and the expiry sweeper has
 * something to sweep.
 */
export const inventoryReservations = pgTable(
  "inventory_reservations",
  {
    id: serial("id").primaryKey(),
    checkoutSessionId: text("checkout_session_id")
      .notNull()
      .references(() => checkoutSessions.id, { onDelete: "cascade" }),
    variantId: integer("variant_id")
      .notNull()
      .references(() => variants.id, { onDelete: "cascade" }),
    locationId: integer("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    quantity: integer("quantity").notNull(),
    /** `consumed` means the sale happened and the stock actually left. */
    status: text("status", { enum: ["held", "released", "consumed"] })
      .notNull()
      .default("held"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    index("inventory_reservations_session_idx").on(t.checkoutSessionId),
    index("inventory_reservations_variant_idx").on(t.variantId),
    index("inventory_reservations_sweep_idx").on(t.status, t.expiresAt),
  ],
);

/**
 * Immutable metering events for the threshold fee engine (§17).
 *
 * Written **at event time and never derived later**, which is why the table
 * lands with checkout rather than with billing: a sale that completes before
 * this row exists is a sale the threshold meter can never learn about. Rows are
 * never updated — a refund is its own row with a negative amount.
 */
export const usageRecords = pgTable(
  "usage_records",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    siteId: integer("site_id").references(() => sites.id, { onDelete: "set null" }),
    orderId: integer("order_id").references(() => orders.id, { onDelete: "set null" }),
    type: text("type", { enum: ["sale", "refund", "chargeback_lost"] }).notNull(),
    /** As transacted. Negative for refunds and lost chargebacks. */
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    /**
     * The same money in the org's billing currency. **Null when the rate is not
     * known** — no FX provider is wired, and inventing a rate would corrupt the
     * threshold meter, which is a billing decision about real money. A null here
     * is a visible gap the meter must report, not a zero it can quietly sum.
     */
    convertedMinor: integer("converted_minor"),
    fxRate: numeric("fx_rate", { precision: 18, scale: 8 }),
    /** Test never counts toward the threshold (§17, and the no-fabrication rule). */
    environment: text("environment", { enum: ["test", "production"] }).notNull(),
    /**
     * The idempotency key for this metering event — `sale:{orderId}`,
     * `refund:{refundId}`, `chargeback_lost:{disputeId}`.
     *
     * This replaced a unique key on `(orderId, type)`, which was right while a
     * sale was the only event and wrong the moment §18.7 allowed **partial**
     * refunds: two refunds against one order are two genuine events, and that
     * key would have silently swallowed the second one, permanently
     * over-metering the merchant by the amount it dropped. Keying on the thing
     * that caused the event keeps retries idempotent without conflating
     * distinct ones.
     */
    dedupeKey: text("dedupe_key").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("usage_records_org_occurred_idx").on(t.orgId, t.occurredAt),
    index("usage_records_order_idx").on(t.orderId),
    // The completion path is retried by Stripe webhooks and by agents, and
    // double-counting a sale overcharges a merchant at the threshold.
    uniqueIndex("usage_records_dedupe_uq").on(t.dedupeKey),
  ],
);

// ---------------------------------------------------------------------------
// Discounts (§18.5)
// ---------------------------------------------------------------------------

/**
 * A discount — either code-entered or automatic.
 *
 * `usedCount` is **derived** from `discount_redemptions`, never stored, for the
 * same reason inventory levels and customer totals are: a counter you increment
 * drifts the first time a redemption is reversed, and a usage limit enforced
 * against a drifted counter either blocks valid customers or lets a
 * single-use code run forever.
 */
export const discounts = pgTable(
  "discounts",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    /** Null means automatic — applied without the shopper typing anything. */
    code: text("code"),
    title: text("title").notNull(),
    type: text("type", {
      enum: ["percentage", "fixed", "free_shipping"],
    }).notNull(),
    /** Basis points for `percentage`: 1500 is 15%. Integer, never a float (D31). */
    percentageBps: integer("percentage_bps"),
    /** Minor units for `fixed`. */
    valueMinor: integer("value_minor"),
    /** `order` discounts everything; `products`/`collections` narrow it by id. */
    appliesToScope: text("applies_to_scope", { enum: ["order", "products", "collections"] })
      .notNull()
      .default("order"),
    appliesToIds: jsonb("applies_to_ids").$type<number[]>().notNull().default([]),
    minimumSubtotalMinor: integer("minimum_subtotal_minor"),
    /** `specific` restricts to `eligibleCustomerIds`. */
    customerEligibility: text("customer_eligibility", { enum: ["all", "specific"] })
      .notNull()
      .default("all"),
    eligibleCustomerIds: jsonb("eligible_customer_ids").$type<number[]>().notNull().default([]),
    /** Null means unlimited. */
    usageLimit: integer("usage_limit"),
    usageLimitPerCustomer: integer("usage_limit_per_customer"),
    /**
     * Whether this may stack with another discount of each kind. Defaults are
     * all false: stacking is how a store accidentally gives away 70% off, so it
     * is opted into deliberately rather than inherited.
     */
    combinesWithProduct: boolean("combines_with_product").notNull().default(false),
    combinesWithOrder: boolean("combines_with_order").notNull().default(false),
    combinesWithShipping: boolean("combines_with_shipping").notNull().default(false),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    /** Merchant's on/off switch. `status` is derived from this plus the dates. */
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("discounts_site_idx").on(t.siteId),
    // Codes are matched case-insensitively by upper-casing on write, so this
    // unique index is what actually prevents two codes differing only in case.
    uniqueIndex("discounts_site_code_uq").on(t.siteId, t.code),
  ],
);

/**
 * One use of a discount on one order. Append-only.
 *
 * This table *is* the usage count, and the unique key on `(discountId, orderId)`
 * is what makes a retried checkout completion unable to burn a single-use code
 * twice.
 */
export const discountRedemptions = pgTable(
  "discount_redemptions",
  {
    id: serial("id").primaryKey(),
    discountId: integer("discount_id")
      .notNull()
      .references(() => discounts.id, { onDelete: "cascade" }),
    orderId: integer("order_id").references(() => orders.id, { onDelete: "set null" }),
    customerId: integer("customer_id").references(() => customers.id, { onDelete: "set null" }),
    /** What it actually took off, for the merchant's records and for net sales. */
    amountMinor: integer("amount_minor").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("discount_redemptions_discount_idx").on(t.discountId),
    index("discount_redemptions_customer_idx").on(t.customerId),
    uniqueIndex("discount_redemptions_discount_order_uq").on(t.discountId, t.orderId),
  ],
);

// ---------------------------------------------------------------------------
// Shipping & tax rates (§18.6)
// ---------------------------------------------------------------------------

/**
 * A shipping zone: the set of destinations one group of rates applies to.
 *
 * This is rate **configuration**, not logistics. Carrier rate shopping, label
 * purchase, and tracking sync are permanently out of scope (`docs/PLAN.md` §3) —
 * Markii does everything Shopify does *except fulfillment logistics*.
 */
export const shippingZones = pgTable(
  "shipping_zones",
  {
    id: serial("id").primaryKey(),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** ISO 3166-1 alpha-2, uppercase. Empty means "everywhere not matched by another zone". */
    countries: jsonb("countries").$type<string[]>().notNull().default([]),
    /**
     * Optional province/state codes narrowing the countries above. A zone with
     * provinces is more specific than one without, and wins when both match —
     * otherwise "California" and "United States" would be ambiguous.
     */
    provinces: jsonb("provinces").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("shipping_zones_site_idx").on(t.siteId)],
);

/**
 * A rate a shopper can choose within a zone.
 *
 * Conditions are stored as explicit bounds rather than a rule expression: a
 * merchant setting up shipping is not writing a query, and a bounded numeric
 * range is something the pricing code can evaluate without an interpreter.
 */
export const shippingRates = pgTable(
  "shipping_rates",
  {
    id: serial("id").primaryKey(),
    zoneId: integer("zone_id")
      .notNull()
      .references(() => shippingZones.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    /**
     * `free_over_threshold` is `price_based` with a zero price, but merchants
     * think of it as its own thing and mislabelling it in the UI is how a store
     * ends up giving away shipping it meant to charge for.
     */
    type: text("type", {
      enum: ["flat", "weight_based", "price_based", "free_over_threshold"],
    }).notNull(),
    priceMinor: integer("price_minor").notNull().default(0),
    /** Inclusive lower / exclusive upper bounds. Null means unbounded. */
    minWeightGrams: integer("min_weight_grams"),
    maxWeightGrams: integer("max_weight_grams"),
    minSubtotalMinor: integer("min_subtotal_minor"),
    maxSubtotalMinor: integer("max_subtotal_minor"),
    enabled: boolean("enabled").notNull().default(true),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("shipping_rates_zone_idx").on(t.zoneId)],
);

/**
 * Per-store tax configuration (§18.6).
 *
 * **Per store rather than per org**, even though tax registration is a property
 * of a legal entity: `pricesIncludeTax` is a storefront presentation choice a
 * merchant makes differently for a UK shop and a US one, and launch is one
 * currency per store anyway (G2). The org's country is the default.
 *
 * **Markii never gives tax advice** (`docs/DECISIONS.md` G2) — this stores what
 * the merchant told us and applies it. It does not decide what they owe.
 */
export const taxSettings = pgTable(
  "tax_settings",
  {
    siteId: integer("site_id")
      .primaryKey()
      .references(() => sites.id, { onDelete: "cascade" }),
    /**
     * `none` — no tax line is added, prices stand as listed.
     * `manual` — the merchant's own rates, below. Fine for a single jurisdiction.
     * `stripe` — Stripe Tax (the decided provider, `docs/DECISIONS.md` G3).
     */
    provider: text("provider", { enum: ["none", "manual", "stripe"] })
      .notNull()
      .default("none"),
    /**
     * When true the listed price already contains tax, so no separate line is
     * added and the tax figure is shown as *included*. This is the assumption
     * §18.4 has been running on by default (D33); here it becomes explicit.
     */
    pricesIncludeTax: boolean("prices_include_tax").notNull().default(true),
    /** Manual rates by destination: `{ country, province?, rateBps, name }`. */
    manualRates: jsonb("manual_rates").$type<ManualTaxRate[]>().notNull().default([]),
    /** Applied to products with no `taxCode` of their own. Stripe Tax only. */
    defaultTaxCode: text("default_tax_code"),
    /** Where the merchant says they are registered. Displayed, never enforced. */
    registrations: jsonb("registrations").$type<string[]>().notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

// ---------------------------------------------------------------------------
// Order operations (§18.7)
// ---------------------------------------------------------------------------

/**
 * What was actually sold, frozen at completion.
 *
 * Until now an order pointed at one `productId` and carried a total — a v1
 * shape from when a sale was one agent buying one thing. Refunds are what make
 * that unworkable: "refund two of the three mugs and restock them" needs to
 * know which line, at what price, from which location, and how much of the
 * order's discount and tax belonged to it.
 *
 * Everything here is a **snapshot**, not a join. The product may later be
 * renamed, repriced, or deleted; what the shopper bought and paid does not
 * change with it, and a merchant reading a two-year-old order should see the
 * order, not today's catalog.
 */
export const orderLines = pgTable(
  "order_lines",
  {
    id: serial("id").primaryKey(),
    orderId: integer("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    /** `set null`: deleting a product must not destroy the financial record. */
    productId: integer("product_id").references(() => products.id, { onDelete: "set null" }),
    variantId: integer("variant_id").references(() => variants.id, { onDelete: "set null" }),
    /** Snapshots — the catalog is free to change underneath. */
    title: text("title").notNull(),
    variantTitle: text("variant_title"),
    sku: text("sku"),
    quantity: integer("quantity").notNull(),
    /** One unit, excluding add-ons. Add-ons are in `subtotalMinor` and listed below. */
    unitPriceMinor: integer("unit_price_minor").notNull(),
    /** `(unit + add-ons) × quantity`, matching `PricedLine.lineTotalMinor`. */
    subtotalMinor: integer("subtotal_minor").notNull(),
    /**
     * This line's share of the order's discount and tax.
     *
     * Both are **allocations**, not independently calculated figures: discounts
     * apply to an order or a set of products, and tax to a base, so neither has
     * a natural per-line value. They are split in proportion to line subtotal
     * with the rounding remainder given to the largest line, so the parts sum
     * exactly to the order's own totals — an allocation that does not add up is
     * a refund that returns the wrong money.
     */
    discountMinor: integer("discount_minor").notNull().default(0),
    taxMinor: integer("tax_minor").notNull().default(0),
    /** `subtotal − discount + tax`. Shipping is order-level and never allocated. */
    totalMinor: integer("total_minor").notNull(),
    addOns: jsonb("add_ons")
      .$type<{ productId: number; name: string; unitPriceMinor: number }[]>()
      .notNull()
      .default([]),
    /** Units refunded so far. Derived state, but the cap a refund is checked against. */
    quantityRefunded: integer("quantity_refunded").notNull().default(0),
    quantityFulfilled: integer("quantity_fulfilled").notNull().default(0),
    /**
     * Where the stock left from, so a restock puts it back in the same place.
     * Null for variant-less products, which have no ledger to return it to.
     */
    locationId: integer("location_id").references(() => locations.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("order_lines_order_idx").on(t.orderId),
    index("order_lines_product_idx").on(t.productId),
  ],
);

/**
 * A refund against an order (§18.7).
 *
 * **Recording a refund and moving the money are separate facts**, and this
 * table keeps them separate on purpose. Markii never holds merchant funds
 * (`docs/PRICING.md`), the card rail is not wired, and x402/USDC settlement is
 * irreversible with no chargeback path (§20) — so for most refunds today the
 * merchant is the one who actually sends the money back. Writing `succeeded`
 * because a row was inserted would be a success toast for an unwired action.
 *
 * `method` says who moved it: `manual` is the merchant reporting a refund they
 * issued themselves; `processor` is Markii asking a rail, which currently
 * refuses rather than pretending.
 */
export const refunds = pgTable(
  "refunds",
  {
    id: serial("id").primaryKey(),
    orderId: integer("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    /** The money, split the same way the order is, so metering can exclude tax and shipping. */
    subtotalMinor: integer("subtotal_minor").notNull().default(0),
    discountMinor: integer("discount_minor").notNull().default(0),
    taxMinor: integer("tax_minor").notNull().default(0),
    shippingMinor: integer("shipping_minor").notNull().default(0),
    /** What the shopper gets back: `subtotal − discount + tax + shipping`. */
    amountMinor: integer("amount_minor").notNull(),
    /**
     * The negative that reaches the meter: `subtotal − discount` (D36). Stored
     * rather than recomputed so the usage record and the refund can never
     * disagree about what was metered.
     */
    netSalesMinor: integer("net_sales_minor").notNull(),
    currency: text("currency").notNull(),
    reason: text("reason", {
      enum: ["requested_by_customer", "duplicate", "fraudulent", "item_unavailable", "other"],
    })
      .notNull()
      .default("requested_by_customer"),
    note: text("note"),
    restock: boolean("restock").notNull().default(true),
    /** `manual` — the merchant sent the money. `processor` — a rail did. */
    method: text("method", { enum: ["manual", "processor"] })
      .notNull()
      .default("manual"),
    /** Named explicitly wherever a payment appears (`CLAUDE.md`, rails are peers). */
    rail: text("rail", { enum: ["stripe", "x402", "manual", "external"] }).notNull(),
    /** Stripe refund id, or the on-chain hash of the merchant's return transfer. */
    processorReference: text("processor_reference"),
    actorType: text("actor_type", { enum: ["user", "agent", "token", "system"] }).notNull(),
    actorId: text("actor_id"),
    /** Ties the refund to the invocation that made it (§22). */
    invocationId: text("invocation_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("refunds_order_idx").on(t.orderId)],
);

/** Which units of which line a refund covered. Absent for a shipping-only refund. */
export const refundLines = pgTable(
  "refund_lines",
  {
    id: serial("id").primaryKey(),
    refundId: integer("refund_id")
      .notNull()
      .references(() => refunds.id, { onDelete: "cascade" }),
    orderLineId: integer("order_line_id")
      .notNull()
      .references(() => orderLines.id, { onDelete: "cascade" }),
    quantity: integer("quantity").notNull(),
    /** This line's share of the refund, split exactly as the order line was. */
    subtotalMinor: integer("subtotal_minor").notNull(),
    discountMinor: integer("discount_minor").notNull().default(0),
    taxMinor: integer("tax_minor").notNull().default(0),
    restocked: boolean("restocked").notNull().default(false),
  },
  (t) => [
    index("refund_lines_refund_idx").on(t.refundId),
    index("refund_lines_order_line_idx").on(t.orderLineId),
  ],
);

/**
 * A shipment the merchant recorded by hand (§18.7 — **manual only**).
 *
 * Carrier rate shopping, label purchase, and tracking sync are permanently out
 * of scope (`docs/PLAN.md` §3). `carrier` is therefore free text the merchant
 * typed, and `trackingUrl` is whatever they pasted — Markii does not verify
 * either, and the UI must not present them as confirmed by a carrier.
 */
export const fulfillments = pgTable(
  "fulfillments",
  {
    id: serial("id").primaryKey(),
    orderId: integer("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["pending", "shipped", "delivered", "cancelled"] })
      .notNull()
      .default("shipped"),
    trackingNumber: text("tracking_number"),
    carrier: text("carrier"),
    trackingUrl: text("tracking_url"),
    /** Whether the shopper was emailed. False is a real state, not a failure. */
    notifiedCustomer: boolean("notified_customer").notNull().default(false),
    note: text("note"),
    actorType: text("actor_type", { enum: ["user", "agent", "token", "system"] }).notNull(),
    actorId: text("actor_id"),
    invocationId: text("invocation_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("fulfillments_order_idx").on(t.orderId)],
);

/** Which units of which line went in a shipment. */
export const fulfillmentLines = pgTable(
  "fulfillment_lines",
  {
    id: serial("id").primaryKey(),
    fulfillmentId: integer("fulfillment_id")
      .notNull()
      .references(() => fulfillments.id, { onDelete: "cascade" }),
    orderLineId: integer("order_line_id")
      .notNull()
      .references(() => orderLines.id, { onDelete: "cascade" }),
    quantity: integer("quantity").notNull(),
  },
  (t) => [
    index("fulfillment_lines_fulfillment_idx").on(t.fulfillmentId),
    index("fulfillment_lines_order_line_idx").on(t.orderLineId),
  ],
);

/**
 * The order timeline: everything that happened, append-only.
 *
 * Merchant notes live here too rather than in a `notes` column, because a note
 * is an event with an author and a time — a single overwritable text field
 * loses who said what and when, which is exactly what anyone opening a disputed
 * order needs.
 *
 * `visibility` marks whether an entry was shown to the shopper. An internal
 * note leaking into a customer-facing timeline is a support incident.
 */
export const orderEvents = pgTable(
  "order_events",
  {
    id: serial("id").primaryKey(),
    orderId: integer("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    type: text("type", {
      enum: [
        "placed",
        "note",
        "refunded",
        "cancelled",
        "fulfilled",
        "fulfillment_updated",
        "email_sent",
        "email_failed",
      ],
    }).notNull(),
    /** One line, written to be read by a merchant. */
    message: text("message").notNull(),
    /** Structured detail for the UI — amounts, ids, tracking numbers. */
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    visibility: text("visibility", { enum: ["internal", "customer"] })
      .notNull()
      .default("internal"),
    actorType: text("actor_type", { enum: ["user", "agent", "token", "system"] }).notNull(),
    actorId: text("actor_id"),
    /** Display name captured at write time — staff leave, the timeline stays readable. */
    actorLabel: text("actor_label"),
    invocationId: text("invocation_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("order_events_order_created_idx").on(t.orderId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Digital delivery (§18.8) — the D5 beachhead
// ---------------------------------------------------------------------------

/**
 * A file a merchant sells.
 *
 * Stored in the **private** `digital-assets` bucket and reachable only through a
 * signed URL minted per download. `storagePath` is the object key, never a URL:
 * a durable address stored in a row is one leak away from being the product.
 *
 * `sizeBytes` is recorded at upload because it is what the G5 storage quota
 * meters, and Storage cannot be asked cheaply for a per-org total afterwards.
 */
export const digitalAssets = pgTable(
  "digital_assets",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    siteId: integer("site_id").references(() => sites.id, { onDelete: "set null" }),
    /** Object key in the private bucket. Not a URL, and never rendered as one. */
    storagePath: text("storage_path").notNull(),
    /** What the shopper's browser saves it as. */
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    /** Merchant-facing label, when the filename is not descriptive enough. */
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("digital_assets_org_idx").on(t.orgId),
    index("digital_assets_site_idx").on(t.siteId),
    uniqueIndex("digital_assets_path_uq").on(t.storagePath),
  ],
);

/**
 * Which assets a product (or one of its variants) delivers.
 *
 * A nullable `variantId` means "every variant of this product". That is the
 * common case — a single ebook — and requiring a row per variant would make the
 * simple setup the fiddly one.
 */
export const productDigitalAssets = pgTable(
  "product_digital_assets",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /** Null: delivered for any variant. Set: only that one. */
    variantId: integer("variant_id").references(() => variants.id, { onDelete: "cascade" }),
    assetId: integer("asset_id")
      .notNull()
      .references(() => digitalAssets.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    index("product_digital_assets_product_idx").on(t.productId),
    index("product_digital_assets_asset_idx").on(t.assetId),
    uniqueIndex("product_digital_assets_uq").on(t.productId, t.variantId, t.assetId),
  ],
);

/**
 * A shopper's right to download something they paid for.
 *
 * **The grant is the entitlement, not the link.** A signed URL is minted from a
 * grant on each redemption and lives minutes; the grant lives as long as the
 * merchant's policy says. That separation is what makes a download limit
 * enforceable at all — a URL, once issued, cannot be counted or revoked.
 *
 * `token` is the shopper's only credential, so it is a random 256-bit value
 * rather than the row id. Guests have no account; the emailed link *is* their
 * access, and a guessable one is someone else's purchase.
 */
export const downloadGrants = pgTable(
  "download_grants",
  {
    id: serial("id").primaryKey(),
    /** Unguessable bearer token — this *is* the shopper's authentication. */
    token: text("token").notNull(),
    orderId: integer("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    orderLineId: integer("order_line_id").references(() => orderLines.id, {
      onDelete: "set null",
    }),
    assetId: integer("asset_id")
      .notNull()
      .references(() => digitalAssets.id, { onDelete: "cascade" }),
    customerId: integer("customer_id").references(() => customers.id, { onDelete: "set null" }),
    email: text("email"),
    /**
     * Null means unlimited. A limit is a merchant's anti-sharing choice, not a
     * default — silently capping a legitimate buyer at some invented number is
     * worse than not capping at all.
     */
    downloadLimit: integer("download_limit"),
    downloadCount: integer("download_count").notNull().default(0),
    /** Null means the grant does not expire. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /**
     * Set when a merchant withdraws access — after a refund, or a chargeback.
     * Soft, so the record of what was bought and downloaded survives.
     */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
    lastDownloadedAt: timestamp("last_downloaded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("download_grants_token_uq").on(t.token),
    index("download_grants_order_idx").on(t.orderId),
    index("download_grants_asset_idx").on(t.assetId),
    index("download_grants_customer_idx").on(t.customerId),
  ],
);

/**
 * One redemption of a grant. Append-only.
 *
 * This table is both the audit trail and the **egress meter** (G5): bytes
 * delivered is what costs money, and it cannot be recovered later because the
 * transfer happens between the shopper and Supabase without touching us.
 *
 * `bytes` is the asset's recorded size, and the honest caveat is that this
 * counts bytes we **authorised**, not bytes that arrived — a cancelled download
 * still books a full file. Measuring the truth would mean proxying the transfer,
 * which G5 forbids for the much larger cost it would add. The over-count is
 * stated rather than hidden, and it errs against Markii, never the merchant.
 */
export const downloadEvents = pgTable(
  "download_events",
  {
    id: serial("id").primaryKey(),
    grantId: integer("grant_id")
      .notNull()
      .references(() => downloadGrants.id, { onDelete: "cascade" }),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Authorised, not confirmed delivered. See the note above. */
    bytes: integer("bytes").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("download_events_grant_idx").on(t.grantId),
    // The shape the G5 egress rollup reads: one org, one month.
    index("download_events_org_created_idx").on(t.orgId, t.createdAt),
  ],
);

/**
 * A licence key issued for a purchase.
 *
 * Keys are **pre-loaded by the merchant**, never generated by Markii. A
 * generated key is meaningless unless the merchant's own software can validate
 * it, and inventing a format would either collide with their scheme or hand a
 * buyer a string that unlocks nothing. So a product has a pool, and a sale
 * claims from it.
 *
 * That makes exhaustion a real state the merchant must see coming: `assignedAt`
 * null is unclaimed, and a product whose pool is empty cannot fulfil its next
 * order.
 */
export const licenceKeys = pgTable(
  "licence_keys",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    productId: integer("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    variantId: integer("variant_id").references(() => variants.id, { onDelete: "cascade" }),
    /** The key itself, exactly as the merchant supplied it. */
    key: text("key").notNull(),
    /** Null until a sale claims it. */
    orderId: integer("order_id").references(() => orders.id, { onDelete: "set null" }),
    orderLineId: integer("order_line_id").references(() => orderLines.id, {
      onDelete: "set null",
    }),
    customerId: integer("customer_id").references(() => customers.id, { onDelete: "set null" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }),
    /** Returned to the pool after a refund, so the merchant does not lose stock. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("licence_keys_product_idx").on(t.productId),
    index("licence_keys_order_idx").on(t.orderId),
    // Claiming is "the first unassigned key for this product", so that lookup
    // must be an index seek rather than a scan of an exhausted pool.
    index("licence_keys_pool_idx").on(t.productId, t.assignedAt),
    uniqueIndex("licence_keys_org_key_uq").on(t.orgId, t.key),
  ],
);

// ---------------------------------------------------------------------------
// Billing — threshold fee assessments (§17, `docs/PRICING.md` §4)
// ---------------------------------------------------------------------------

/**
 * What a merchant was assessed for one closed billing period. Immutable.
 *
 * The meter recomputes freely from the usage ledger, but **what was actually
 * charged must never move afterwards**. Once a period closes, the numbers on it
 * are what the merchant was told and what an invoice cites; a late-arriving
 * usage record adjusts the *next* period as a credit (§4.4), it does not
 * silently rewrite a settled one.
 *
 * `workings` stores the inputs to the marginal formula, so "why this number"
 * has an exact answer from the row itself rather than a recomputation that may
 * no longer agree.
 */
export const feeAssessments = pgTable(
  "fee_assessments",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** UTC period bounds. Calendar months until Stripe defines real ones. */
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    /** The plan in force at close — thresholds change, assessments must not. */
    planId: text("plan_id", { enum: PLAN_IDS }).notNull(),
    thresholdMinor: integer("threshold_minor").notNull(),
    overageRateBps: integer("overage_rate_bps").notNull(),
    t12NetSalesMinor: integer("t12_net_sales_minor").notNull(),
    periodNetSalesMinor: integer("period_net_sales_minor").notNull(),
    billableMinor: integer("billable_minor").notNull(),
    feeMinor: integer("fee_minor").notNull(),
    currency: text("currency").notNull(),
    /** The formula's inputs, for an invoice line that shows its own arithmetic. */
    workings: jsonb("workings").$type<Record<string, unknown>>().notNull().default({}),
    /**
     * Whether this was actually billed. False while Stripe is unwired — the
     * assessment is a measurement, and calling it an invoice would be a claim
     * that money changed hands.
     */
    invoiced: boolean("invoiced").notNull().default(false),
    /** How many usage records fed it, for reconciliation against a later recount. */
    recordCount: integer("record_count").notNull().default(0),
    closedAt: timestamp("closed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One assessment per org per period. Closing twice must not double-bill.
    uniqueIndex("fee_assessments_period_uq").on(t.orgId, t.periodStart),
    index("fee_assessments_org_idx").on(t.orgId, t.periodStart),
  ],
);

// ---------------------------------------------------------------------------
// Agent readiness (§9)
// ---------------------------------------------------------------------------

/**
 * A merchant's decision about one readiness issue.
 *
 * **Issues themselves are not stored.** They are recomputed from the catalog on
 * every request, because a stored issue is a claim that goes stale the moment
 * someone edits a product — a merchant who fixes a description should not have
 * to wait for a job to notice. What genuinely cannot be recomputed is what the
 * *merchant decided*: dismissed, resolved by hand, assigned to someone. Only
 * that lives here.
 *
 * The key is `(orgId, issueId)`, where `issueId` is derived deterministically
 * from the rule and its subject (`lib/readiness/rules.ts`). That is what makes a
 * dismissal survive tomorrow's recomputation.
 */
export const readinessIssueStates = pgTable(
  "readiness_issue_states",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Deterministic — see `issueId()`. Not a foreign key; there is no issue table. */
    issueId: text("issue_id").notNull(),
    status: text("status", { enum: ["open", "resolved", "dismissed", "assigned"] })
      .notNull()
      .default("open"),
    assignedTo: text("assigned_to"),
    /** Why it was dismissed, so the decision is reviewable later. */
    note: text("note"),
    actorId: text("actor_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("readiness_issue_states_uq").on(t.orgId, t.issueId)],
);

/**
 * A score on a day, for the trend line.
 *
 * History is the one part of readiness that **must** be stored: a score is a
 * function of the catalog as it was, and yesterday's catalog is gone. Written
 * at most once per scope per day — a merchant editing products all afternoon
 * wants a trend, not a sawtooth.
 */
export const readinessSnapshots = pgTable(
  "readiness_snapshots",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    scope: text("scope", { enum: ["organization", "site", "product"] }).notNull(),
    /** Null for organization scope. */
    scopeId: integer("scope_id"),
    /** UTC calendar day, so one row per scope per day. */
    day: text("day").notNull(),
    score: integer("score").notNull(),
    components: jsonb("components").$type<Record<string, number>>().notNull().default({}),
    counts: jsonb("counts")
      .$type<{ critical: number; warning: number; opportunity: number }>()
      .notNull()
      .default({ critical: 0, warning: 0, opportunity: 0 }),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * **`nullsNotDistinct` is load-bearing, not a detail.** `scopeId` is NULL for
     * organization scope, and Postgres treats NULLs as *distinct* in a unique
     * index by default — so the plain version never conflicted with itself and
     * every single overview request appended another row. The upsert silently
     * became an insert, and a merchant refreshing a dashboard would grow the
     * trend table without bound while the chart drew one point per page view.
     */
    unique("readiness_snapshots_uq")
      .on(t.orgId, t.scope, t.scopeId, t.day)
      .nullsNotDistinct(),
    index("readiness_snapshots_org_day_idx").on(t.orgId, t.day),
  ],
);

// ---------------------------------------------------------------------------
// Email (§6) — merchant sending identities and the suppression list
// ---------------------------------------------------------------------------

/**
 * A domain a merchant sends their own mail from (G1).
 *
 * This table is what makes `sendMerchantMail(orgId, …)` mean anything. The
 * two-stream split is only real if merchant mail leaves from the *merchant's*
 * domain — otherwise their bounces land on Markii's sending reputation, which
 * is the exact failure the split exists to prevent. Without a verified row
 * here, merchant mail does not send at all; it deliberately does not fall back
 * to `markii.shop`.
 *
 * DKIM tokens come from SES at creation and are shown to the merchant as CNAME
 * records. They are not secrets — they are published in DNS by design — so they
 * live in a plain column rather than the credential store.
 */
export const emailIdentities = pgTable(
  "email_identities",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** The bare domain, lowercased — `acme.com`, never `mail.acme.com.` or a URL. */
    domain: text("domain").notNull(),
    /**
     * Mailbox part of the From address on this domain. The full sender is
     * `${fromLocalPart}@${domain}`; stored split so a merchant can change the
     * mailbox without re-verifying the domain.
     */
    fromLocalPart: text("from_local_part").notNull().default("orders"),
    /** Display name in the From header. Falls back to the site name when null. */
    fromName: text("from_name"),
    replyTo: text("reply_to"),
    /**
     * `pending` until DNS propagates and SES confirms. **Only `verified` may
     * send** — a `pending` identity that sent anyway would be an unauthenticated
     * message from a domain the merchant may not even own.
     */
    status: text("status", { enum: ["pending", "verified", "failed", "temporary_failure"] })
      .notNull()
      .default("pending"),
    /** The three CNAME records SES wants published, in order. */
    dkimTokens: jsonb("dkim_tokens").$type<string[]>().notNull().default([]),
    /** Set once SES reports success, so "verified when" is answerable. */
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    /** Why verification failed, verbatim from SES, for a merchant-facing hint. */
    lastError: text("last_error"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * A domain belongs to one org. Global, not per-org: two organizations
     * claiming `acme.com` means one of them is sending as a domain they do not
     * own, and the database is the right place to make that impossible.
     */
    uniqueIndex("email_identities_domain_uq").on(t.domain),
    index("email_identities_org_idx").on(t.orgId),
  ],
);

/**
 * Addresses that must not be mailed again, per org.
 *
 * **This is not a nicety — it is what keeps an SES account alive.** AWS suspends
 * senders above roughly 5% bounce or 0.1% complaint, and a hard bounce that
 * keeps being retried counts every time. Suppression is checked before every
 * merchant send, so a single bad address cannot compound into a suspension that
 * takes down mail for every merchant on the platform.
 *
 * Scoped per org because a complaint is about *that merchant's* mail: an address
 * that reported one store as spam has not consented to hear from a different
 * store, and equally should not be denied a receipt from a store it does
 * business with.
 */
export const emailSuppressions = pgTable(
  "email_suppressions",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Lowercased at write time — suppression is useless if case defeats it. */
    email: text("email").notNull(),
    /**
     * `complaint` is permanent: the recipient marked mail as spam, and sending
     * again is both an AWS violation and a reputation hit. `bounce` is a hard
     * bounce — the mailbox does not exist. `manual` is the merchant's own call.
     */
    reason: text("reason", { enum: ["bounce", "complaint", "manual"] }).notNull(),
    /** SES bounce subtype or complaint feedback type, for support conversations. */
    detail: text("detail"),
    /** The SES message id that produced the event, when there is one. */
    sourceMessageId: text("source_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("email_suppressions_uq").on(t.orgId, t.email),
    index("email_suppressions_org_idx").on(t.orgId),
  ],
);

/**
 * Every merchant send attempt, and what came of it.
 *
 * Kept because "did the customer get their receipt?" is a support question that
 * arrives days later, when the order timeline entry is buried and the provider's
 * own logs have rolled off. Bodies are **not** stored — a receipt contains a
 * customer's name, address and purchase history, and keeping a second copy of
 * that indefinitely for debugging is not a trade worth making.
 */
export const emailDeliveries = pgTable(
  "email_deliveries",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** `order_confirmation`, `shipping_notice`, … — see `lib/email/templates/`. */
    template: text("template").notNull(),
    toEmail: text("to_email").notNull(),
    subject: text("subject").notNull(),
    /** Null when nothing was sent — see `status`. */
    providerMessageId: text("provider_message_id"),
    provider: text("provider", { enum: ["ses", "resend", "none"] }).notNull(),
    status: text("status", {
      enum: ["sent", "failed", "suppressed", "not_configured", "bounced", "complained"],
    }).notNull(),
    /** The refusal or provider error, verbatim. */
    reason: text("reason"),
    orderId: integer("order_id").references(() => orders.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("email_deliveries_org_idx").on(t.orgId, t.createdAt),
    index("email_deliveries_order_idx").on(t.orderId),
    /** Bounce notifications arrive by message id, so that lookup needs an index. */
    index("email_deliveries_message_idx").on(t.providerMessageId),
  ],
);

/** One manual tax rate. `rateBps` is basis points — 875 is 8.75%. */
export type ManualTaxRate = {
  country: string;
  province?: string | null;
  /** Basis points, so a rate is an integer and never a float (D31 reasoning). */
  rateBps: number;
  name: string;
};

/**
 * One priced line frozen onto a checkout session, and the direct source of an
 * `order_lines` row. Amounts are per-line **before** discount and tax, which are
 * order-level and allocated at completion (`lib/commerce/allocation.ts`).
 */
export type CheckoutLineSnapshot = {
  productId: number;
  variantId: number | null;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  quantity: number;
  unitPriceMinor: number;
  /** `(unit + add-ons) × quantity`. */
  subtotalMinor: number;
  addOns: { productId: number; name: string; unitPriceMinor: number }[];
};

/** A postal address on a cart or checkout. Shape mirrors `customer_addresses`. */
export type CartAddress = {
  name?: string | null;
  line1: string;
  line2?: string | null;
  city: string;
  province?: string | null;
  postalCode?: string | null;
  country: string;
  phone?: string | null;
};

/** One field-level change an invocation made, as `docs/API.md` §22 shapes it. */
export type DiffEntry = {
  entity: string;
  entityId: string;
  path: string;
  before: unknown;
  after: unknown;
};

export type Site = typeof sites.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Product = typeof products.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type TrafficEvent = typeof agentTraffic.$inferSelect;
export type Integration = typeof integrations.$inferSelect;
export type ActionInvocation = typeof actionInvocations.$inferSelect;
export type Organization = typeof organizations.$inferSelect;
export type Staff = typeof staff.$inferSelect;
export type ApiToken = typeof apiTokens.$inferSelect;
export type ProductOption = typeof productOptions.$inferSelect;
export type Variant = typeof variants.$inferSelect;
export type Location = typeof locations.$inferSelect;
export type InventoryEntry = typeof inventoryLedger.$inferSelect;
export type Collection = typeof collections.$inferSelect;
export type Customer = typeof customers.$inferSelect;
export type CustomerAddress = typeof customerAddresses.$inferSelect;
export type Cart = typeof carts.$inferSelect;
export type CartLine = typeof cartLines.$inferSelect;
export type CheckoutSession = typeof checkoutSessions.$inferSelect;
export type InventoryReservation = typeof inventoryReservations.$inferSelect;
export type UsageRecord = typeof usageRecords.$inferSelect;
export type Discount = typeof discounts.$inferSelect;
export type DiscountRedemption = typeof discountRedemptions.$inferSelect;
export type FeeAssessment = typeof feeAssessments.$inferSelect;
export type ReadinessIssueState = typeof readinessIssueStates.$inferSelect;
export type ReadinessSnapshot = typeof readinessSnapshots.$inferSelect;
export type DigitalAsset = typeof digitalAssets.$inferSelect;
export type ProductDigitalAsset = typeof productDigitalAssets.$inferSelect;
export type DownloadGrant = typeof downloadGrants.$inferSelect;
export type DownloadEvent = typeof downloadEvents.$inferSelect;
export type LicenceKey = typeof licenceKeys.$inferSelect;
export type OrderLine = typeof orderLines.$inferSelect;
export type Refund = typeof refunds.$inferSelect;
export type RefundLine = typeof refundLines.$inferSelect;
export type Fulfillment = typeof fulfillments.$inferSelect;
export type FulfillmentLine = typeof fulfillmentLines.$inferSelect;
export type OrderEvent = typeof orderEvents.$inferSelect;
export type ShippingZone = typeof shippingZones.$inferSelect;
export type ShippingRate = typeof shippingRates.$inferSelect;
export type TaxSettings = typeof taxSettings.$inferSelect;
export type EmailIdentity = typeof emailIdentities.$inferSelect;
export type EmailSuppression = typeof emailSuppressions.$inferSelect;
export type EmailDelivery = typeof emailDeliveries.$inferSelect;
