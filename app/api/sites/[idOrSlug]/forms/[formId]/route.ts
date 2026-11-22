import { NextResponse } from "next/server";
import { notFound } from "@/lib/api";
import { orgHandler } from "@/lib/auth/handler";
import { getForm } from "@/lib/forms/queries";
import { resolveSite } from "@/lib/queries";

/** `GET /api/sites/:idOrSlug/forms/:formId` — one form's definition, for the editor. */
export const GET = orgHandler(
  async (_req, { params, orgId }) => {
    const { idOrSlug, formId } = await params;
    const site = await resolveSite(idOrSlug, orgId);
    const id = Number(formId);
    if (!Number.isInteger(id) || id < 1) throw notFound("Form");
    return NextResponse.json(await getForm(site.id, id), { headers: { "cache-control": "no-store" } });
  },
  { permission: "cms.read" },
);
