import { ApiClientError, type ApiErrorBody } from "./types";
import { isMfaRequired, mfaErrorDetails } from "./mfa-errors";
import { sanitizePublicCopy, sanitizePublicValue } from "./public-copy";

export type QueryValue = string | number | boolean | null | undefined;

/**
 * Step-up prompt for money-moving actions. Registered by the dashboard provider;
 * returns true when the merchant verified and the original request should retry.
 */
type StepUpHandler = (details: {
  gate: { status: string; reason?: string };
  stepUpWindowMs?: number;
  action?: string;
}) => Promise<boolean>;

let stepUpHandler: StepUpHandler | null = null;

export function registerMfaStepUpHandler(handler: StepUpHandler | null) {
  stepUpHandler = handler;
}

function isMfaAuthPath(path: string) {
  return path.includes("/api/auth/mfa");
}

export function buildQuery(params?: Record<string, QueryValue>): string {
  if (!params) return "";
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    // null is meaningful to the API (e.g. parentId=null → top-level only)
    sp.set(key, value === null ? "null" : String(value));
  }
  const q = sp.toString();
  return q ? `?${q}` : "";
}

/**
 * Server components run on Node, where fetch() rejects relative URLs — resolve
 * them against the request host (falling back to the configured app URL).
 */
async function absoluteUrl(path: string): Promise<string> {
  if (typeof window !== "undefined" || !path.startsWith("/")) return path;

  let origin = process.env.NEXT_PUBLIC_APP_URL;
  try {
    const { headers } = await import("next/headers");
    const h = await headers();
    const host = h.get("x-forwarded-host") ?? h.get("host");
    if (host) {
      const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
      origin = `${proto}://${host}`;
    }
  } catch {
    // outside a request scope (build-time prerender) — use the configured URL
  }

  return `${(origin ?? "http://localhost:3000").replace(/\/$/, "")}${path}`;
}

async function parseError(res: Response): Promise<ApiClientError> {
  let code = "INTERNAL";
  let message = res.statusText || "Request failed";
  let details: unknown | undefined;
  try {
    const body = (await res.json()) as ApiErrorBody;
    if (body?.error) {
      code = body.error.code || code;
      message = sanitizePublicCopy(body.error.message || message) || message;
      details =
        body.error.details !== undefined
          ? sanitizePublicValue(body.error.details)
          : undefined;
    }
  } catch {
    // non-JSON error body
  }
  return new ApiClientError(res.status, code, message, details);
}

async function handleMfaRequired(
  path: string,
  error: ApiClientError,
  init: RequestInit | undefined,
  retried: boolean,
): Promise<Response | null> {
  if (typeof window === "undefined" || isMfaAuthPath(path)) return null;

  const details = mfaErrorDetails(error);
  if (!details) return null;

  // Step-up: keep the merchant on the page, verify, retry once.
  if (
    details.gate.status === "challenge" &&
    (details.action != null || details.stepUpWindowMs != null) &&
    stepUpHandler &&
    !retried
  ) {
    const ok = await stepUpHandler(details);
    if (ok) return fetch(await absoluteUrl(path), init);
    return null;
  }

  // Session gate: they are signed in but cannot use the dashboard yet.
  // Do not sign them out — that is the failure mode MFA_REQUIRED exists to avoid.
  if (details.gate.status === "enroll") {
    const next = encodeURIComponent(
      `${window.location.pathname}${window.location.search}`,
    );
    window.location.assign(`/mfa/enroll?next=${next}`);
    return null;
  }

  if (details.gate.status === "challenge") {
    const next = encodeURIComponent(
      `${window.location.pathname}${window.location.search}`,
    );
    window.location.assign(`/mfa/challenge?next=${next}`);
    return null;
  }

  return null;
}

export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
  _retried = false,
): Promise<T> {
  const requestInit: RequestInit = {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body && !(init.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...init?.headers,
    },
  };

  const res = await fetch(await absoluteUrl(path), requestInit);

  if (!res.ok) {
    const error = await parseError(res);
    if (isMfaRequired(error)) {
      const retry = await handleMfaRequired(path, error, requestInit, _retried);
      if (retry) {
        if (!retry.ok) throw await parseError(retry);
        if (retry.status === 204) return undefined as T;
        return (await retry.json()) as T;
      }
    }
    throw error;
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return (await res.json()) as T;
}

export function apiGet<T>(
  path: string,
  params?: Record<string, QueryValue>,
  init?: RequestInit,
) {
  return apiFetch<T>(`${path}${buildQuery(params)}`, {
    ...init,
    method: "GET",
  });
}

export function apiPost<T>(path: string, body?: unknown, init?: RequestInit) {
  return apiFetch<T>(path, {
    ...init,
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function apiPatch<T>(path: string, body?: unknown, init?: RequestInit) {
  return apiFetch<T>(path, {
    ...init,
    method: "PATCH",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function apiPut<T>(path: string, body?: unknown, init?: RequestInit) {
  return apiFetch<T>(path, {
    ...init,
    method: "PUT",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function apiDelete<T>(path: string, init?: RequestInit) {
  return apiFetch<T>(path, { ...init, method: "DELETE" });
}
