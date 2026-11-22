import { and, count, eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import { ApiError, notFound } from "../../api";
import { formBlocklist, formSubmissions, siteDocuments, siteForms, sites } from "../../db";
import { BLOCKLIST_PER_SITE, FORMS_PER_SITE, isEmail, normalizeBlockPattern } from "../../forms/rules";
import { ownSites, siteScope } from "../../tenancy";
import { FORM_HANDLE_PATTERN, formFieldsSchema } from "@markii/renderer/forms";
import { patchInverse } from "../inverse";
import { defineAction } from "../registry";
import type { ActionContext } from "../types";

/**
 * Storefront forms (`docs/BUILDER.md` §15 step 12, `docs/API.md` §19).
 *
 * Two authorities, because two kinds of thing are here. **The form itself** —
 * its fields and where it emails — is site content: `cms.write`. **What
 * shoppers sent** is customer data, read and erased like customers:
 * `commerce.read` / `commerce.write`, and so is the blocklist, which is a
 * judgement about senders. Per store (D52). On no agent's allowlist.
 */

const siteId = z.number().int().positive();
const handle = z.string().regex(FORM_HANDLE_PATTERN, "Lowercase letters, digits and single hyphens, like contact.").max(80);
const notifyEmail = z
  .string()
  .trim()
  .toLowerCase()
  .refine(isEmail, "That is not an email address.")
  .nullable();

async function ownedSite(ctx: ActionContext, id: number) {
  if (!ctx.actor.orgId) throw notFound("Site");
  const [row] = await ctx.db
    .select({ id: sites.id })
    .from(sites)
    .where(and(eq(sites.id, id), ownSites(ctx.actor.orgId)))
    .limit(1);
  if (!row) throw notFound("Site");
  return row;
}

async function ownedForm(ctx: ActionContext, formId: number) {
  if (!ctx.actor.orgId) throw notFound("Form");
  const [row] = await ctx.db
    .select()
    .from(siteForms)
    .where(and(eq(siteForms.id, formId), siteScope(ctx.actor.orgId, siteForms.siteId)))
    .limit(1);
  if (!row) throw notFound("Form");
  return row;
}

function handleFromName(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-+|-+$)/g, "")
      .slice(0, 60)
      .replace(/-+$/, "") || "form"
  );
}

export const createForm = defineAction({
  id: "forms.createForm",
  description:
    "Create a storefront form — fields (text, email, tel, textarea, select, checkbox), the button's " +
    "label, the thank-you message and the address each submission is emailed to (null: stored only). " +
    "It is live at /forms/{handle} at once, and a form block can place it on any page. The handle " +
    "comes from the name unless given, and cannot change later.",
  input: z
    .object({
      siteId,
      name: z.string().trim().min(1).max(120),
      handle: handle.optional(),
      fields: formFieldsSchema,
      submitLabel: z.string().trim().min(1).max(40).default("Send"),
      successMessage: z.string().trim().max(500).default(""),
      notifyEmail: notifyEmail.default(null),
    })
    .strict(),
  permission: "cms.write",
  riskTier: "low",
  undoable: true,
  inverse: (r) => ({ actionId: "forms.deleteForm", input: { formId: (r.result as { formId: number }).formId }, conflictCheck: "none" }),
  async run(input, ctx) {
    await ownedSite(ctx, input.siteId);
    const existing = await ctx.db.select({ handle: siteForms.handle }).from(siteForms).where(eq(siteForms.siteId, input.siteId));
    if (existing.length >= FORMS_PER_SITE) throw new ApiError("CONFLICT", 409, `A store can keep ${FORMS_PER_SITE} forms.`, { reason: "limit" });
    const taken = new Set(existing.map((f) => f.handle));
    if (input.handle && taken.has(input.handle)) {
      throw new ApiError("CONFLICT", 409, `A form already uses /forms/${input.handle}.`, { reason: "handle_taken" });
    }
    let formHandle = input.handle ?? handleFromName(input.name);
    for (let n = 2; !input.handle && taken.has(formHandle); n++) formHandle = `${handleFromName(input.name).slice(0, 56)}-${n}`;
    const [row] = await ctx.db
      .insert(siteForms)
      .values({
        siteId: input.siteId,
        handle: formHandle,
        name: input.name,
        fields: input.fields,
        submitLabel: input.submitLabel,
        successMessage: input.successMessage,
        notifyEmail: input.notifyEmail,
        createdBy: `${ctx.actor.type}:${ctx.actor.id}`,
      })
      .returning();
    ctx.recordDiff({ entity: "form", entityId: String(row.id), path: "form", before: null, after: { handle: row.handle, name: row.name } });
    return { formId: row.id, handle: row.handle, path: `/forms/${row.handle}` };
  },
});

