import { NextResponse } from "next/server";
import { ZodError } from "zod";

export class ApiError extends Error {
  constructor(
    public code:
      | "VALIDATION_ERROR"
      | "UNAUTHORIZED"
      | "FORBIDDEN"
      | "NOT_FOUND"
      | "CONFLICT"
      | "IMPORT_FAILED"
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
    return NextResponse.json(
      {
        error: {
          code: e.code,
          message: e.message,
          ...(e.details !== undefined ? { details: e.details } : {}),
        },
      },
      { status: e.status },
    );
  }
  console.error(e);
  return NextResponse.json(
    { error: { code: "INTERNAL", message: e instanceof Error ? e.message : "Internal error" } },
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
 * Vercel's certificate is a single-level wildcard (`*.vercel.app`), so it does not
 * cover `{slug}.{project}.vercel.app` — those hosts fail the TLS handshake outright
 * (ERR_CONNECTION_CLOSED). When ROOT_DOMAIN is a vercel.app host we therefore fall
 * back to the path form rather than hand out a URL that cannot load.
 */
export function tenantBaseUrl(slug: string): string {
  const root = process.env.ROOT_DOMAIN?.replace(/^\.|\/$/g, "");
  if (root && !root.endsWith(".vercel.app")) return `https://${slug}.${root}`;
  return `${appUrl()}/_sites/${slug}`;
}
