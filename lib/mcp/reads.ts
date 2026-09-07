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
    query: ["search", "siteId", "categoryId", "enabled", "page", "limit"],
    properties: {
      search: { type: "string", description: "Free-text match on title." },
      ...SITE,
      categoryId: { type: "integer" },
      enabled: { type: "boolean", description: "Filter by published state." },
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
    query: ["siteId", "parentId", "enabled", "page", "limit"],
    properties: {
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
    query: ["siteId", "published", "page", "limit"],
    properties: { ...SITE, published: { type: "boolean" }, ...PAGING },
  },
  {
    name: "read_customers",
    description:
      "Customers, paginated. `acceptsMarketing` is explicit consent — never treat its " +
      "absence as permission to contact someone.",
    handler: customersGET,
    path: () => "/api/customers",
    query: ["search", "siteId", "acceptsMarketing", "page", "limit"],
    properties: {
      search: { type: "string", description: "Match on email or name." },
      ...SITE,
      acceptsMarketing: { type: "boolean" },
      ...PAGING,
    },
  },
  {
    name: "read_orders",
    description: "Orders, newest first. Use this to find an order id before refunding or cancelling.",
    handler: ordersGET,
    path: () => "/api/orders",
    query: ["status", "siteId", "search", "from", "to", "page", "limit"],
    properties: {
      status: { type: "string", description: "Order status filter." },
      ...SITE,
      search: { type: "string" },
      from: { type: "string", description: "ISO date, inclusive." },
      to: { type: "string", description: "ISO date, inclusive." },
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
    query: ["siteId"],
    properties: { ...SITE },
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
