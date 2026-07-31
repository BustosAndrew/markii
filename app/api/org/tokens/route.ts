import { and, asc, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { orgHandler } from "@/lib/auth/handler";
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
  storeIds: z.union([z.literal("all"), z.array(z.number().int().positive())]).default("all"),
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
     * `owner` is absent from the schema on purpose. A token that can do
     * everything its creator can, forever, with no MFA and no session expiry, is
     * the credential most worth stealing — and §22 rule 4 already caps a token
     * at what a human could do, so there is no capability lost by refusing the
     * top role here.
     */
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
        storeIds: input.storeIds,
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
