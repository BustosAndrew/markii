import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { db, formBlocklist, formSubmissions, siteForms, type SiteForm } from "@/lib/db";
import { sendPlatformMail } from "@/lib/email";
import { consumeRateLimit } from "@/lib/rate-limit-store";
import type { RateLimitDecision, RateLimitPolicy } from "@/lib/rate-limit";
import { FORM_RATE_LIMITS, blockedBy, candidatePatterns, formLimitKeys, notificationText, parseSubmission } from "./rules";

/**
 * A storefront form submission, start to finish. The order is the protection:
 *
 * 1. **Rate limits on the address and the store**, counted before the body is
 *    even parsed — a script sending garbage is still a script.
 * 2. **The answers**, checked against the form's fields.
 * 3. **The sender's email**: its own rate limit, then the store's blocklist.
 *    A blocked sender is refused before anything is stored or mailed.
 * 4. **Stored** — permanently (owner, 2026-11-22).
 * 5. **Emailed** to the form's address when it has one, after the row exists,
 *    so a mail outage costs an email and never a submission. The outcome is
 *    recorded on the row: `sent`, `failed` with the reason, or `off`.
 *
 * The notification is Markii's mail to the merchant about their store, so it
 * goes by the platform stream (`sendPlatformMail`), with the sender as
 * Reply-To so the merchant answers them directly.
 */

export type SubmitOutcome =
  | { ok: true; submissionId: number; notify: "sent" | "failed" | "off" }
  | { ok: false; reason: "rate_limited"; decision: RateLimitDecision; policy: RateLimitPolicy }
  | { ok: false; reason: "invalid"; errors: { field: string; message: string }[] }
  | { ok: false; reason: "refused" };

export async function formByHandle(siteId: number, handle: string): Promise<SiteForm | null> {
  const [row] = await db
    .select()
    .from(siteForms)
    .where(and(eq(siteForms.siteId, siteId), eq(siteForms.handle, handle)))
    .limit(1);
  return row ?? null;
}

/** A form as the storefront draws it (`@markii/renderer/forms` `RenderForm`), or null. */
export async function renderFormByHandle(siteId: number, handle: string) {
  const form = await formByHandle(siteId, handle);
  return form ? { handle: form.handle, name: form.name, fields: form.fields, submitLabel: form.submitLabel } : null;
}

export async function submitForm(opts: {
  site: { id: number; name: string };
  form: SiteForm;
  input: Record<string, unknown>;
  ip: string | null;
}): Promise<SubmitOutcome> {
  const { site, form } = opts;

  if (opts.ip) {
    const d = await consumeRateLimit(formLimitKeys.ip(site.id, opts.ip), FORM_RATE_LIMITS.ip);
    if (!d.allowed) return { ok: false, reason: "rate_limited", decision: d, policy: FORM_RATE_LIMITS.ip };
  }
  const storeDecision = await consumeRateLimit(formLimitKeys.store(site.id), FORM_RATE_LIMITS.store);
  if (!storeDecision.allowed) return { ok: false, reason: "rate_limited", decision: storeDecision, policy: FORM_RATE_LIMITS.store };

  const parsed = parseSubmission(form.fields, opts.input);
  if (!parsed.ok) return { ok: false, reason: "invalid", errors: parsed.errors };

  if (parsed.email) {
    const d = await consumeRateLimit(formLimitKeys.email(site.id, parsed.email), FORM_RATE_LIMITS.email);
    if (!d.allowed) return { ok: false, reason: "rate_limited", decision: d, policy: FORM_RATE_LIMITS.email };
    const rows = await db
      .select({ pattern: formBlocklist.pattern })
      .from(formBlocklist)
      .where(and(eq(formBlocklist.siteId, site.id), inArray(formBlocklist.pattern, candidatePatterns(parsed.email))));
    if (blockedBy(parsed.email, rows.map((r) => r.pattern))) return { ok: false, reason: "refused" };
  }

  const [row] = await db
    .insert(formSubmissions)
    .values({
      siteId: site.id,
      formId: form.id,
      formHandle: form.handle,
      formName: form.name,
      values: parsed.values,
      email: parsed.email,
      notifyStatus: form.notifyEmail ? "pending" : "off",
    })
    .returning({ id: formSubmissions.id });

  if (!form.notifyEmail) return { ok: true, submissionId: row.id, notify: "off" };

  let status: "sent" | "failed" = "failed";
  let error: string | null = null;
  try {
    const result = await sendPlatformMail({
      to: form.notifyEmail,
      subject: `New message: ${form.name} — ${site.name}`,
      text: notificationText(site.name, form.name, parsed.values),
      ...(parsed.email ? { replyTo: parsed.email } : {}),
    });
    if (result.sent) status = "sent";
    else error = result.reason;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  await db
    .update(formSubmissions)
    .set({ notifyStatus: status, notifyError: error?.slice(0, 500) ?? null })
    .where(eq(formSubmissions.id, row.id));
  return { ok: true, submissionId: row.id, notify: status };
}
