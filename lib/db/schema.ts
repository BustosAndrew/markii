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
  (t) => [uniqueIndex("sites_slug_uq").on(t.slug)],
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

export const integrations = pgTable("integrations", {
  provider: text("provider", { enum: ["x402", "google", "stripe"] }).primaryKey(),
  status: text("status", { enum: ["connected", "not_connected", "error"] })
    .notNull()
    .default("not_connected"),
  config: jsonb("config").$type<Record<string, string>>().notNull().default({}),
  message: text("message"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Site = typeof sites.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Product = typeof products.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type TrafficEvent = typeof agentTraffic.$inferSelect;
export type Integration = typeof integrations.$inferSelect;
