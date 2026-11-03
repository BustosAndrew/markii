import "server-only";

import { and, asc, eq, gt, inArray, like, sql } from "drizzle-orm";
import { z } from "zod";
import { notFound } from "../../api";
import { locate } from "../../builder/tree";
import { designSummary, pageDocument } from "../../builder/queries";
import { BREAKPOINTS, HOME_HANDLE, type PageNode } from "../../builder/types";
import { actionInvocations, db, sites, staff, type DiffEntry } from "../../db";
import { ownSitesForStaff } from "../../tenancy";
import type { ReadScope } from "../catalog/reads";
import { describeChanges, NOT_A_DESIGN_CHANGE, outlineTree, type ChangeRow } from "./format";

/**
 * The brand agent's live context (D51) — **what makes it see every edit the
 * merchant makes**.
 *
 * Read fresh at the start of every turn and written into that turn's
 * instructions, never carried in the chat history: the history says what the
 * draft looked like when each message was sent, which is exactly what the
 * merchant may have changed since. Three parts:
 *
 * 1. the draft as it is now — theme, tokens, pages, and the open page's tree;
 * 2. what changed since the agent's last turn began, by anyone but itself,
 *    from the audit table — so it can say "I see you rewrote the heading";
 * 3. whether that last turn was stopped, and which of its edits landed first.
 *
 * Plus where the merchant is in the editor: page, selected block, breakpoint.
 */

/** Where the merchant is in the editor, sent with each message. Every field is checked against the site. */
export const editorContextSchema = z.object({
  siteId: z.number().int().positive(),
  pageId: z.number().int().positive().optional(),
  selectedNodeId: z.string().regex(/^n_[a-z0-9]{10}$/).nullable().optional(),
  breakpoint: z.enum(BREAKPOINTS).optional(),
  path: z.string().max(300).optional(),
});
export type EditorContext = z.infer<typeof editorContextSchema>;

/** The site a brand turn is about — within the asker's own store reach, or `404` as if it did not exist. */
export async function brandSite(scope: ReadScope, siteId: number) {
  const [site] = await db
    .select({ id: sites.id, name: sites.name, slug: sites.slug, status: sites.status })
    .from(sites)
    .where(and(eq(sites.id, siteId), ownSitesForStaff(scope.orgId, scope.storeIds)))
    .limit(1);
  if (!site) throw notFound("Site");
  return site;
}

type BuilderRow = ChangeRow & { result: unknown };

async function builderInvocationsSince(orgId: string, siteId: number, since: Date): Promise<BuilderRow[]> {
  const rows = await db
    .select({
      actionId: actionInvocations.actionId,
      actorType: actionInvocations.actorType,
      actorId: actionInvocations.actorId,
      diff: actionInvocations.diff,
      result: actionInvocations.result,
      undoOf: actionInvocations.undoOfInvocationId,
      occurredAt: actionInvocations.occurredAt,
    })
    .from(actionInvocations)
    .where(
      and(
        eq(actionInvocations.orgId, orgId),
        like(actionInvocations.actionId, "builder.%"),
        eq(actionInvocations.ok, true),
        gt(actionInvocations.occurredAt, since),
        sql`${actionInvocations.input}->>'siteId' = ${String(siteId)}`,
      ),
    )
    .orderBy(asc(actionInvocations.occurredAt))
    .limit(300);
  return rows.map((r) => ({ ...r, diff: (r.diff ?? []) as DiffEntry[] }));
}

async function staffNames(orgId: string, userIds: string[]): Promise<Map<string, string>> {
  if (!userIds.length) return new Map();
  const rows = await db
    .select({ userId: staff.userId, name: staff.name, email: staff.email })
    .from(staff)
    .where(and(eq(staff.orgId, orgId), inArray(staff.userId, userIds)));
  return new Map(rows.filter((r) => r.userId).map((r) => [r.userId!, r.name || r.email]));
}

/**
 * The live-context section of a brand turn's instructions.
 *
 * `since` is when the previous turn of this conversation began (null on the
 * first). Nobody else can write while a turn holds the lease, so every change
 * by another actor after that moment happened after the agent last spoke.
 */
