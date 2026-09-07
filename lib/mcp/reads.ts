import "server-only";

import { GET as categoriesGET } from "@/app/api/categories/route";
import { GET as collectionsGET } from "@/app/api/collections/route";
import { GET as customersGET } from "@/app/api/customers/route";
import { GET as orgGET } from "@/app/api/org/route";
import { GET as orderGET } from "@/app/api/orders/[id]/route";
import { GET as ordersGET } from "@/app/api/orders/route";
import { GET as productGET } from "@/app/api/products/[idOrSlug]/route";
import { GET as productsGET } from "@/app/api/products/route";
import { GET as readinessGET } from "@/app/api/readiness/overview/route";
import { GET as sitesGET } from "@/app/api/sites/route";
import type { McpTool } from "./tools";

/**
 * Read tools for the MCP server (§22, `docs/BUILDER.md` §10 — "read tools
 * always").
 *
 * **Why these are not registry actions.** The registry is the *mutation* path
 * (rule 1), and every invocation through it writes an `action_invocations` row.
 * Registering `listProducts` would mean an agent browsing a catalog buries the
 * audit log under list calls — degrading the one surface that has to stay
 * legible during an incident. Reads have always been plain REST here, and this
 * exposes exactly those handlers.
 *
 * **Nothing here is a second implementation.** Each entry names a real `GET`
 * route and forwards to it, so the org scoping, the permission check and the
 * serializer are the ones the dashboard already uses. A read tool cannot see
 * more than the same token would see over HTTP, because it *is* the same
 * handler — and if a route tightens tomorrow, this tightens with it.
 */

