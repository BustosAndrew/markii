import { NextResponse } from "next/server";
import { slugify } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { generatePreview, type Bundle } from "@/lib/generators";
import { previewSchema } from "@/lib/validation";

/**
 * Stateless preview for the create-site wizard: send the draft bundle, get back
 * every live-preview pane (HTML, llms.txt, agent.md, sitemap tree, JSON-LD).
 */
export const POST = orgHandler(async (req) => {
  const input = previewSchema.parse(await req.json());
  const siteSlug = input.site.slug ?? slugify(input.site.name);
  const bundle: Bundle = {
    site: { ...input.site, slug: siteSlug },
    categories: input.categories.map((c) => ({ ...c, slug: c.slug ?? slugify(c.name) })),
    products: input.products.map((p) => ({ ...p, slug: p.slug ?? slugify(p.name) })),
  };
  return NextResponse.json(generatePreview(bundle));
}, { permission: "cms.read" });
