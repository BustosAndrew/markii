import { ApiClientError } from "@/lib/api/types";

export async function loadOrError<T>(
  fn: () => Promise<T>,
): Promise<{ data: T; error: null } | { data: null; error: string }> {
  try {
    const data = await fn();
    return { data, error: null };
  } catch (err) {
    if (err instanceof ApiClientError) {
      return { data: null, error: err.message };
    }
    if (err instanceof Error) {
      return { data: null, error: err.message };
    }
    return { data: null, error: "Request failed." };
  }
}

export function parsePage(value: string | string[] | undefined, fallback = 1) {
  const raw = Array.isArray(value) ? value[0] : value;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

export function parseLimit(value: string | string[] | undefined, fallback = 20) {
  const raw = Array.isArray(value) ? value[0] : value;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(1, Math.floor(n)));
}

export function firstParam(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0];
  return value;
}