const editable = ["name", "fields", "submitLabel", "successMessage", "notifyEmail"] as const;

export const updateForm = defineAction({
  id: "forms.updateForm",
  description:
    "Change a form's name, fields, button label, thank-you message or notification address. Only the " +
    "fields given change, and the change is live at once. Past submissions keep the labels they were " +
    "sent with. The handle cannot change — pages name the form by it.",
  input: z
    .object({
      formId: z.number().int().positive(),
      name: z.string().trim().min(1).max(120).optional(),
      fields: formFieldsSchema.optional(),
      submitLabel: z.string().trim().min(1).max(40).optional(),
      successMessage: z.string().trim().max(500).optional(),
      notifyEmail: notifyEmail.optional(),
    })
    .strict(),
  permission: "cms.write",
  riskTier: "low",
  undoable: true,
  inverse: patchInverse({ actionId: "forms.updateForm", idField: "formId" }),
  async run(input, ctx) {
    const form = await ownedForm(ctx, input.formId);
    const current = form as Record<string, unknown>;
    const changed: Record<string, unknown> = {};
    for (const key of editable) {
      const next = input[key];
      if (next === undefined || JSON.stringify(current[key] ?? null) === JSON.stringify(next ?? null)) continue;
      changed[key] = next;
      ctx.recordDiff({ entity: "form", entityId: String(form.id), path: key, before: current[key] ?? null, after: next ?? null });
    }
    if (Object.keys(changed).length > 0) {
      await ctx.db.update(siteForms).set({ ...changed, updatedAt: new Date() }).where(eq(siteForms.id, form.id));
    }
    return { formId: form.id, handle: form.handle, changed: Object.keys(changed) };
  },
});

export const deleteForm = defineAction({
  id: "forms.deleteForm",
  description:
    "Delete a form. Refused while any page of the design — draft or live — still shows it. Its " +
    "submissions are kept (they are permanent) and stay readable. Cannot be undone.",
  input: z.object({ formId: z.number().int().positive() }).strict(),
  permission: "cms.write",
  riskTier: "medium",
  undoable: false,
  async run(input, ctx) {
    const form = await ownedForm(ctx, input.formId);
    // A block names a form by handle; look for it in the draft and the live tree alike.
    const needle = `%"formHandle": "${form.handle}"%`;
    const needleCompact = `%"formHandle":"${form.handle}"%`;
    const using = await ctx.db
      .select({ title: siteDocuments.title })
      .from(siteDocuments)
      .where(
        and(
          eq(siteDocuments.siteId, form.siteId),
          or(
            sql`${siteDocuments.draftTree}::text like ${needle}`,
            sql`${siteDocuments.publishedTree}::text like ${needle}`,
            sql`${siteDocuments.draftTree}::text like ${needleCompact}`,
            sql`${siteDocuments.publishedTree}::text like ${needleCompact}`,
          ),
        ),
      );
    if (using.length > 0) {
      throw new ApiError("CONFLICT", 409, `This form is on ${using.map((u) => `"${u.title}"`).join(", ")}. Remove it there first.`, {
        reason: "in_use",
        pages: using.map((u) => u.title),
      });
    }
    await ctx.db.delete(siteForms).where(eq(siteForms.id, form.id));
    const [{ kept }] = await ctx.db.select({ kept: count() }).from(formSubmissions).where(and(eq(formSubmissions.siteId, form.siteId), eq(formSubmissions.formHandle, form.handle)));
    ctx.recordDiff({ entity: "form", entityId: String(form.id), path: "form", before: { handle: form.handle, name: form.name }, after: null });
    return { formId: form.id, submissionsKept: kept };
  },
});

/**
 * Erase one submission — how a merchant honours a request to delete what
 * someone sent. Submissions never expire on their own (owner, 2026-11-22), so
 * this is the only way one goes. Customer data, so `commerce.write`.
 */
