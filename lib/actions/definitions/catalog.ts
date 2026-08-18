import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { badRequest, notFound } from "../../api";
import { products, productOptions, variants } from "../../db";
import { siteScope } from "../../tenancy";
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
