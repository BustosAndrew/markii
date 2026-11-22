import { and, asc, count, eq, ilike, or, type SQL } from "drizzle-orm";
import { NextResponse } from "next/server";
import { orgHandler } from "@/lib/auth/handler";
import { db, siteRedirects } from "@/lib/db";
import { resolveSite } from "@/lib/queries";

/**
 * `GET /api/sites/:idOrSlug/redirects` — the store's redirects, by old link.
 * `?q=` matches either side; `?limit=` (default 200, at most 1000) and
 * `?offset=` page through a moved store's thousands. Writes are actions:
 * `redirects.create`, `update`, `delete`, `import`.
 */
export const GET = orgHandler(
  async (req, { params, orgId }) => {
    const { idOrSlug } = await params;
    const site = await resolveSite(idOrSlug, orgId);
    const url = new URL(req.url);
    const q = url.searchParams.get("q")?.trim() ?? "";
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 200, 1), 1000);
    const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

    const conditions: SQL[] = [eq(siteRedirects.siteId, site.id)];
    if (q) {
      // `%`, `_` and `\` are LIKE syntax; escaped so a search for "50%_off" means those characters.
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      conditions.push(or(ilike(siteRedirects.fromPath, like), ilike(siteRedirects.toUrl, like))!);
    }
    const where = and(...conditions);
    const [rows, [{ total }]] = await Promise.all([
      db.select().from(siteRedirects).where(where).orderBy(asc(siteRedirects.fromPath)).limit(limit).offset(offset),
      db.select({ total: count() }).from(siteRedirects).where(where),
    ]);
    return NextResponse.json(
      {
        siteId: site.id,
        total,
        items: rows.map((r) => ({
          id: r.id,
          from: r.fromPath,
          to: r.toUrl,
          permanent: r.permanent,
          createdBy: r.createdBy,
          createdAt: r.createdAt.toISOString(),
        })),
      },
      { headers: { "cache-control": "no-store" } },
    );
  },
  { permission: "cms.read" },
);
