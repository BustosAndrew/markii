import { neon } from "@neondatabase/serverless";
import { NextResponse, type NextRequest } from "next/server";

// Host-header multi-tenancy (Next 16 "proxy" convention): platform hosts pass through; {slug}.{ROOT_DOMAIN},
// {slug}.localhost and custom domains rewrite to /_sites/{slug}/...
export const config = {
  matcher: ["/((?!_next|_sites|uploads|favicon\\.ico|icon\\.svg).*)"],
};

export async function proxy(req: NextRequest) {
  const host = (req.headers.get("host") ?? "").split(":")[0].toLowerCase();
  const root = (process.env.ROOT_DOMAIN ?? "").toLowerCase();

  const isPlatformHost =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host.startsWith("app.") ||
    host.endsWith(".vercel.app") ||
    (root !== "" && (host === root || host === `www.${root}`));
  if (isPlatformHost) return NextResponse.next();

  let slug: string | null = null;
  if (host.endsWith(".localhost")) {
    slug = host.slice(0, -".localhost".length);
  } else if (root && host.endsWith(`.${root}`)) {
    slug = host.slice(0, -(root.length + 1));
  } else if (process.env.DATABASE_URL) {
    // custom domain → site lookup
    try {
      const sql = neon(process.env.DATABASE_URL);
      const rows = await sql`select slug from sites where custom_domain = ${host} limit 1`;
      slug = (rows[0]?.slug as string | undefined) ?? null;
    } catch (e) {
      console.error("custom-domain lookup failed", e);
    }
  }
  if (!slug) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = `/_sites/${slug}${url.pathname === "/" ? "" : url.pathname}`;
  return NextResponse.rewrite(url);
}
