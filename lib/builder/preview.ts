import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import { headers } from "next/headers";
import { cache } from "react";
import { appUrl } from "@/lib/api";
import { db, sitePreviewSessions } from "@/lib/db";
import { PREVIEW_TOKEN_HEADER, PREVIEW_TOKEN_PATTERN, previewBase } from "./preview-url";

/**
 * Live-preview sessions (D51, M2): the opaque token the editor's preview frame
 * carries in its URL (`./preview-url`). Minted by the dashboard for a person who
 * can read the site's design; stored only as a hash; two hours long.
 *
 * A token grants exactly one thing — reading one site's **draft** through the
 * storefront renderer. It is not a session, holds no permission, and the
 * preview refuses every storefront API call, so a leaked one shows a design and
 * nothing more.
 */

export const PREVIEW_TTL_MS = 2 * 60 * 60 * 1000;

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createPreviewSession(input: { siteId: number; slug: string; userId: string }) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS);
  // Expired sessions for this site go first — the table stays bounded by editors, not by page loads.
  await db.delete(sitePreviewSessions).where(and(eq(sitePreviewSessions.siteId, input.siteId), lt(sitePreviewSessions.expiresAt, new Date())));
  await db.insert(sitePreviewSessions).values({
    id: `ps_${randomBytes(10).toString("hex")}`,
    tokenHash: hash(token),
    siteId: input.siteId,
    userId: input.userId,
    expiresAt,
  });
  const url = previewBase(input.slug, token, appUrl());
  return { url, expiresAt: expiresAt.toISOString() };
}

export type PreviewContext = { siteId: number; token: string };

export async function validatePreviewToken(token: string): Promise<PreviewContext | null> {
  if (!PREVIEW_TOKEN_PATTERN.test(token)) return null;
  const [row] = await db
    .select({ siteId: sitePreviewSessions.siteId })
    .from(sitePreviewSessions)
    .where(and(eq(sitePreviewSessions.tokenHash, hash(token)), gt(sitePreviewSessions.expiresAt, new Date())))
    .limit(1);
  return row ? { siteId: row.siteId, token } : null;
}

/**
 * The validated preview on this request, if any — asked once per request
 * (React `cache`) however many loaders and traffic logs ask. Outside a
 * request (a script, a test) there are no headers and so no preview.
 */
export const requestPreviewState = cache(
  async (): Promise<{ requested: false } | { requested: true; valid: PreviewContext | null }> => {
    let token: string | null = null;
    try {
      token = (await headers()).get(PREVIEW_TOKEN_HEADER);
    } catch {
      return { requested: false };
    }
    if (!token) return { requested: false };
    return { requested: true, valid: await validatePreviewToken(token) };
  },
);

export async function requestPreview(): Promise<PreviewContext | null> {
  const state = await requestPreviewState();
  return state.requested ? state.valid : null;
}

/** The preview's base URL for a site, for `loadSite` to hand every link. */
export function previewBaseFor(slug: string, token: string): string {
  return previewBase(slug, token, appUrl());
}

/** The dashboard's origin — the only window the preview frame talks to. */
export function dashboardOrigin(): string {
  return new URL(appUrl()).origin;
}
