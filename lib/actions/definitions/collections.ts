import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { badRequest, conflict, notFound, slugify } from "../../api";
import {
  collectionProducts,
  collections,
  products,
  sites,
} from "../../db";
import { ownSites, siteScope } from "../../tenancy";
import {
  rulesToCondition,
  SUPPORTED_RULE_FIELDS,
  UNSUPPORTED_RULE_FIELDS,
} from "../../commerce/collections";
import { defineAction } from "../registry";
import type { ActionContext } from "../types";

/** Collection actions (§18.2) — merchandising, distinct from §3 categories. */

async function ownedCollection(ctx: ActionContext, id: number) {
  if (!ctx.actor.orgId) throw notFound("Collection");
  const [row] = await ctx.db
    .select()
    .from(collections)
    .where(and(eq(collections.id, id), siteScope(ctx.actor.orgId, collections.siteId)))
    .limit(1);
  if (!row) throw notFound("Collection");
  return row;
}

/**
 * `tag`, `vendor`, and `type` appear in the §18.2 contract but products carry no
 * such columns. Accepting them would produce a collection that silently matches
 * nothing, so they are rejected with the reason.
 */
const ruleSchema = z.object({
  field: z.string(),
  op: z.enum(["eq", "contains", "gt", "lt", "starts_with"]),
  value: z.string().min(1).max(200),
}).superRefine((rule, ctx) => {
  if ((UNSUPPORTED_RULE_FIELDS as readonly string[]).includes(rule.field)) {
    ctx.addIssue({
      code: "custom",
      message:
        `Rule field "${rule.field}" is not available yet — products have no ${rule.field} field. ` +
        `Supported fields: ${SUPPORTED_RULE_FIELDS.join(", ")}.`,
    });
    return;
  }
  if (!(SUPPORTED_RULE_FIELDS as readonly string[]).includes(rule.field)) {
    ctx.addIssue({
      code: "custom",
      message: `Unknown rule field "${rule.field}". Supported: ${SUPPORTED_RULE_FIELDS.join(", ")}.`,
    });
  }
});

const baseFields = {
  title: z.string().min(1).max(200),
  handle: z.string().min(1).max(120).regex(/^[a-z0-9-]+$/).optional(),
  description: z.string().max(5000).nullish(),
  imageUrl: z.string().max(2000).nullish(),
  type: z.enum(["manual", "automated"]).default("manual"),
  rules: z.array(ruleSchema).max(20).default([]),
  rulesMatch: z.enum(["all", "any"]).default("all"),
  sortOrder: z
    .enum(["manual", "best_selling", "price_asc", "price_desc", "created_desc"])
    .default("manual"),
  published: z.boolean().default(false),
};

/** Rejects a rule set that parses but cannot be expressed as SQL (e.g. `contains` on price). */
function assertRulesUsable(rules: z.infer<typeof ruleSchema>[], match: "all" | "any") {
  if (rules.length === 0) return;
  const { condition, invalid } = rulesToCondition(rules as never, match);
  if (invalid.length > 0) {
    throw badRequest(
      `These rules cannot be applied: ${invalid
        .map((r) => `${r.field} ${r.op} "${r.value}"`)
        .join("; ")}. Numeric fields support eq/gt/lt; text fields support eq/contains/starts_with.`,
    );
  }
  if (!condition) throw badRequest("No usable rules supplied");
}

export const createCollection = defineAction({
  id: "catalog.createCollection",
  description:
    "Create a merchandising collection on a store. Manual collections hold an explicit product " +
    "list; automated collections match rules against the catalog. Distinct from categories, " +
    "which are catalog taxonomy rather than merchandising.",
  input: z.object({ siteId: z.number().int().positive(), ...baseFields }),
  permission: "catalog.write",
  riskTier: "low",
  undoable: false,
  async run(input, ctx) {
    if (!ctx.actor.orgId) throw notFound("Site");
    const [site] = await ctx.db
      .select({ id: sites.id })
      .from(sites)
      .where(and(eq(sites.id, input.siteId), ownSites(ctx.actor.orgId)))
      .limit(1);
    if (!site) throw notFound("Site");

    if (input.type === "automated") assertRulesUsable(input.rules, input.rulesMatch);

    const handle = input.handle ?? slugify(input.title);
    const [taken] = await ctx.db
      .select({ id: collections.id })
      .from(collections)
      .where(and(eq(collections.siteId, input.siteId), eq(collections.handle, handle)))
      .limit(1);
    if (taken) throw conflict(`collection handle "${handle}" already exists on this store`);

    const [row] = await ctx.db
      .insert(collections)
      .values({
        siteId: input.siteId,
        title: input.title,
        handle,
        description: input.description ?? null,
        imageUrl: input.imageUrl ?? null,
        type: input.type,
        rules: input.type === "automated" ? (input.rules as never) : [],
        rulesMatch: input.rulesMatch,
        sortOrder: input.sortOrder,
        publishedAt: input.published ? new Date() : null,
      })
      .returning();

    ctx.recordDiff({
      entity: "collection",
      entityId: String(row.id),
      path: "title",
      before: null,
      after: row.title,
    });
    return row;
  },
});

