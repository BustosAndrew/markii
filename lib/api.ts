import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { sanitizePublicCopy, sanitizePublicValue } from "@/lib/api/public-copy";

export class ApiError extends Error {
  constructor(
    public code:
      | "VALIDATION_ERROR"
      | "UNAUTHORIZED"
      | "FORBIDDEN"
      | "NOT_FOUND"
      | "CONFLICT"
      | "IMPORT_FAILED"
      /**
       * A capability this deployment has not been given the credentials for.
       * Already the code every unbacked surface returns by hand
       * (`lib/payments/`, `app/api/billing/`, `lib/email/`); listing it here is
       * what lets an **action** refuse the same way, since an action can only
       * signal by throwing.
       */
      | "CONFIGURATION_REQUIRED"
      /** A third party answered, and the answer was no. Distinct from our own misconfiguration. */
      | "UPSTREAM_ERROR"
      /**
       * Authenticated, but the second factor is missing or stale (D40). **Not**
       * `UNAUTHORIZED`: the caller is who they say they are, and telling them to
       * sign in again would send them round a loop that cannot fix it. The
       * `details.gate` says whether to enrol, challenge, or step up.
       */
      | "MFA_REQUIRED"
      | "INTERNAL",
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new ApiError("NOT_FOUND", 404, `${what} not found`);
export const conflict = (message: string) => new ApiError("CONFLICT", 409, message);
export const badRequest = (message: string, details?: unknown) =>
  new ApiError("VALIDATION_ERROR", 400, message, details);
export const unauthorized = (message = "Authentication required") =>
  new ApiError("UNAUTHORIZED", 401, message);
export const forbidden = (message: string) => new ApiError("FORBIDDEN", 403, message);

export function errorResponse(e: unknown): NextResponse {
  if (e instanceof ZodError) {
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "Invalid input", details: e.issues } },
      { status: 400 },
    );
  }
  if (e instanceof ApiError) {
    const message =
      sanitizePublicCopy(e.message) ||
      (e.code === "CONFIGURATION_REQUIRED"
        ? "This feature needs additional platform configuration."
        : "Request failed");
    return NextResponse.json(
      {
        error: {
          code: e.code,
          message,
          ...(e.details !== undefined ? { details: sanitizePublicValue(e.details) } : {}),
        },
      },
      { status: e.status },
    );
  }
  console.error(e);
  // Never echo raw exception text — stacks and driver errors are for logs only.
  return NextResponse.json(
    { error: { code: "INTERNAL", message: "Something went wrong." } },
    { status: 500 },
  );
}

type RouteCtx = { params: Promise<Record<string, string>> };

/** Wraps a route handler with uniform error handling. */
export function handler(fn: (req: Request, ctx: RouteCtx) => Promise<Response>) {
  return async (req: Request, ctx: RouteCtx): Promise<Response> => {
    try {
      return await fn(req, ctx);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export function pagination(sp: URLSearchParams) {
  const page = Math.max(1, parseInt(sp.get("page") ?? "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(sp.get("limit") ?? "20", 10) || 20));
  return { page, limit, offset: (page - 1) * limit };
}

export function boolParam(sp: URLSearchParams, name: string): boolean | undefined {
  const v = sp.get(name);
  return v == null ? undefined : v === "true";
}

export function intParam(sp: URLSearchParams, name: string): number | undefined {
  const v = sp.get(name);
  if (v == null || v === "") return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * A filter whose value must be one of a fixed set.
 *
 * An unrecognised value is a **400, never a silent no-op**: dropping it would
 * answer `?status=refunded` (a status that does not exist on that column) with
 * the unfiltered list, and a merchant reading a screen has no way to tell an
 * empty filter from one that matched everything.
 */
export function enumParam<T extends string>(
  sp: URLSearchParams,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const v = sp.get(name);
  if (v == null || v === "") return undefined;
  if (!(allowed as readonly string[]).includes(v)) {
    throw badRequest(`invalid ${name}: expected one of ${allowed.join(", ")}`);
  }
  return v as T;
}

/** `from`/`to` filters (inclusive; date-only `to` extends to end of day). */
export function dateRange(sp: URLSearchParams): { from?: Date; to?: Date } {
  const parse = (name: string, endOfDay: boolean): Date | undefined => {
    const v = sp.get(name);
    if (!v) return undefined;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return undefined;
    if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(v)) d.setUTCHours(23, 59, 59, 999);
    return d;
  };
  return { from: parse("from", false), to: parse("to", true) };
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-+|-+$)/g, "") || "item"
  );
}

export function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

// ---------- URLs ----------

/** Base URL of the platform itself, without any tenant subdomain. */
export function appUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_APP_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  // Vercel sets these automatically; prefer the stable production host
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
  if (vercel) return `https://${vercel.replace(/\/$/, "")}`;
  return "http://localhost:3000";
}

/**
 * Public base URL for a tenant storefront.
 *
 * Two hosts get the path form instead of a subdomain, both because the
 * subdomain URL would not load:
 *
 * - **`*.vercel.app`** — Vercel's certificate is a single-level wildcard, so it
 *   does not cover `{slug}.{project}.vercel.app`; those hosts fail the TLS
 *   handshake outright (ERR_CONNECTION_CLOSED).
 * - **`localhost`** — nothing serves TLS on port 443 in development, so
 *   `https://{slug}.localhost` is refused. This is not only a developer
 *   annoyance: §18.8 puts this URL in a *download link handed to a buyer*, and
 *   an unreachable one means the goods never arrive.
 *
 * This returns an absolute URL in every case, which is what callers embedding it
 * in a receipt or an email need.
 */
export function tenantBaseUrl(slug: string): string {
  const root = process.env.ROOT_DOMAIN?.replace(/^\.|\/$/g, "");
  const subdomainWorks =
    root && !root.endsWith(".vercel.app") && root !== "localhost" && !root.startsWith("localhost:");
  if (subdomainWorks) return `https://${slug}.${root}`;
  return `${appUrl()}/_sites/${slug}`;
}
