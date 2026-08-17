import { z } from "zod";
import { badRequest } from "@/lib/api";

// ---------- auth (§16) ----------

/**
 * 8 characters minimum — above Supabase's default of 6. Length is the only
 * requirement: composition rules (a digit, a symbol) measurably push people
 * toward `Password1!` and are not worth the usability cost. The 72-byte ceiling
 * is bcrypt's, and silently truncating past it would make a long password weaker
 * than it looks.
 */
export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .refine((v) => new TextEncoder().encode(v).length <= 72, "Password is too long");

export const credentialsSchema = z.object({
  email: z.email().max(255),
  password: passwordSchema,
});

export const emailOnlySchema = z.object({ email: z.email().max(255) });

export const updatePasswordSchema = z.object({ password: passwordSchema });

export const paymentProvidersSchema = z.object({
  x402: z.boolean(),
  stripe: z.boolean(),
});

const slugSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9-]+$/, "lowercase letters, numbers and dashes only");

// ---------- sites ----------

export const themeIdSchema = z.enum(["studio", "atlas", "noir", "bloom"]);

export const siteCreateSchema = z.object({
  name: z.string().min(1).max(200),
  slug: slugSchema.optional(),
  /**
   * **`customDomain` is deliberately absent**, for the same reason as
   * `walletAddress` below: writing it here set the storefront routing table with
   * no proof the merchant owned the hostname. One org could claim another
   * company's domain and answer for it the moment DNS pointed at Markii, and
   * nothing stopped two sites holding the same host — the resolver took
   * whichever row the planner returned first.
   *
   * It now moves only through `domains.connect`, and only a domain whose TXT
   * record has been verified resolves (migration 0031).
   */
  status: z.enum(["draft", "live", "paused"]).optional(),
  themeId: themeIdSchema.optional(),
  indexed: z.boolean().optional(),
  agentDiscovery: z.boolean().optional(),
  purchasesEnabled: z.boolean().optional(),
  paymentProviders: paymentProvidersSchema.optional(),
  /**
   * **`walletAddress` is deliberately absent.** It is the x402 payout
   * destination — `payTo` at checkout — and it moves only through
   * `payments.connectRail`, which requires `billing.write` **and** a fresh MFA
   * factor (D40 step-up).
   *
   * It used to live here, and because these routes write `{ ...input }` and
   * carried no permission option at all, any staff member — `viewer` included —
   * could redirect a store's crypto payouts. That is the same hole
   * `PUT /api/integrations/:provider` had before it was converted to actions;
   * this route was simply never looked at. The routes now refuse the field by
   * name rather than letting zod strip it silently, because a payout change
   * that quietly does nothing is its own kind of dangerous.
   */
  /**
   * Opt-in, and it stays opt-in: this sends mail from the merchant's domain to
   * their customers, so it is theirs to switch on (§24).
   */
  abandonedCartEmails: z.boolean().optional(),
  googleSiteVerification: z.string().max(200).nullish(),
});

/**
 * Fields the site routes must never write, with where they belong instead.
 *
 * Refused explicitly rather than stripped: a caller who thinks they changed a
 * payout destination and did not is worse off than one who got an error.
 */
export const SITE_FIELDS_ELSEWHERE: Record<string, string> = {
  walletAddress:
    "The x402 payout address is set with the payments.connectRail action, which requires " +
    "billing permission and a fresh MFA challenge.",
  customDomain:
    "A custom domain is connected with the domains.connect action and starts serving only " +
    "once domains.verify finds its DNS ownership record. Use domains.disconnect to remove one.",
};

/** Throws when a request body carries a field this route refuses to write. */
export function assertNoRedirectedSiteFields(body: unknown) {
  if (typeof body !== "object" || body === null) return;
  for (const [field, where] of Object.entries(SITE_FIELDS_ELSEWHERE)) {
    if (field in (body as Record<string, unknown>)) {
      throw badRequest(`"${field}" cannot be set here. ${where}`);
    }
  }
}

export const siteUpdateSchema = siteCreateSchema.partial();

// ---------- categories ----------

