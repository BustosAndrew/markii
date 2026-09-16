import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { requireOperator } from "@/lib/auth/operator";
import { platformOrgView } from "@/lib/platform/orgs";

/**
 * `GET /api/admin/orgs/:idOrSlug` — a merchant org as a platform operator
 * sees it (G12): standing, suspension with its reason, stores.
 *
 * **Not `orgHandler`.** That wrapper resolves the *caller's* org and scopes
 * everything to it, which is exactly what an operator must step outside of.
 * `requireOperator` is the gate instead: a signed-in session (MFA applies) on
 * the `PLATFORM_OPERATOR_EMAILS` allowlist, refused when the list is unset.
 *
 * Reads are not audited — the registry records mutations (§22 rule 5), and
 * this is the same rule that keeps `read_*` MCP tools out of the log.
 */
export const GET = handler(async (_req, { params }) => {
  await requireOperator();
  const { id } = await params;
  return NextResponse.json(await platformOrgView(id));
});
