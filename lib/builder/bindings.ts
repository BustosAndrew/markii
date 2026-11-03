import { z } from "zod";
import { CONDITION_OPS, type Condition, type DocumentKind, type PageNode } from "./types";

/**
 * Data binding, conditional visibility and repeaters (`docs/BUILDER.md` §9, M4).
 *
 * **A whitelist, not a template language.** A node binds a prop to one of the
 * paths below and shows conditionally on one of the comparisons below; there
 * is no expression to parse and nothing to `eval`. That keeps every binding
 * checkable before publish — a path either exists in the scope the document
 * renders with or it is an error — and keeps what an agent can write to a
 * closed list it can read in full.
 *
 * Pure and dependency-free: the renderer, the registry actions, the checks,
 * the editor and the agent all read this one definition.
 */

/** What a document renders against. `item` exists only inside a repeater. */
export const DATA_SCOPES = ["store", "product", "collection", "item"] as const;
export type DataScope = (typeof DATA_SCOPES)[number];

/** The kind of value a path yields, matched against the props a block lets be bound. */
export type ValueType = "text" | "image" | "link" | "productSlug";

/**
 * One product as a binding sees it — everything already formatted for display.
 * `description` is plain text: catalogue descriptions may hold imported HTML,
 * and a binding must never carry markup into the page.
 */
export type ProductView = {
  slug: string;
  title: string;
  description: string;
  price: string;
  priceMinor: number;
  image: string;
  url: string;
  sku: string;
  stock: number;
  inStock: boolean;
  stockStatus: string;
  category: string;
  relatedCount: number;
};

export type CollectionView = {
  handle: string;
  title: string;
  description: string;
  image: string;
  url: string;
  productCount: number;
};

export type StoreView = {
  name: string;
  url: string;
  copyright: string;
  hasCollections: boolean;
  productCount: number;
};

export type DataValues = {
  store: StoreView;
  product?: ProductView;
  collection?: CollectionView;
  item?: ProductView;
};

type PathSpec = { type: ValueType; label: string };

const PRODUCT_PATHS: Record<string, PathSpec> = {
  title: { type: "text", label: "Name" },
  description: { type: "text", label: "Description (plain text)" },
  price: { type: "text", label: "Price, formatted" },
  stockStatus: { type: "text", label: "Stock line, e.g. \"3 in stock\"" },
  sku: { type: "text", label: "SKU" },
  category: { type: "text", label: "Category name" },
  image: { type: "image", label: "First image" },
  url: { type: "link", label: "Page address" },
  slug: { type: "productSlug", label: "The product itself (for a featured-product block)" },
};

/** Every path a prop may bind to. */
export const BINDING_PATHS: Readonly<Record<string, PathSpec & { scope: DataScope }>> = Object.freeze({
  ...Object.fromEntries(Object.entries(PRODUCT_PATHS).map(([k, v]) => [`product.${k}`, { ...v, scope: "product" as const }])),
  ...Object.fromEntries(
    Object.entries(PRODUCT_PATHS).map(([k, v]) => [`item.${k}`, { ...v, label: `Each product: ${v.label.toLowerCase()}`, scope: "item" as const }]),
  ),
  "collection.title": { type: "text", label: "Collection title", scope: "collection" },
  "collection.description": { type: "text", label: "Collection description", scope: "collection" },
  "collection.image": { type: "image", label: "Collection image", scope: "collection" },
  "collection.url": { type: "link", label: "Collection address", scope: "collection" },
  "store.name": { type: "text", label: "Store name", scope: "store" },
  "store.url": { type: "link", label: "Store home address", scope: "store" },
  "store.copyright": { type: "text", label: "© year and store name", scope: "store" },
});

type ConditionSpec = { type: "number" | "boolean" | "text"; label: string; scope: DataScope };

const PRODUCT_CONDITIONS: Record<string, Omit<ConditionSpec, "scope">> = {
  stock: { type: "number", label: "units in stock" },
  inStock: { type: "boolean", label: "is in stock" },
  priceMinor: { type: "number", label: "price in minor units (cents)" },
  description: { type: "text", label: "description" },
  image: { type: "text", label: "image" },
  sku: { type: "text", label: "SKU" },
};

/** Every path a visibility condition may test. */
export const CONDITION_PATHS: Readonly<Record<string, ConditionSpec>> = Object.freeze({
  ...Object.fromEntries(Object.entries(PRODUCT_CONDITIONS).map(([k, v]) => [`product.${k}`, { ...v, scope: "product" as const }])),
  "product.relatedCount": { type: "number", label: "number of related products", scope: "product" },
  ...Object.fromEntries(Object.entries(PRODUCT_CONDITIONS).map(([k, v]) => [`item.${k}`, { ...v, scope: "item" as const }])),
  "collection.productCount": { type: "number", label: "number of products", scope: "collection" },
  "collection.description": { type: "text", label: "description", scope: "collection" },
  "collection.image": { type: "text", label: "image", scope: "collection" },
  "store.hasCollections": { type: "boolean", label: "has published collections", scope: "store" },
  "store.productCount": { type: "number", label: "number of products", scope: "store" },
});

/** What a repeater can iterate. Each item is a product, read through `item.*`. */
export const REPEATER_SOURCES = {
  "store.products": { scope: "store", label: "All of the store's products" },
  "collection.products": { scope: "collection", label: "This collection's products (collection template)" },
  "product.related": { scope: "product", label: "This product's related products (product template)" },
} as const satisfies Record<string, { scope: DataScope; label: string }>;
export type RepeaterSource = keyof typeof REPEATER_SOURCES;