export const updateCollection = defineAction({
  id: "catalog.updateCollection",
  description: "Update a collection's title, handle, rules, sort order, or published state.",
  input: z.object({
    collectionId: z.number().int().positive(),
    title: z.string().min(1).max(200).optional(),
    handle: z.string().min(1).max(120).regex(/^[a-z0-9-]+$/).optional(),
    description: z.string().max(5000).nullish(),
    imageUrl: z.string().max(2000).nullish(),
    type: z.enum(["manual", "automated"]).optional(),
    rules: z.array(ruleSchema).max(20).optional(),
    rulesMatch: z.enum(["all", "any"]).optional(),
    sortOrder: z
      .enum(["manual", "best_selling", "price_asc", "price_desc", "created_desc"])
      .optional(),
    published: z.boolean().optional(),
  }),
  permission: "catalog.write",
  riskTier: "low",
  undoable: true,
  async run(input, ctx) {
    const { collectionId, published, ...patch } = input;
    const existing = await ownedCollection(ctx, collectionId);

    const nextType = patch.type ?? existing.type;
    const nextRules = patch.rules ?? (existing.rules as never[]);
    const nextMatch = patch.rulesMatch ?? existing.rulesMatch;
    if (nextType === "automated") assertRulesUsable(nextRules, nextMatch);

    const changes: Record<string, unknown> = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined),
    );
    if (published !== undefined) {
      changes.publishedAt = published ? (existing.publishedAt ?? new Date()) : null;
    }
    if (Object.keys(changes).length === 0) throw badRequest("No changes supplied");

    for (const [key, after] of Object.entries(changes)) {
      ctx.recordDiff({
        entity: "collection",
        entityId: String(collectionId),
        path: key,
        before: (existing as Record<string, unknown>)[key] ?? null,
        after: after ?? null,
      });
    }

    const [row] = await ctx.db
      .update(collections)
      .set({ ...changes, updatedAt: new Date() })
      .where(eq(collections.id, collectionId))
      .returning();
    return row;
  },
});

export const setCollectionProducts = defineAction({
  id: "catalog.setCollectionProducts",
  description:
    "Replace a manual collection's product list and their order. Rejected for automated " +
    "collections, whose membership comes from rules.",
  input: z.object({
    collectionId: z.number().int().positive(),
    productIds: z.array(z.number().int().positive()).max(1000),
  }),
  permission: "catalog.write",
  riskTier: "low",
  undoable: true,
  async run(input, ctx) {
    const collection = await ownedCollection(ctx, input.collectionId);
    if (collection.type === "automated") {
      throw badRequest(
        "This collection is automated — its membership comes from rules. " +
          "Change the rules, or convert it to manual first.",
      );
    }

    if (input.productIds.length > 0) {
      // Every product must belong to the same store, or a collection could
      // reference another tenant's catalog.
      const owned = await ctx.db
        .select({ id: products.id })
        .from(products)
        .where(
          and(inArray(products.id, input.productIds), eq(products.siteId, collection.siteId)),
        );
      if (owned.length !== new Set(input.productIds).size) {
        throw badRequest("Some products do not exist on this store");
      }
    }

    await ctx.db
      .delete(collectionProducts)
      .where(eq(collectionProducts.collectionId, collection.id));
    if (input.productIds.length > 0) {
      await ctx.db.insert(collectionProducts).values(
        input.productIds.map((productId, position) => ({
          collectionId: collection.id,
          productId,
          position,
        })),
      );
    }

    ctx.recordDiff({
      entity: "collection",
      entityId: String(collection.id),
      path: "products",
      before: null,
      after: input.productIds,
    });
    return { collectionId: collection.id, productCount: input.productIds.length };
  },
});

export const deleteCollection = defineAction({
  id: "catalog.deleteCollection",
  description: "Delete a collection. Products are untouched — only the grouping is removed.",
  input: z.object({ collectionId: z.number().int().positive() }),
  permission: "catalog.write",
  riskTier: "medium",
  undoable: false,
  async run(input, ctx) {
    const collection = await ownedCollection(ctx, input.collectionId);
    await ctx.db.delete(collections).where(eq(collections.id, collection.id));
    ctx.recordDiff({
      entity: "collection",
      entityId: String(collection.id),
      path: "title",
      before: collection.title,
      after: null,
    });
    return { deleted: true, id: collection.id };
  },
});
