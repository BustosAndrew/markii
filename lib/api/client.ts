import { ApiClientError, type ApiErrorBody } from "./types";

export type QueryValue = string | number | boolean | null | undefined;

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
  let details: unknown[] | undefined;
  try {
    const body = (await res.json()) as ApiErrorBody;
    if (body?.error) {
      code = body.error.code || code;
      message = body.error.message || message;
      details = body.error.details;
    }
  } catch {
    // non-JSON error body
  }
  return new ApiClientError(res.status, code, message, details);
}

export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(await absoluteUrl(path), {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body && !(init.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...init?.headers,
    },
  });

  if (!res.ok) {
    throw await parseError(res);
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
