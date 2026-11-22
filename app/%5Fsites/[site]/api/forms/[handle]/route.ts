import { NextResponse } from "next/server";
import { requestContextFrom } from "@/lib/auth/request-context";
import { formByHandle, submitForm } from "@/lib/forms/submit";
import { rateLimitHeaders } from "@/lib/rate-limit";
import { loadSite, storefrontHalted } from "@/lib/storefront";

/**
 * `POST /api/forms/{handle}` on a storefront host — a shopper sending a form.
 *
 * Two callers, one rule set (`lib/forms/submit.ts`):
 * - **A plain HTML form** (`application/x-www-form-urlencoded`, what the
 *   storefront's own `<form>` posts) gets a `303` to `/forms/{handle}` with a
 *   `status` the page explains. No script anywhere on the path.
 * - **JSON** (an exported storefront's server, or any client) gets JSON:
 *   `201 { ok: true }`, `400 VALIDATION_ERROR` with `details.fields`,
 *   `403 SUBMISSION_REFUSED`, `429 RATE_LIMITED` with `Retry-After`.
 *
 * A refused sender is told only that the message could not be sent — never
 * that a blocklist exists, which would tell them to change address.
 */

const BODY_MAX = 64 * 1024;

function safeReturn(raw: unknown): string | null {
  return typeof raw === "string" && /^\/(?!\/)[^\s]{0,300}$/.test(raw) ? raw : null;
}

async function readBody(req: Request): Promise<{ json: boolean; input: Record<string, unknown> } | null> {
  const type = req.headers.get("content-type") ?? "";
  const text = await req.text();
  if (text.length > BODY_MAX) return null;
  if (type.includes("application/json")) {
    try {
      const parsed = JSON.parse(text || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { json: true, input: parsed } : { json: true, input: {} };
    } catch {
      return { json: true, input: {} };
    }
  }
  return { json: false, input: Object.fromEntries(new URLSearchParams(text)) };
}

function json(status: number, body: unknown, headers?: HeadersInit) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

export async function POST(req: Request, { params }: { params: Promise<{ site: string; handle: string }> }) {
  const { site: slug, handle } = await params;
  const data = await loadSite(slug);
  if (!data || storefrontHalted(data)) return json(404, { error: { code: "NOT_FOUND", message: "Store not found" } });
  const form = await formByHandle(data.site.id, handle);
  if (!form) return json(404, { error: { code: "NOT_FOUND", message: "Form not found" } });

  const body = await readBody(req);
  if (!body) return json(413, { error: { code: "VALIDATION_ERROR", message: "That message is too long to send." } });

  const outcome = await submitForm({ site: data.site, form, input: body.input, ip: requestContextFrom(req).ip });
  const base = data.baseUrl.replace(/\/$/, "");
  const back = safeReturn(body.input._return);
  const page = (status: string, extra: Record<string, string> = {}) => {
    const q = new URLSearchParams({ status, ...extra, ...(back ? { from: back } : {}) });
    return NextResponse.redirect(`${base}/forms/${form.handle}?${q}`, 303);
  };

  if (outcome.ok) return body.json ? json(201, { ok: true }) : page("sent");
  switch (outcome.reason) {
    case "rate_limited": {
      const headers = rateLimitHeaders(outcome.decision, outcome.policy);
      if (!body.json) {
        const res = page("limited");
        for (const [k, v] of Object.entries(headers)) res.headers.set(k, String(v));
        return res;
      }
      return json(429, { error: { code: "RATE_LIMITED", message: "Too many messages. Try again later.", details: { retryAfterSeconds: outcome.decision.retryAfterSeconds } } }, headers);
    }
    case "invalid":
      return body.json
        ? json(400, { error: { code: "VALIDATION_ERROR", message: outcome.errors[0].message, details: { fields: outcome.errors } } })
        : page("invalid", { field: outcome.errors[0].field });
    case "refused":
      return body.json ? json(403, { error: { code: "SUBMISSION_REFUSED", message: "This message could not be sent." } }) : page("refused");
  }
}
