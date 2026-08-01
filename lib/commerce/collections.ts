import { and, asc, desc, eq, gt, ilike, lt, or, type SQL } from "drizzle-orm";
import { products, type Collection, type CollectionRule } from "../db";

/**
 * Automated-collection rule evaluation (§18.2).
 *
 * `docs/API.md` lists six rule fields — `title`, `tag`, `price`, `stock`,
 * `vendor`, `type`. **Products currently carry only three of them.** There are no
 * `tag`, `vendor`, or `type` columns, so a rule on those fields cannot match
 * anything.
 *
 * Rather than accept such a rule and silently return an empty collection — which
 * looks like "the feature is broken" and wastes an afternoon — validation rejects
 * them with a message saying why. They become available when the product model
 * grows those fields.
 */

export const SUPPORTED_RULE_FIELDS = ["title", "price", "stock", "sku"] as const;
export const UNSUPPORTED_RULE_FIELDS = ["tag", "vendor", "type"] as const;

/** Column each rule field maps to. `title` is the product's name. */
const COLUMN = {
  title: products.name,
  price: products.priceCents,
  stock: products.stock,
  sku: products.sku,
} as const;

const NUMERIC_FIELDS = new Set(["price", "stock"]);

/**
 * One rule → one SQL condition.
 *
 * Returns `null` for a combination that cannot be expressed (e.g. `contains` on
 * a number), so the caller can reject it rather than silently dropping it — a
 * dropped rule widens the collection, which is the dangerous direction.
 */
export function ruleToCondition(rule: CollectionRule): SQL | null {
  const column = COLUMN[rule.field];
  const isNumeric = NUMERIC_FIELDS.has(rule.field);

  if (isNumeric) {
    const n = Number(rule.value);
    if (!Number.isFinite(n)) return null;
    switch (rule.op) {
      case "eq":
        return eq(column, n);
      case "gt":
        return gt(column, n);
      case "lt":
        return lt(column, n);
      default:
        return null; // contains / starts_with are meaningless on a number
    }
  }

  switch (rule.op) {
    case "eq":
      return eq(column, rule.value);
    case "contains":
      return ilike(column, `%${rule.value}%`);
    case "starts_with":
      return ilike(column, `${rule.value}%`);
    default:
      return null; // gt / lt are meaningless on text
  }
}

/** Combines a collection's rules with its `all`/`any` match mode. */
export function rulesToCondition(
  rules: CollectionRule[],
  match: "all" | "any",
): { condition: SQL | null; invalid: CollectionRule[] } {
  const invalid: CollectionRule[] = [];
  const conditions: SQL[] = [];

  for (const rule of rules) {
    const c = ruleToCondition(rule);
    if (c) conditions.push(c);
    else invalid.push(rule);
  }

  if (conditions.length === 0) return { condition: null, invalid };
  return {
    condition: match === "any" ? or(...conditions)! : and(...conditions)!,
    invalid,
  };
}

/** Sort clause for a collection's `sortOrder`. */
export function collectionOrderBy(sortOrder: Collection["sortOrder"]) {
  switch (sortOrder) {
    case "price_asc":
      return asc(products.priceCents);
    case "price_desc":
      return desc(products.priceCents);
    case "created_desc":
      return desc(products.createdAt);
    case "best_selling":
      // No order-line data to rank by yet (that arrives with §18.4 checkout).
      // Falls back to newest rather than inventing a ranking.
      return desc(products.createdAt);
    default:
      return asc(products.id);
  }
}
