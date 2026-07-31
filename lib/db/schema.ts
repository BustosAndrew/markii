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