export function scopeOf(path: string): DataScope | null {
  const head = path.split(".")[0];
  return (DATA_SCOPES as readonly string[]).includes(head) ? (head as DataScope) : null;
}

/**
 * The scopes a document renders with. Pages and regions know only the store;
 * a template knows the product or collection its page is for.
 */
export function scopesFor(kind: DocumentKind, handle: string): Set<DataScope> {
  const out = new Set<DataScope>(["store"]);
  if (kind === "template" && handle === "product") out.add("product");
  if (kind === "template" && handle === "collection") out.add("collection");
  return out;
}

// ---------- validation ----------

export const bindingsSchema = z
  .record(
    z.string().regex(/^[a-zA-Z]{1,40}$/, "A prop name."),
    z.string().refine((p) => p in BINDING_PATHS, "Not a known binding path — read the bindings list."),
  )
  .refine((b) => Object.keys(b).length <= 10, "At most 10 bindings on one block.");

const NUMERIC_OPS = new Set(["gt", "gte", "lt", "lte"]);

export const conditionSchema = z
  .object({
    path: z.string().refine((p) => p in CONDITION_PATHS, "Not a known condition path — read the conditions list."),
    op: z.enum(CONDITION_OPS),
    value: z.union([z.string().max(200), z.number(), z.boolean()]).optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const spec = CONDITION_PATHS[c.path];
    if (!spec) return;
    if (c.op === "exists" || c.op === "missing") {
      if (c.value !== undefined) ctx.addIssue({ code: "custom", message: `"${c.op}" takes no value.`, path: ["value"] });
      return;
    }
    if (c.value === undefined) {
      ctx.addIssue({ code: "custom", message: `"${c.op}" needs a value.`, path: ["value"] });
      return;
    }
    if (NUMERIC_OPS.has(c.op) && (spec.type !== "number" || typeof c.value !== "number")) {
      ctx.addIssue({ code: "custom", message: `"${c.op}" compares numbers; ${c.path} is ${spec.type}.`, path: ["op"] });
    }
    if (spec.type === "boolean" && typeof c.value !== "boolean") {
      ctx.addIssue({ code: "custom", message: `${c.path} is true or false.`, path: ["value"] });
    }
  });

// ---------- resolving ----------

export function resolvePath(values: DataValues, path: string): unknown {
  const [head, ...rest] = path.split(".");
  const scope = values[head as keyof DataValues] as Record<string, unknown> | undefined;
  if (!scope) return undefined;
  return scope[rest.join(".")];
}

/**
 * A node's props with its bindings applied. A binding whose data is absent —
 * an empty description, or a product path on a page that has no product —
 * leaves the placeholder in place, so nothing renders as "undefined".
 */
export function boundProps(node: PageNode, values: DataValues): Record<string, unknown> {
  if (!node.bindings) return node.props;
  const out = { ...node.props };
  for (const [prop, path] of Object.entries(node.bindings)) {
    const v = resolvePath(values, path);
    if (typeof v === "string" && v.trim() !== "") out[prop] = v;
  }
  return out;
}

/**
 * Whether a condition holds. **`null` means it cannot be answered here** —
 * the scope it tests is not available, as on a page that has no product. The
 * renderer hides such a node for shoppers and shows it in the preview, where
 * the merchant needs to reach it; publish checks flag it either way.
 */
export function evaluateCondition(cond: Condition, values: DataValues): boolean | null {
  const scope = scopeOf(cond.path);
  if (!scope || !values[scope]) return null;
  const v = resolvePath(values, cond.path);
  const present = v !== undefined && v !== null && v !== "";
  switch (cond.op) {
    case "exists":
      return present;
    case "missing":
      return !present;
    case "eq":
      return v === cond.value;
    case "neq":
      return v !== cond.value;
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (typeof v !== "number" || typeof cond.value !== "number") return false;
      if (cond.op === "gt") return v > cond.value;
      if (cond.op === "gte") return v >= cond.value;
      if (cond.op === "lt") return v < cond.value;
      return v <= cond.value;
    }
  }
}

/** A condition as a person reads it: "product.stock > 0". */
export function describeCondition(c: Condition): string {
  const sym: Record<string, string> = { eq: "=", neq: "≠", gt: ">", gte: "≥", lt: "<", lte: "≤" };
  if (c.op === "exists") return `${c.path} is set`;
  if (c.op === "missing") return `${c.path} is empty`;
  return `${c.path} ${sym[c.op]} ${JSON.stringify(c.value)}`;
}

/** The whitelist as the editor and the agent read it. */
export function describeBindings() {
  return {
    bindings: Object.entries(BINDING_PATHS).map(([path, s]) => ({ path, type: s.type, scope: s.scope, label: s.label })),
    conditions: Object.entries(CONDITION_PATHS).map(([path, s]) => ({ path, type: s.type, scope: s.scope, label: s.label })),
    operators: [...CONDITION_OPS],
    repeaterSources: Object.entries(REPEATER_SOURCES).map(([source, s]) => ({ source, scope: s.scope, label: s.label })),
    scopes: {
      page: ["store"],
      productTemplate: ["store", "product"],
      collectionTemplate: ["store", "collection"],
      region: ["store"],
      insideRepeater: ["item"],
    },
  };
}
