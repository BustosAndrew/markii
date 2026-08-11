/**
 * Strip internal planning refs, repo paths, and credential hints from anything
 * shown to merchants, shoppers, or agents. Backend/docs IDs belong in logs.
 */

const INTERNAL_REF =
  /\b(?:docs\/[A-Za-z0-9._/-]+|API\s*§\d+(?:\.\d+)?|§\d+(?:\.\d+)?(?:\s+rule\s+\d+)?|Phase\s+[A-F]|G\d{1,2}|D\d{2,3}|CLAUDE\.md|DECISIONS\.md|BACKEND\.md|FRONTEND\.md|PRICING\.md|PLAN\.md|AGENT-OPS\.md|COMPETITORS\.md|BUILDER\.md|DESIGN\.md|PRODUCT\.md)\b/gi;

/** Env var names and local-path hints that help attackers more than merchants. */
const OPS_HINT =
  /\b(?:STRIPE_SECRET_KEY|STRIPE_CONNECT_CLIENT_ID|STRIPE_CONNECT_REDIRECT_URI|SUPABASE_SERVICE_ROLE_KEY|DATABASE_URL|AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|AWS_SESSION_TOKEN|RESEND_API_KEY|NEXT_PUBLIC_SUPABASE_URL|NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY|BASE_SEPOLIA_RPC_URL|CRON_SECRET|\.env(?:\.local|\.example)?|lib\/[A-Za-z0-9._/-]+\.ts)\b/g;

const SAFE_CONFIG =
  "This deployment needs additional platform configuration. Contact your Markii admin.";

export function sanitizePublicCopy(text: string): string {
  let out = text
    .replace(INTERNAL_REF, "")
    .replace(OPS_HINT, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+—\s*$/g, "")
    .replace(/\s+-\s*$/g, "")
    .trim();

  // After stripping env names, "Set  so …" collapses into noise — replace whole tips.
  if (/^set\b/i.test(out) && out.length < 180) {
    return SAFE_CONFIG;
  }
  if (/\bsee\s*$/i.test(out) || /\bsee\s+\.?$/i.test(out)) {
    out = out.replace(/\bsee\s+\.?$/i, "").trim();
  }
  return out;
}

/** Recursively sanitize strings in JSON-ish error details before they leave the server. */
export function sanitizePublicValue<T>(value: T): T {
  if (typeof value === "string") {
    return sanitizePublicCopy(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePublicValue(item)) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      // Drop fields that only exist for engineers / agents building Markii itself.
      if (key === "phase" && typeof child === "string" && /^[A-F]$/.test(child)) continue;
      if (key === "note" && typeof child === "string" && /add_on_|organizations\./i.test(child)) {
        continue;
      }
      out[key] = sanitizePublicValue(child);
    }
    return out as T;
  }
  return value;
}

/** Safe message from any thrown value for UI display. */
export function publicErrorMessage(
  error: unknown,
  fallback = "Something went wrong. Try again.",
): string {
  if (error instanceof Error && error.message.trim()) {
    const cleaned = sanitizePublicCopy(error.message);
    return cleaned || fallback;
  }
  return fallback;
}

/** Merchant-safe stand-in when a deployment credential is missing. */
export const PUBLIC_CONFIGURATION_RESOLUTION = SAFE_CONFIG;
