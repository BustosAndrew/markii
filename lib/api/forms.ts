import type { FormField } from "@markii/renderer/forms";
import { invokeAction } from "./actions";
import { apiGet } from "./client";
import { callWhenLive } from "./planned";

const SECTION = "API §19 (storefront forms)";

/**
 * ✅ LIVE — storefront forms (2026-11-22). **Needs migration 0053.**
 *
 * A form is live at `/forms/{handle}` the moment it exists, and a `form`
 * builder block (`formHandle`) places it on any page. Shoppers post a plain
 * HTML form — no script. Protection (owner, 2026-11-22): **rate limits** (per
 * address 5/10 min, per sender email 3/hour, per store 100/hour) and the
 * store's **blocklist**, checked against the sender's email before anything is
 * stored. Each submission is emailed to `notifyEmail` when set, Reply-To the
 * sender. **Submissions are kept permanently**; one is erased by hand with
 * `deleteFormSubmission`.
 *
 * Permissions: the form is `cms.read`/`cms.write`; submissions and the
 * blocklist are customer data — `commerce.read`/`commerce.write`.
 */
const FORMS_API_LIVE = true;

export type { FormField };

export type StoreForm = {
  id: number;
  /** Fixed once created — pages name the form by it. */
  handle: string;
  name: string;
  path: string;
  fields: FormField[];
  submitLabel: string;
  successMessage: string;
  notifyEmail: string | null;
  submissions: number;
  createdAt: string;
  updatedAt: string;
};

export type FormSubmissionItem = {
  id: number;
  /** `exists: false` — the form was deleted; its submissions stay. */
  form: { handle: string; name: string; exists: boolean };
  /** Each answer with the label it had when sent, in the form's order. */
  values: { name: string; label: string; value: string | boolean }[];
  email: string | null;
  /** `sent`, `failed` (see `error`), `off` (the form emails no one) or `pending`. */
  notify: { status: "sent" | "failed" | "off" | "pending"; error: string | null };
  createdAt: string;
};

export type BlocklistEntry = { id: number; pattern: string; note: string; createdBy: string; createdAt: string };

export function listForms(site: number | string, init?: RequestInit) {
  return callWhenLive(FORMS_API_LIVE, SECTION, () => apiGet<{ siteId: number; items: StoreForm[] }>(`/api/sites/${site}/forms`, undefined, init));
}

export function getForm(site: number | string, formId: number, init?: RequestInit) {
  return callWhenLive(FORMS_API_LIVE, SECTION, () => apiGet<StoreForm>(`/api/sites/${site}/forms/${formId}`, undefined, init));
}

/** `commerce.read`. `form` is a handle — it finds a deleted form's submissions too. */
export function listFormSubmissions(
  site: number | string,
  query: { form?: string; q?: string; limit?: number; offset?: number } = {},
  init?: RequestInit,
) {
  return callWhenLive(FORMS_API_LIVE, SECTION, () =>
    apiGet<{ siteId: number; total: number; items: FormSubmissionItem[] }>(`/api/sites/${site}/form-submissions`, query, init),
  );
}

export function listFormBlocklist(site: number | string, init?: RequestInit) {
  return callWhenLive(FORMS_API_LIVE, SECTION, () => apiGet<{ siteId: number; items: BlocklistEntry[] }>(`/api/sites/${site}/form-blocklist`, undefined, init));
}

export type FormFieldsInput = Omit<FormField, "required"> & { required?: boolean };

/** `409 handle_taken` / `limit` (50 per store). Validation names the field (`details`). Undoable. */
export function createForm(
  body: { siteId: number; name: string; handle?: string; fields: FormFieldsInput[]; submitLabel?: string; successMessage?: string; notifyEmail?: string | null },
  init?: RequestInit,
) {
  return invokeAction<{ formId: number; handle: string; path: string }>("forms.createForm", body, init);
}

/** Live at once. No `handle` — it is fixed. Undoable. */
export function updateForm(
  body: { formId: number; name?: string; fields?: FormFieldsInput[]; submitLabel?: string; successMessage?: string; notifyEmail?: string | null },
  init?: RequestInit,
) {
  return invokeAction<{ formId: number; handle: string; changed: string[] }>("forms.updateForm", body, init);
}

/** `409 in_use` with `details.pages` while a design page shows it. Submissions are kept. Not undoable. */
export function deleteForm(body: { formId: number }, init?: RequestInit) {
  return invokeAction<{ formId: number; submissionsKept: number }>("forms.deleteForm", body, init);
}

/** Erase one submission (an erasure request). `commerce.write`. Not undoable — confirm first. */
export function deleteFormSubmission(body: { submissionId: number }, init?: RequestInit) {
  return invokeAction<{ submissionId: number }>("forms.deleteSubmission", body, init);
}

/** `pattern`: `someone@example.com` or `@example.com` (subdomains included). `409 already_blocked`. Undoable. */
export function blockFormSender(body: { siteId: number; pattern: string; note?: string }, init?: RequestInit) {
  return invokeAction<{ entryId: number; pattern: string }>("forms.blockSender", body, init);
}

export function unblockFormSender(body: { siteId: number; entryId: number }, init?: RequestInit) {
  return invokeAction<{ entryId: number; pattern: string }>("forms.unblockSender", body, init);
}
