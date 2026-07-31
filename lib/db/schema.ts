import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("orders_site_idx").on(t.siteId), index("orders_created_idx").on(t.createdAt)],
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
