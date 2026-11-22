import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { diffDesigns } from "@/lib/builder/design-diff";
import { designState, type DesignStateRef } from "@/lib/builder/queries";
import { resolveSite } from "@/lib/queries";

function stateRef(name: string, raw: string | null, fallback: DesignStateRef): DesignStateRef {
  if (raw === null || raw === "") return fallback;
  if (raw === "draft" || raw === "live") return raw;
  if (/^[1-9][0-9]{0,8}$/.test(raw)) return Number(raw);
  throw new ApiError("VALIDATION_ERROR", 400, `"${name}" must be "draft", "live" or a version number.`, { field: name });
}

/**
 * What changed between two states of the design (`docs/BUILDER.md` §12).
 * `?from=&to=` each take `draft`, `live` or a version number; the default —
 * live to draft — is "what publishing would change". Reads only.
 */
export const GET = orgHandler(
  async (req, { params, orgId }) => {
    const { idOrSlug } = await params;
    const site = await resolveSite(idOrSlug, orgId);
    const url = new URL(req.url);
    const fromRef = stateRef("from", url.searchParams.get("from"), "live");
    const toRef = stateRef("to", url.searchParams.get("to"), "draft");
    const [from, to] = await Promise.all([designState(site.id, fromRef), designState(site.id, toRef)]);
    const side = ({ snapshot, ...meta }: typeof from) => (void snapshot, meta);
    return NextResponse.json(
      { from: side(from), to: side(to), ...diffDesigns(from.snapshot, to.snapshot) },
      { headers: { "cache-control": "no-store" } },
    );
  },
  { permission: "cms.read" },
);
