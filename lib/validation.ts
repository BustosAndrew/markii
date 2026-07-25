import { z } from "zod";

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

export const siteCreateSchema = z.object({
  name: z.string().min(1).max(200),
  slug: slugSchema.optional(),
  customDomain: z.string().max(255).nullish(),
  status: z.enum(["draft", "live", "paused"]).optional(),
  indexed: z.boolean().optional(),
  agentDiscovery: z.boolean().optional(),
  purchasesEnabled: z.boolean().optional(),
  paymentProviders: paymentProvidersSchema.optional(),
  walletAddress: z.string().max(100).nullish(),
  googleSiteVerification: z.string().max(200).nullish(),
});

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
