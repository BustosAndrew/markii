/**
 * Storefront form rules — pure, so the submit route, the actions and a test
 * apply the same ones. Spam protection is two things (owner, 2026-11-22):
 * **rate limits** and a **per-store blocklist** checked against the
 * submitter's email before anything is stored or sent.
 */
import { createHash } from "node:crypto";
import type { RateLimitPolicy } from "@/lib/rate-limit";
import { limitFromEnv } from "@/lib/rate-limit";
import { maxLengthOf, type FormField } from "@markii/renderer/forms";

export const FORMS_PER_SITE = 50;
export const BLOCKLIST_PER_SITE = 5_000;

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;

export function isEmail(value: string): boolean {
  return value.length <= 254 && EMAIL.test(value);
}

/**
 * Three limits, checked in this order:
 *
 * - **Per client address, per store: 5 / 10 min.** One person writing in does
 *   not send six messages in ten minutes; a script does.
 * - **Per submitter email, per store: 3 / hour.** The same sender rotating
 *   addresses still runs out.
 * - **Per store: 100 / hour.** The flood ceiling across every sender — it is
 *   what keeps a botnet from filling a merchant's inbox, and Markii's mail
 *   account, with one email per submission.
 *
 * Overridable by env for an incident (`FORM_RATE_LIMIT_*`), never below one.
 */
export const FORM_RATE_LIMITS: { ip: RateLimitPolicy; email: RateLimitPolicy; store: RateLimitPolicy } = {
  ip: { limit: limitFromEnv("FORM_RATE_LIMIT_IP", 5), windowMs: 10 * 60_000 },
  email: { limit: limitFromEnv("FORM_RATE_LIMIT_EMAIL", 3), windowMs: 60 * 60_000 },
  store: { limit: limitFromEnv("FORM_RATE_LIMIT_STORE", 100), windowMs: 60 * 60_000 },
};

/** Keys hold a hash, never the address or the email — the counter table is not a list of who wrote in. */
function digest(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 32);
}
export const formLimitKeys = {
  ip: (siteId: number, ip: string) => `form:ip:${siteId}:${digest(ip)}`,
  email: (siteId: number, email: string) => `form:email:${siteId}:${digest(email.toLowerCase())}`,
  store: (siteId: number) => `form:store:${siteId}`,
};

/**
 * A blocklist entry as stored: an address, or a domain written `@example.com`
 * (a bare `example.com` is read as the domain). Lower case. Null when it is
 * neither — a typo must not become a rule that blocks nothing.
 */
export function normalizeBlockPattern(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!s || s.length > 254 || /\s/.test(s)) return null;
  if (s.includes("@") && !s.startsWith("@")) return isEmail(s) ? s : null;
  const domain = s.replace(/^@/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) ? `@${domain}` : null;
}

/**
 * Whether an email is blocked: its exact address, its domain, or any parent
 * domain — `@example.com` also blocks `mail.example.com`, since a sender who
 * owns a domain owns its subdomains.
 */
export function blockedBy(email: string, patterns: Iterable<string>): string | null {
  const address = email.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at < 0) return null;
  const set = new Set(patterns);
  if (set.has(address)) return address;
  const labels = address.slice(at + 1).split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = `@${labels.slice(i).join(".")}`;
    if (set.has(candidate)) return candidate;
  }
  return null;
}

/** The patterns that could block `email` — what to look up, so the check is one indexed read. */
export function candidatePatterns(email: string): string[] {
  const address = email.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at < 0) return [];
  const labels = address.slice(at + 1).split(".");
  const out = [address];
  for (let i = 0; i < labels.length - 1; i++) out.push(`@${labels.slice(i).join(".")}`);
  return out;
}

export type ParsedSubmission =
  | { ok: true; values: { name: string; label: string; value: string | boolean }[]; email: string | null }
  | { ok: false; errors: { field: string; message: string }[] };

/**
 * A submission checked against its form, answer by answer. Unknown keys are
 * dropped rather than stored — a form post can carry anything, and only what
 * the merchant asked for is kept.
 */
export function parseSubmission(fields: FormField[], input: Record<string, unknown>): ParsedSubmission {
  const errors: { field: string; message: string }[] = [];
  const values: { name: string; label: string; value: string | boolean }[] = [];
  let email: string | null = null;

  for (const field of fields) {
    const raw = input[field.name];
    if (field.type === "checkbox") {
      const checked = raw === true || raw === "yes" || raw === "on" || raw === "true";
      if (field.required && !checked) errors.push({ field: field.name, message: `${field.label} must be ticked.` });
      values.push({ name: field.name, label: field.label, value: checked });
      continue;
    }
    const text = typeof raw === "string" ? raw.replace(/\r\n?/g, "\n").trim() : typeof raw === "number" ? String(raw) : "";
    if (!text) {
      if (field.required) errors.push({ field: field.name, message: `${field.label} is required.` });
      values.push({ name: field.name, label: field.label, value: "" });
      continue;
    }
    if (text.length > maxLengthOf(field)) {
      errors.push({ field: field.name, message: `${field.label} is longer than ${maxLengthOf(field)} characters.` });
      continue;
    }
    if (field.type !== "textarea" && text.includes("\n")) {
      errors.push({ field: field.name, message: `${field.label} must be on one line.` });
      continue;
    }
    if (field.type === "email") {
      if (!isEmail(text)) {
        errors.push({ field: field.name, message: `${field.label} is not an email address.` });
        continue;
      }
      email ??= text.toLowerCase();
    }
    if (field.type === "select" && !(field.options ?? []).includes(text)) {
      errors.push({ field: field.name, message: `${field.label} must be one of the choices.` });
      continue;
    }
    values.push({ name: field.name, label: field.label, value: text });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, values, email };
}

/** The notification email's text — every answer, labelled, in the form's order. */
export function notificationText(storeName: string, formName: string, values: { label: string; value: string | boolean }[]): string {
  const lines = values.map((v) => `${v.label}:\n${typeof v.value === "boolean" ? (v.value ? "Yes" : "No") : v.value || "—"}`);
  return [`New message from the "${formName}" form on ${storeName}.`, "", ...lines.flatMap((l) => [l, ""]), "Reply to this email to answer the sender directly."].join("\n");
}