export async function liveContext(input: {
  orgId: string;
  userId: string;
  sessionId: string;
  site: { id: number; name: string; slug: string; status: string };
  editor: EditorContext;
  since: Date | null;
}): Promise<string> {
  const { site, editor } = input;
  const summary = await designSummary(site.id);
  if (!summary.started) return "The design has not been started yet; the merchant must open the editor first.";

  // Every document the merchant can have open: pages, and (M4) customised templates and regions.
  const shared = [...summary.templates, ...summary.regions]
    .filter((d): d is typeof d & { id: number } => d.customized && d.id !== null)
    .map((d) => ({ id: d.id, title: d.title, path: d.previewPath ?? "(no product or collection to preview it with)", handle: d.handle }));
  const livePages = summary.pages.filter((p) => !p.deleted);
  const openable = [...livePages, ...shared];
  const open =
    (editor.pageId ? openable.find((p) => p.id === editor.pageId) : undefined) ??
    livePages.find((p) => p.handle === HOME_HANDLE) ??
    livePages[0];
  const doc = open ? await pageDocument(site.id, open.id) : null;
  const tree = (doc?.tree ?? null) as PageNode | null;
  const selected = tree && editor.selectedNodeId ? locate(tree, editor.selectedNodeId) : null;

  const out: string[] = [];
  out.push("## The draft right now");
  out.push(
    "Read from the database at the start of this message. It includes every edit the merchant has made by hand, " +
      "so trust it over anything earlier in this conversation.",
  );
  out.push(`Site: #${site.id} ${site.name} (${site.slug}, ${site.status})`);
  out.push(`Theme: ${summary.themeId}. Token overrides: ${JSON.stringify(summary.tokens ?? {})}`);
  if (summary.contrast.length) out.push(`Contrast warnings: ${summary.contrast.join(" ")}`);
  out.push(
    summary.hasUnpublishedChanges
      ? `The draft has unpublished changes (draft revision ${summary.revision}; ${summary.publishedVersion ? `version ${summary.publishedVersion} is live` : "never published"}).`
      : `The draft matches what is live${summary.publishedVersion ? ` (version ${summary.publishedVersion})` : ""}.`,
  );
  out.push("Pages:");
  for (const p of summary.pages) {
    out.push(`- #${p.id} ${JSON.stringify(p.title)} ${p.path}${p.deleted ? " (deleted in the draft)" : ""}${p.published ? "" : " (not yet published)"}`);
  }
  const sharedLine = (d: (typeof summary.templates)[number] | (typeof summary.regions)[number]) =>
    d.customized
      ? `- #${d.id} ${d.title} (${d.handle})${d.published ? "" : " — not yet published"}`
      : `- ${d.title} (${d.handle}) — not customised; shoppers see the built-in layout${d.deleted ? " (reset in this draft)" : ""}`;
  out.push("Templates — every product or collection page renders with one once it is customised and published:");
  for (const t of summary.templates) out.push(sharedLine(t));
  out.push("Regions — shown on every page once customised and published:");
  for (const r of summary.regions) out.push(sharedLine(r));

  out.push("");
  out.push("## Where the merchant is");
  if (editor.pageId && open?.id !== editor.pageId) {
    out.push(`They had page #${editor.pageId} open, which is no longer in the draft; showing #${open?.id ?? "?"} instead.`);
  }
  out.push(`Open in the editor: ${open ? `#${open.id} ${JSON.stringify(open.title)} (${open.path})` : "none"}`);
  if (editor.breakpoint) out.push(`Previewing at: ${editor.breakpoint === "base" ? "desktop" : editor.breakpoint} breakpoint`);
  if (editor.path) out.push(`Preview path: ${editor.path}`);
  if (editor.selectedNodeId) {
    out.push(
      selected
        ? `Selected block: ${selected.node.id} (${selected.node.type}). "This", "it" or "here" most likely means this block.`
        : `They had block ${editor.selectedNodeId} selected, which is not on this page any more.`,
    );
  } else {
    out.push("No block is selected.");
  }
  if (tree) {
    out.push("");
    const kind = doc?.kind === "template" ? "Template" : doc?.kind === "region" ? "Region" : "Page";
    out.push(`## ${kind} #${open!.id} tree (draft)`);
    out.push(outlineTree(tree, { selectedId: selected?.node.id ?? null }));
  }

  if (input.since) {
    const rows = await builderInvocationsSince(input.orgId, site.id, input.since);
    const stop = rows.find(
      (r) =>
        r.actionId === "builder.stopAgent" &&
        (r.result as { stopped?: boolean; sessionId?: string } | null)?.stopped === true &&
        (r.result as { sessionId?: string }).sessionId === input.sessionId,
    );
    const others = rows.filter((r) => r.actorType !== "agent" && !NOT_A_DESIGN_CHANGE.has(r.actionId));
    const names = await staffNames(
      input.orgId,
      [...new Set(others.filter((r) => r.actorType === "user" && r.actorId && r.actorId !== input.userId).map((r) => r.actorId!))],
    );

    if (stop) {
      const landed = rows.filter((r) => r.actorType === "agent" && r.actorId === input.userId && r.occurredAt <= stop.occurredAt);
      out.push("");
      out.push("## Your last turn was stopped");
      out.push(
        `The merchant pressed Stop at ${stop.occurredAt.toISOString().slice(11, 16)} UTC, after ${landed.length} of your edit(s) had been applied. ` +
          "Anything you were about to do after that did not happen. Do not redo it unless they ask; they stopped you to take over.",
      );
      if (landed.length) out.push(describeChanges(landed, input.userId, names));
    }

    out.push("");
    out.push("## Changed since your last reply, by others");
    out.push(
      others.length
        ? `${describeChanges(others, input.userId, names)}\nThe draft above already includes these. Build on them; do not revert them unless asked.`
        : "Nothing — the draft is as you left it.",
    );
  }

  return out.join("\n");
}
