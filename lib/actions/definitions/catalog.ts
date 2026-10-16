import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { badRequest, conflict, notFound } from "../../api";
import { categories, products, productOptions, sites, variants } from "../../db";
import { assertTiersOnSite, uniqueProductSlug } from "../../queries";
import { ownSites, siteScope } from "../../tenancy";
import { productUpdateSchema } from "../../validation";
import { planMatrix, type OptionSpec } from "../../commerce/variants";
import { patchInverse } from "../inverse";
import { defineAction } from "../registry";
import type { ActionContext } from "../types";

/**
 * Catalog actions (§18.1).
 *
 * These are the **first mutations defined through the registry**, which is the
 * whole reason `docs/BACKEND.md` §1 pulled the primitive forward out of Phase D:
 * written as plain route handlers they would all need rewriting later, and the
 * agent and the UI would drift apart in the meantime.
 */

/** Every action re-checks tenancy itself. An action is callable from HTTP, an agent, MCP, or CI. */
async function ownedProduct(ctx: ActionContext, productId: number) {
  if (!ctx.actor.orgId) throw notFound("Product");
  const [row] = await ctx.db
    .select()
    .from(products)
    .where(and(eq(products.id, productId), siteScope(ctx.actor.orgId, products.siteId)))
    .limit(1);
  if (!row) throw notFound("Product");
  return row;
}

const optionSchema = z.object({
  name: z.string().min(1).max(60),
  position: z.number().int().min(0).default(0),
  values: z.array(z.string().min(1).max(120)).min(1).max(100),
});

export const setProductOptions = defineAction({
  id: "catalog.setProductOptions",
  description:
    "Replace a product's option axes (e.g. Size, Color) and regenerate its variant matrix. " +
    "Existing variants that still match a valid combination keep their price, SKU, and stock. " +
    "Combinations that no longer exist are reported as orphaned and are NOT deleted.",
  input: z.object({
    productId: z.number().int().positive(),
    options: z.array(optionSchema).max(3),
    /** Default price for newly created variants, in minor units (D31). */
    defaultPriceMinor: z.number().int().nonnegative().optional(),
  }),
  permission: "catalog.write",
  /** Bulk edit across a product's variants — a human should see the diff first. */
  riskTier: "medium",
  undoable: false,
  async run(input, ctx) {
    const product = await ownedProduct(ctx, input.productId);

    // Duplicate option names would make `optionValues` ambiguous.
    const names = input.options.map((o) => o.name.trim());
    if (new Set(names).size !== names.length) {
      throw badRequest("Option names must be unique");
    }
    for (const option of input.options) {
      const values = option.values.map((v) => v.trim());
      if (new Set(values).size !== values.length) {
        throw badRequest(`Option "${option.name}" has duplicate values`);
      }
    }

    const specs: OptionSpec[] = input.options.map((o, i) => ({
      name: o.name.trim(),
      position: o.position || i,
      values: o.values.map((v) => v.trim()),
    }));

    const existing = await ctx.db
      .select()
      .from(variants)
      .where(eq(variants.productId, product.id));

    const plan = planMatrix(specs, existing);

    await ctx.db.delete(productOptions).where(eq(productOptions.productId, product.id));
    if (specs.length > 0) {
      await ctx.db.insert(productOptions).values(
        specs.map((s) => ({
          productId: product.id,
          name: s.name,
          position: s.position,
          values: s.values,
        })),
      );
    }

    for (const k of plan.keep) {
      await ctx.db
        .update(variants)
        .set({ title: k.title, position: k.position, updatedAt: new Date() })
        .where(eq(variants.id, k.id));
    }

    const price = input.defaultPriceMinor ?? product.priceCents;
    const created = plan.create.length
      ? await ctx.db
          .insert(variants)
          .values(
            plan.create.map((c) => ({
              productId: product.id,
              title: c.title,
              optionValues: c.optionValues,
              priceMinor: price,
              position: c.position,
            })),
          )
          .returning()
      : [];

    for (const c of created) {
      ctx.recordDiff({
        entity: "variant",
        entityId: String(c.id),
        path: "optionValues",
        before: null,
        after: c.optionValues,
      });
    }
    for (const o of plan.orphaned) {
      // Surfaced, never silently deleted: removing a variant cascades away its
      // inventory ledger, which is not a side effect an option edit should have.
      ctx.recordDiff({
        entity: "variant",
        entityId: String(o.id),
        path: "orphaned",
        before: o.optionValues,
        after: null,
      });
    }

    return {
      productId: product.id,
      created: created.length,
      kept: plan.keep.length,
      orphaned: plan.orphaned.map((o) => ({ id: o.id, title: o.title })),
    };
  },
});

export const updateVariant = defineAction({
  id: "catalog.updateVariant",
  description:
    "Update one variant's price, SKU, barcode, weight, tax settings, or inventory policy. " +
    "Money is in minor units of the store's currency.",
  input: z.object({
    variantId: z.number().int().positive(),
    sku: z.string().max(120).nullish(),
    barcode: z.string().max(120).nullish(),
    priceMinor: z.number().int().nonnegative().optional(),
    compareAtMinor: z.number().int().nonnegative().nullish(),
    costMinor: z.number().int().nonnegative().nullish(),
    weightGrams: z.number().int().nonnegative().nullish(),
    requiresShipping: z.boolean().optional(),
    taxable: z.boolean().optional(),
    taxCode: z.string().max(60).nullish(),
    inventoryPolicy: z.enum(["deny", "continue"]).optional(),
  }),
  permission: "catalog.write",
  riskTier: "low",
  undoable: true,
  /** Every changed field is recorded with its previous value, so undo is a replay. */
  inverse: patchInverse({ actionId: "catalog.updateVariant", idField: "variantId" }),
  async run({ variantId, ...patch }, ctx) {
    if (!ctx.actor.orgId) throw notFound("Variant");

    const [existing] = await ctx.db
      .select({ variant: variants })
      .from(variants)
      .innerJoin(products, eq(products.id, variants.productId))
      .where(and(eq(variants.id, variantId), siteScope(ctx.actor.orgId, products.siteId)))
      .limit(1);
    if (!existing) throw notFound("Variant");

    const changes = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (changes.length === 0) throw badRequest("No changes supplied");

    for (const [key, after] of changes) {
      ctx.recordDiff({
        entity: "variant",
        entityId: String(variantId),
        path: key,
        before: (existing.variant as Record<string, unknown>)[key] ?? null,
        after: after ?? null,
      });
    }

    const [row] = await ctx.db
      .update(variants)
      .set({ ...Object.fromEntries(changes), updatedAt: new Date() })
      .where(eq(variants.id, variantId))
      .returning();

    return row;
  },
});

