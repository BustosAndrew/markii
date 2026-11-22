import "server-only";

import { and, asc, count, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { notFound } from "@/lib/api";
import { db, formBlocklist, formSubmissions, siteForms, type SiteForm } from "@/lib/db";

/** Dashboard reads for forms, submissions and the blocklist. Callers resolve the site first. */

function formView(f: SiteForm, submissions: number) {
  return {
    id: f.id,
    handle: f.handle,
    name: f.name,
    path: `/forms/${f.handle}`,
    fields: f.fields,
    submitLabel: f.submitLabel,
    successMessage: f.successMessage,
    notifyEmail: f.notifyEmail,
    submissions,
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
  };
}

export async function listForms(siteId: number) {
  const [forms, counts] = await Promise.all([
    db.select().from(siteForms).where(eq(siteForms.siteId, siteId)).orderBy(asc(siteForms.name)),
    db
      .select({ handle: formSubmissions.formHandle, n: count() })
      .from(formSubmissions)
      .where(eq(formSubmissions.siteId, siteId))
      .groupBy(formSubmissions.formHandle),
  ]);
  const byHandle = new Map(counts.map((c) => [c.handle, c.n]));
  return forms.map((f) => formView(f, byHandle.get(f.handle) ?? 0));
}

export async function getForm(siteId: number, formId: number) {
  const [row] = await db
    .select()
    .from(siteForms)
    .where(and(eq(siteForms.siteId, siteId), eq(siteForms.id, formId)))
    .limit(1);
  if (!row) throw notFound("Form");
  const [{ n }] = await db
    .select({ n: count() })
    .from(formSubmissions)
    .where(and(eq(formSubmissions.siteId, siteId), eq(formSubmissions.formHandle, row.handle)));
  return formView(row, n);
}

function escapeLike(q: string) {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Submissions, newest first. Filter by the form's handle — not its id, so a
 * deleted form's submissions are still reachable — and search the sender's
 * email or any answer.
 */
export async function listSubmissions(siteId: number, opts: { form?: string; q?: string; limit: number; offset: number }) {
  const conditions: SQL[] = [eq(formSubmissions.siteId, siteId)];
  if (opts.form) conditions.push(eq(formSubmissions.formHandle, opts.form));
  if (opts.q) {
    const like = escapeLike(opts.q);
    conditions.push(or(ilike(formSubmissions.email, like), sql`${formSubmissions.values}::text ilike ${like}`)!);
  }
  const where = and(...conditions);
  const [rows, [{ total }]] = await Promise.all([
    db.select().from(formSubmissions).where(where).orderBy(desc(formSubmissions.createdAt), desc(formSubmissions.id)).limit(opts.limit).offset(opts.offset),
    db.select({ total: count() }).from(formSubmissions).where(where),
  ]);
  return {
    total,
    items: rows.map((r) => ({
      id: r.id,
      form: { handle: r.formHandle, name: r.formName, exists: r.formId !== null },
      values: r.values,
      email: r.email,
      notify: { status: r.notifyStatus, error: r.notifyError },
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

export async function listBlocklist(siteId: number) {
  const rows = await db.select().from(formBlocklist).where(eq(formBlocklist.siteId, siteId)).orderBy(asc(formBlocklist.pattern));
  return rows.map((r) => ({ id: r.id, pattern: r.pattern, note: r.note, createdBy: r.createdBy, createdAt: r.createdAt.toISOString() }));
}
