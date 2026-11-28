import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { READ_API_HEADERS, storeJson } from "@/lib/storefront/read-api";
import { loadReadableSite, publishedDesign } from "@/lib/storefront/read-api-server";

/**
 * `GET /api/store` on a storefront host (D53) — the store, its categories and
 * published collections, and its **published** design as a theme package
 * (no head code, no saved blocks). What a headless storefront reads first.
 */
export const GET = handler(async (_req, { params }) => {
  const data = await loadReadableSite((await params).site);
  const { design, membersOnlyPages } = await publishedDesign(data);
  return NextResponse.json(storeJson(data, design, membersOnlyPages), { headers: READ_API_HEADERS });
});
