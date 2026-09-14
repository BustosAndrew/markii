import { NextResponse } from "next/server";
import { logTraffic } from "@/lib/agents";
import { badRequest, handler, notFound } from "@/lib/api";
import { loadSite, storefrontHalted } from "@/lib/storefront";
import { clampLimit, normalizeQuery, searchProducts } from "@/lib/storefront/search";
import { searchResultsJson } from "@/lib/storefront/search-response";

/**
 * `GET /api/search?q=…&limit=…` on a storefront host (G6) — the catalogue
 * search agents are pointed at from `agent.md` and `llms.txt`.
 *
 * The human page at `/search` and this route run the same `searchProducts`
 * with the same filters, so a shopper and a buyer agent asking the same
 * question get the same list. That parity is the product's whole claim
 * ("legible to agents", not "a separate feed for agents"), and it is what makes
 * the readiness score honest about what an agent will find.
 *
 * Not gated on `agentDiscovery`: that switch withholds the *documents* that
 * advertise the store to agents, and this is a read over the same catalogue the
 * product pages already serve to anyone. A halted store answers 404 like every
 * other storefront route — shoppers and agents are told the store is
 * unavailable and never why.
 *
 * An empty `q` is a 400, not an empty list. An empty list says "nothing
 * matched", and an agent that forgot the parameter would take that as an
 * answer about the catalogue.
 */
export const GET = handler(async (req, { params }) => {
  const data = await loadSite((await params).site);
  if (!data || storefrontHalted(data)) throw notFound("Store");

  const sp = new URL(req.url).searchParams;
  const q = normalizeQuery(sp.get("q"));
  if (!q) throw badRequest("q is required");
  const limit = clampLimit(sp.get("limit"));

  await logTraffic({
    siteId: data.site.id,
    path: "/api/search",
    userAgent: req.headers.get("user-agent"),
  });

  const results = await searchProducts(data.site.id, q, limit);
  return NextResponse.json(searchResultsJson(data, q, limit, results), {
    headers: { "cache-control": "public, max-age=60" },
  });
});
