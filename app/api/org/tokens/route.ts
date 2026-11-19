import { and, asc, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { orgHandler } from "@/lib/auth/handler";
import { assertGrantWithin } from "@/lib/auth/reach";
import { assertGrowthAllowed } from "@/lib/billing/standing-guard";
import { newId } from "@/lib/auth/provisioning";
import { mintToken } from "@/lib/auth/tokens";
import { apiTokens, db, type ApiToken } from "@/lib/db";

/** `GET`/`POST /api/org/tokens` — scoped API/MCP tokens (§16, §22 rule 6). */

const createSchema = z.object({
  label: z.string().min(1).max(120),
  role: z.enum([
    "administrator",
    "catalog_manager",
    "commerce_manager",
    "analyst",
    "developer",
    "viewer",
  ]),
  /** Omitted: the creator's own stores, so a scoped creator's default is not a refusal. */
  storeIds: z.union([z.literal("all"), z.array(z.number().int().positive())]).optional(),
});

function serializeToken(t: ApiToken) {
  return {
    id: t.id,
    label: t.label,
    role: t.role,
    // The prefix identifies a token in a list; it does not authenticate one.
    prefix: t.prefix,
    storeIds: t.storeIds,
    createdAt: t.createdAt.toISOString(),
    lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
  };
}

export const GET = orgHandler(
  async (_req, { orgId }) => {
    const rows = await db
      .select()
      .from(apiTokens)
      .where(and(eq(apiTokens.orgId, orgId), isNull(apiTokens.revokedAt)))
      .orderBy(asc(apiTokens.createdAt));
    return NextResponse.json({ items: rows.map(serializeToken) });
  },
  { permission: "tokens.manage" },
);

export const POST = orgHandler(
  async (req, { orgId, session }) => {
    const input = createSchema.parse(await req.json());

    /**
     * Minting is growth; revoking is account administration and is never held.
     * `/api/org/` is exempt from the method-keyed standing check for exactly
     * that reason, so the growth rung of dunning (D10) is asked for here by name.
     */
    await assertGrowthAllowed(orgId, "creating an API token");

    /**
     * `owner` is absent from the schema on purpose. A token that can do
     * everything its creator can, forever, with no MFA and no session expiry, is
     * the credential most worth stealing — and §22 rule 4 already caps a token
     * at what a human could do, so there is no capability lost by refusing the
     * top role here.
     */
    /**
     * **A token never exceeds its creator** (D52, §22 rule 4). `tokens.manage`
     * is held by `developer`, and until this check a developer could mint an
     * `administrator` token — billing, payouts, staff — and a member scoped to
     * one store could mint an all-stores one. The creator is the caller's own
     * role and stores, so a token minting a token is capped by that token.
     */
    const storeIds = input.storeIds ?? session.storeIds;
    assertGrantWithin({ role: input.role, storeIds }, session);

    const minted = mintToken();

    const [row] = await db
      .insert(apiTokens)
      .values({
        id: newId("tok"),
        orgId,
        label: input.label,
        role: input.role,
        tokenHash: minted.hash,
        prefix: minted.prefix,
        storeIds,
        createdByUserId: session.user?.id ?? null,
      })
      .returning();

    return NextResponse.json(
      {
        ...serializeToken(row),
        /**
         * The only time the plaintext exists outside the caller's hands. It is
         * not recoverable: only its SHA-256 is stored, so a lost token is
         * revoked and replaced, never looked up.
         */
        token: minted.plaintext,
        tokenNote: "Copy this now — it cannot be shown again.",
      },
      { status: 201 },
    );
  },
  { permission: "tokens.manage" },
);