export const categoryCreateSchema = z.object({
  siteId: z.number().int().positive(),
  name: z.string().min(1).max(200),
  slug: slugSchema.optional(),
  parentId: z.number().int().positive().nullish(),
  description: z.string().max(5000).nullish(),
  imageUrl: z.string().max(2000).nullish(),
  enabled: z.boolean().optional(),
});

export const categoryUpdateSchema = categoryCreateSchema.partial();

// ---------- products ----------

export const addOnSchema = z.object({
  productId: z.number().int().positive(),
  mandatory: z.boolean(),
});

export const productCreateSchema = z.object({
  siteId: z.number().int().positive(),
  name: z.string().min(1).max(200),
  priceCents: z.number().int().nonnegative(),
  slug: slugSchema.optional(),
  categoryId: z.number().int().positive().nullish(),
  description: z.string().max(10000).nullish(),
  currency: z.string().length(3).optional(),
  sku: z.string().max(100).nullish(),
  stock: z.number().int().nonnegative().optional(),
  images: z.array(z.string().max(2000)).max(20).optional(),
  enabled: z.boolean().optional(),
  suggestedProductIds: z.array(z.number().int().positive()).max(20).optional(),
  addOns: z.array(addOnSchema).max(20).optional(),
  requiresTierId: z.number().int().positive().nullish(),
  grantsTierId: z.number().int().positive().nullish(),
  grantsDurationDays: z.number().int().positive().max(3650).nullish(),
  grantsRenewalInterval: z.enum(["none", "month", "year"]).optional(),
});

export const productUpdateSchema = productCreateSchema.partial();

// ---------- preview / template bundle ----------

export const bundleProductSchema = z.object({
  name: z.string().min(1),
  slug: slugSchema.optional(),
  priceCents: z.number().int().nonnegative().default(0),
  currency: z.string().length(3).default("USD"),
  description: z.string().nullish(),
  categorySlug: z.string().nullish(),
  sku: z.string().nullish(),
  stock: z.number().int().nonnegative().default(0),
  images: z.array(z.string()).default([]),
});

export const bundleCategorySchema = z.object({
  name: z.string().min(1),
  slug: slugSchema.optional(),
  parentSlug: z.string().nullish(),
  description: z.string().nullish(),
});

export const previewSchema = z.object({
  site: z.object({
    name: z.string().min(1).default("Untitled store"),
    slug: slugSchema.optional(),
    description: z.string().nullish(),
    indexed: z.boolean().default(true),
    themeId: themeIdSchema.default("studio"),
  }),
  categories: z.array(bundleCategorySchema).default([]),
  products: z.array(bundleProductSchema).default([]),
});

export type PreviewBundle = z.infer<typeof previewSchema>;

// ---------- import ----------

export const importItemSchema = z.object({
  tempId: z.string().min(1),
  name: z.string().min(1),
  slug: slugSchema.optional(),
  priceCents: z.number().int().nonnegative().default(0),
  currency: z.string().length(3).default("USD"),
  sku: z.string().nullish(),
  stock: z.number().int().nonnegative().default(0),
  description: z.string().nullish(),
  images: z.array(z.string()).default([]),
  categoryName: z.string().nullish(),
});

export const importCategorySchema = z.object({
  tempId: z.string().min(1),
  name: z.string().min(1),
});

export const importCommitSchema = z.object({
  items: z.array(importItemSchema).default([]),
  categories: z.array(importCategorySchema).default([]),
  allocations: z
    .array(
      z.object({
        tempId: z.string().min(1),
        siteId: z.number().int().positive(),
        categoryTempId: z.string().nullish(),
        categoryId: z.number().int().positive().nullish(),
        parentCategoryId: z.number().int().positive().nullish(),
      }),
    )
    .min(1),
});

export const importUrlSchema = z.object({ url: z.string().url() });

// ---------- checkout ----------

export const checkoutSchema = z.object({
  productId: z.number().int().positive().optional(),
  productSlug: z.string().optional(),
  quantity: z.number().int().positive().max(1000).default(1),
});