/**
 * Whether two field values are the same, structurally. Arrays and objects
 * arrive as fresh values on every call, so `!==` would report an unchanged
 * image list as changed and fill the diff — and the proposal a merchant
 * approves — with edits that are not edits.
 */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export const updateProduct = defineAction({
  id: "catalog.updateProduct",
  description:
    "Update a product's fields: name, description, price (priceCents, minor units of the store's " +
    "currency), SKU, stock, images, category, slug, enabled, suggested products, add-ons, and " +
    "membership tiers. Only the fields supplied change. Passing siteId moves the product to " +
    "another of the organization's stores, which clears its category unless one on the target " +
    "store is given. Use catalog.updateVariant for a variant's own price or SKU.",
  input: productUpdateSchema.extend({ productId: z.number().int().positive() }),
  permission: "catalog.write",
  /**
   * `medium`, not `high`, although price is among the fields. `high` would make
   * every API-token caller of `PATCH /api/products/:id` — which now delegates
   * here — answer `HUMAN_APPROVAL_REQUIRED`, breaking integrations that sync a
   * catalog, and `catalog.updateVariant` already changes a variant's price at
   * `low`. An agent cannot apply this either way: the catalog agent only ever
   * dry-runs it, and a person runs the approved proposal.
   */
  riskTier: "medium",
  undoable: true,
  /**
   * The previous value of every changed field, replayed. A move between stores
   * records `siteId`, `categoryId` and `slug` together, so the replay moves it
   * back with all three.
   */
  inverse: patchInverse({ actionId: "catalog.updateProduct", idField: "productId" }),
  async run({ productId, ...input }, ctx) {
    const product = await ownedProduct(ctx, productId);
    const orgId = ctx.actor.orgId!;

    const siteChanged = input.siteId != null && input.siteId !== product.siteId;
    const targetSiteId = input.siteId ?? product.siteId;
    if (siteChanged) {
      // Org-scoped: without `ownSites` this reassigns a product into another
      // tenant's store — a cross-tenant *write*, not merely a read leak.
      const [site] = await ctx.db
        .select({ id: sites.id })
        .from(sites)
        .where(and(eq(sites.id, targetSiteId), ownSites(orgId)))
        .limit(1);
      if (!site) throw notFound("Target site");
    }

    // Reassigning the store clears the category unless a valid one on the
    // target store is sent along.
    const categoryId = siteChanged
      ? (input.categoryId ?? null)
      : input.categoryId !== undefined
        ? input.categoryId
        : product.categoryId;
    if (categoryId != null) {
      const [cat] = await ctx.db
        .select({ id: categories.id, siteId: categories.siteId })
        .from(categories)
        .where(and(eq(categories.id, categoryId), siteScope(orgId, categories.siteId)))
        .limit(1);
      if (!cat) throw notFound("Category");
      if (cat.siteId !== targetSiteId) throw badRequest("category belongs to a different site");
    }

    /**
     * Checked against the **target** store, so moving a product between stores
     * cannot smuggle a tier from the old one along with it.
     */
    await assertTiersOnSite(orgId, targetSiteId, [
      input.requiresTierId !== undefined ? input.requiresTierId : product.requiresTierId,
      input.grantsTierId !== undefined ? input.grantsTierId : product.grantsTierId,
    ]);

    let slug = input.slug ?? product.slug;
    if (input.slug && (input.slug !== product.slug || siteChanged)) {
      const [taken] = await ctx.db
        .select({ id: products.id })
        .from(products)
        .where(
          and(eq(products.siteId, targetSiteId), eq(products.slug, slug), ne(products.id, product.id)),
        )
        .limit(1);
      if (taken) throw conflict(`product slug "${slug}" already exists on this site`);
    } else if (siteChanged) {
      slug = await uniqueProductSlug(targetSiteId, product.slug);
    }

    const next: Record<string, unknown> = {
      ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
      siteId: targetSiteId,
      categoryId,
      slug,
    };

    const current = product as Record<string, unknown>;
    const changed = Object.entries(next).filter(([key, after]) => !sameValue(current[key], after));
    for (const [key, after] of changed) {
      ctx.recordDiff({
        entity: "product",
        entityId: String(product.id),
        path: key,
        before: current[key] ?? null,
        after: after ?? null,
      });
    }

    /**
     * Nothing changed is not an error here, unlike `catalog.updateVariant`:
     * `PATCH /api/products/:id` delegates to this and has always answered a
     * no-op save with the product, which a form that saves every field relies
     * on. The empty diff is the honest record of it.
     */
    if (changed.length === 0) return product;

    const [row] = await ctx.db
      .update(products)
      .set({ ...Object.fromEntries(changed), updatedAt: new Date() })
      .where(eq(products.id, product.id))
      .returning();
    return row;
  },
});