type RouteHandler = (
  req: Request,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;

type ReadTool = {
  /** Tool name as advertised. `read_` prefixed so it cannot collide with an action. */
  name: string;
  description: string;
  handler: RouteHandler;
  /** The path the handler expects, for its own `new URL(req.url)` parsing. */
  path: (args: Record<string, unknown>) => string;
  /** Dynamic segments, for handlers that read `params`. */
  params?: (args: Record<string, unknown>) => Record<string, string>;
  /** Query-string arguments this tool forwards, in the route's own vocabulary. */
  query: string[];
  properties: Record<string, unknown>;
  required?: string[];
};

const PAGING = {
  page: { type: "integer", minimum: 1, description: "1-based page number." },
  limit: { type: "integer", minimum: 1, maximum: 100, description: "Rows per page, max 100." },
};

const SITE = {
  siteId: { type: "integer", description: "Restrict to one storefront. Omit for all." },
};

export const READ_TOOLS: ReadTool[] = [
  {
    name: "read_store",
    description:
      "The organization this credential belongs to: name, plan, entitlements and billing " +
      "currency. Read this first — money is in minor units of `currency`, and `entitlements` " +
      "says how many storefronts and what threshold the plan allows.",
    /**
     * **`/api/org`, not `/api/me`.** `/api/me` calls `requireSession()` rather
     * than `requireAuthContext`, so it accepts a cookie session only and answers
     * **401 to every API token** — this tool was written against it and failed
     * immediately. `/api/org` runs through `orgHandler` with `org.read`, which
     * every role holds, and `serializeOrg` already carries the plan,
     * entitlements and currency an agent actually needs.
     */
    handler: orgGET,
    path: () => "/api/org",
    query: [],
    properties: {},
  },
  {
    name: "read_sites",
    description: "Storefronts in this organization, with slug, status and custom domain.",
    handler: sitesGET,
    path: () => "/api/sites",
    query: [],
    properties: {},
  },
  {
    name: "read_products",
    description:
      "Products in the catalog, paginated. Use this to find a product id before calling a " +
      "catalog tool that changes one.",
    handler: productsGET,
    path: () => "/api/products",
    /**
     * **`q`, not `search`.** The route reads `sp.get("q")`; a `search` argument
     * was accepted by the schema, forwarded, and silently ignored — so an agent
     * looking for one product got the whole unfiltered catalog back with no way
     * to tell. Every name here is the route's own.
     */
    query: ["q", "siteId", "categoryId", "enabled", "inStock", "page", "limit"],
    properties: {
      q: { type: "string", description: "Free-text match on title." },
      ...SITE,
      categoryId: { type: "integer" },
      enabled: { type: "boolean", description: "Filter by published state." },
      inStock: { type: "boolean", description: "Only products with stock remaining." },
      ...PAGING,
    },
  },
  {
    name: "read_product",
    description:
      "One product in full, including its variants and their ids — which is what the " +
      "catalog write tools take.",
    handler: productGET,
    path: () => "/api/products/detail",
    params: (a) => ({ idOrSlug: String(a.idOrSlug ?? "") }),
    query: ["siteId"],
    properties: {
      idOrSlug: { type: "string", description: "Numeric product id, or its slug." },
      ...SITE,
    },
    required: ["idOrSlug"],
  },
  {
    name: "read_categories",
    description: "Category tree for a storefront.",
    handler: categoriesGET,
    path: () => "/api/categories",
    query: ["q", "siteId", "parentId", "enabled", "page", "limit"],
    properties: {
      q: { type: "string", description: "Free-text match on name." },
      ...SITE,
      parentId: { type: "integer", description: 'Children of one category; "null" for top level.' },
      enabled: { type: "boolean" },
      ...PAGING,
    },
  },
  {
    name: "read_collections",
    description: "Merchandising collections and their published state.",
    handler: collectionsGET,
    path: () => "/api/collections",
    query: ["q", "siteId", "published", "page", "limit"],
    properties: {
      q: { type: "string", description: "Free-text match on title." },
      ...SITE,
      published: { type: "boolean" },
      ...PAGING,
    },
  },
  {
    name: "read_customers",
    description:
      "Customers, paginated. `acceptsMarketing` is explicit consent — never treat its " +
      "absence as permission to contact someone.",
    handler: customersGET,
    path: () => "/api/customers",
    query: ["q", "siteId", "acceptsMarketing", "page", "limit"],
    properties: {
      q: { type: "string", description: "Match on email, first name or last name." },
      ...SITE,
      acceptsMarketing: {
        type: "boolean",
        description: "Filter on recorded marketing consent.",
      },
      ...PAGING,
    },
  },
  {
    name: "read_orders",
    description: "Orders, newest first. Use this to find an order id before refunding or cancelling.",
    handler: ordersGET,
    path: () => "/api/orders",
    /**
     * **There is no free-text search on orders**, and a `search` argument used
     * to be declared here and quietly dropped. The filters below are the ones
     * `orderListFilters` actually reads; the enums are its own, and it answers
     * `400` on a value outside them rather than ignoring it — so listing them
     * is what stops an agent guessing "completed" and getting an error.
     */
    query: [
      "status",
      "financialStatus",
      "fulfillmentStatus",
      "provider",
      "customerId",
      "siteId",
      "from",
      "to",
      "page",
      "limit",
    ],
    properties: {
      status: { type: "string", enum: ["pending", "success", "cancel", "failed"] },
      financialStatus: {
        type: "string",
        enum: ["pending", "paid", "partially_refunded", "refunded", "voided"],
      },
      fulfillmentStatus: {
        type: "string",
        enum: ["unfulfilled", "partially_fulfilled", "fulfilled", "not_required"],
      },
      provider: { type: "string", enum: ["x402", "stripe"], description: "Payment rail." },
      customerId: { type: "integer", description: "Orders belonging to one customer." },
      ...SITE,
      from: { type: "string", description: "ISO date, inclusive." },
      to: { type: "string", description: "ISO date, inclusive (date-only covers the day)." },
      ...PAGING,
    },
  },
  {
    name: "read_order",
    description: "One order in full: lines, refunds, fulfillments and its timeline.",
    handler: orderGET,
    path: () => "/api/orders/detail",
    params: (a) => ({ id: String(a.id ?? "") }),
    query: [],
    properties: { id: { type: "string", description: "Order id." } },
    required: ["id"],
  },
  {
    name: "read_readiness",
    description:
      "The agent-readiness and catalog-health report: score, and the issues holding it down. " +
      "Read this when asked how to improve a store rather than guessing at fixes.",
    handler: readinessGET,
    path: () => "/api/readiness/overview",
    query: ["siteId", "productId"],
    properties: {
      ...SITE,
      productId: { type: "integer", description: "Narrow the report to one product." },
    },
  },
];

export function readToolNames(): string[] {
  return READ_TOOLS.map((t) => t.name);
}

/** The read tools as MCP tool descriptors, shaped like the action-backed ones. */
export function readTools(): McpTool[] {
  return READ_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: {
      type: "object",
      properties: t.properties,
      ...(t.required ? { required: t.required } : {}),
    },
    annotations: {
      title: t.name,
      /** True here, and the only place in this server where it is. */
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  }));
}

export function findReadTool(name: string): ReadTool | undefined {
  return READ_TOOLS.find((t) => t.name === name);
}

/**
 * Runs a read tool by calling its route handler in-process.
 *
 * **The caller's own `Authorization` header is forwarded**, which is what makes
 * this safe: the handler re-resolves the token, re-derives the org from it, and
 * applies its own permission check. Passing the already-resolved session
 * instead would mean this layer deciding who may read what — a second
 * authorization path, and exactly the kind of thing §22 exists to prevent.
 */
export async function callReadTool(
  tool: ReadTool,
  args: Record<string, unknown>,
  authorization: string,
): Promise<{ status: number; body: unknown }> {
  const sp = new URLSearchParams();
  for (const key of tool.query) {
    const value = args[key];
    if (value === undefined || value === null || value === "") continue;
    sp.set(key, String(value));
  }

  const qs = sp.toString();
  const url = `http://internal${tool.path(args)}${qs ? `?${qs}` : ""}`;
  const res = await tool.handler(new Request(url, { headers: { authorization } }), {
    params: Promise.resolve(tool.params ? tool.params(args) : {}),
  });

  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}