export const deleteSubmission = defineAction({
  id: "forms.deleteSubmission",
  description: "Delete one form submission for good — for an erasure request. Submissions never expire on their own. Cannot be undone.",
  input: z.object({ submissionId: z.number().int().positive() }).strict(),
  permission: "commerce.write",
  riskTier: "medium",
  undoable: false,
  async run(input, ctx) {
    if (!ctx.actor.orgId) throw notFound("Submission");
    const [row] = await ctx.db
      .delete(formSubmissions)
      .where(and(eq(formSubmissions.id, input.submissionId), siteScope(ctx.actor.orgId, formSubmissions.siteId)))
      .returning({ id: formSubmissions.id, formHandle: formSubmissions.formHandle });
    if (!row) throw notFound("Submission");
    // What was erased is not recorded — the audit row must not keep what the erasure removed.
    ctx.recordDiff({ entity: "formSubmission", entityId: String(row.id), path: "submission", before: { form: row.formHandle }, after: null });
    return { submissionId: row.id };
  },
});

export const blockSender = defineAction({
  id: "forms.blockSender",
  description:
    "Refuse this store's form submissions from an email address (someone@example.com) or a whole " +
    "domain (@example.com, which also covers its subdomains). Checked before anything is stored or sent.",
  input: z.object({ siteId, pattern: z.string().min(1).max(254), note: z.string().trim().max(200).default("") }).strict(),
  permission: "commerce.write",
  riskTier: "low",
  undoable: true,
  inverse: (r) => ({
    actionId: "forms.unblockSender",
    input: { siteId: (r.input as { siteId: number }).siteId, entryId: (r.result as { entryId: number }).entryId },
    conflictCheck: "none",
  }),
  async run(input, ctx) {
    await ownedSite(ctx, input.siteId);
    const pattern = normalizeBlockPattern(input.pattern);
    if (!pattern) throw new ApiError("VALIDATION_ERROR", 400, "Give an email address or a domain like @example.com.", { field: "pattern" });
    const [existing] = await ctx.db
      .select({ id: formBlocklist.id })
      .from(formBlocklist)
      .where(and(eq(formBlocklist.siteId, input.siteId), eq(formBlocklist.pattern, pattern)))
      .limit(1);
    if (existing) throw new ApiError("CONFLICT", 409, `${pattern} is already blocked.`, { reason: "already_blocked" });
    const [{ n }] = await ctx.db.select({ n: count() }).from(formBlocklist).where(eq(formBlocklist.siteId, input.siteId));
    if (n >= BLOCKLIST_PER_SITE) throw new ApiError("CONFLICT", 409, `A store can block ${BLOCKLIST_PER_SITE} senders.`, { reason: "limit" });
    const [row] = await ctx.db
      .insert(formBlocklist)
      .values({ siteId: input.siteId, pattern, note: input.note, createdBy: `${ctx.actor.type}:${ctx.actor.id}` })
      .returning({ id: formBlocklist.id });
    ctx.recordDiff({ entity: "formBlock", entityId: String(row.id), path: "block", before: null, after: { pattern, note: input.note } });
    return { entryId: row.id, pattern };
  },
});

export const unblockSender = defineAction({
  id: "forms.unblockSender",
  description: "Remove an entry from this store's form blocklist.",
  input: z.object({ siteId, entryId: z.number().int().positive() }).strict(),
  permission: "commerce.write",
  riskTier: "low",
  undoable: true,
  inverse: (r) => {
    const d = r.diff.find((x) => x.path === "block");
    const before = d?.before as { pattern: string; note: string } | null | undefined;
    if (!before) return null;
    return { actionId: "forms.blockSender", input: { siteId: (r.input as { siteId: number }).siteId, ...before }, conflictCheck: "none" };
  },
  async run(input, ctx) {
    await ownedSite(ctx, input.siteId);
    const [row] = await ctx.db
      .delete(formBlocklist)
      .where(and(eq(formBlocklist.id, input.entryId), eq(formBlocklist.siteId, input.siteId)))
      .returning();
    if (!row) throw notFound("Blocklist entry");
    ctx.recordDiff({ entity: "formBlock", entityId: String(row.id), path: "block", before: { pattern: row.pattern, note: row.note }, after: null });
    return { entryId: row.id, pattern: row.pattern };
  },
});
