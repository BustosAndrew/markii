import { NextResponse } from "next/server";
import { handler, notFound } from "@/lib/api";
import { requestContextFrom } from "@/lib/auth/request-context";
import { storefrontKeyFrom } from "@/lib/auth/storefront-key-format";
import { storefrontDelegation } from "@/lib/auth/storefront-keys";
import { CLIENT_ADDRESS_HEADER, clientAddressFrom } from "@/lib/forms/rules";
import { formByHandle, submitForm } from "@/lib/forms/submit";
import { rateLimitHeaders } from "@/lib/rate-limit";
import { loadSite, storefrontHalted } from "@/lib/storefront";
import { formJson, READ_API_HEADERS } from "@/lib/storefront/read-api";
import { loadReadableSite } from "@/lib/storefront/read-api-server";

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
 *
 * **Whose address is limited.** Normally the request's own. An exported
 * storefront's server forwards its shoppers' posts, so every one would arrive
 * from that server and share one shopper's budget; with the store's secret key
 * it may name the shopper's address in `Markii-Client-Address`, and that is
 * counted instead. Without a valid key the header is ignored — anyone could
 * otherwise reset their own limit by sending a new address each time.
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

/**
 * `GET /api/forms/{handle}` — the form as a shopper sees it, for an exported
 * storefront to draw (`docs/API.md` §23). Public like the rest of the read
 * API: fields, labels and the thank-you message, never where submissions are
 * emailed.
 */
export const GET = handler(async (_req, { params }) => {
  const { site: slug, handle } = (await params) as { site: string; handle: string };
  const data = await loadReadableSite(slug);
  const form = await formByHandle(data.site.id, handle);
  if (!form) throw notFound("Form");
  return NextResponse.json(formJson(data, form), { headers: READ_API_HEADERS });
});

export const POST = handler(async (req, { params }) => {
  const { site: slug, handle } = (await params) as { site: string; handle: string };
  const data = await loadSite(slug);
  if (!data || storefrontHalted(data)) return json(404, { error: { code: "NOT_FOUND", message: "Store not found" } });
  const form = await formByHandle(data.site.id, handle);
  if (!form) return json(404, { error: { code: "NOT_FOUND", message: "Form not found" } });

  // A key that is wrong, or sent from a browser, is refused here rather than ignored.
  const delegated = storefrontKeyFrom(req.headers) ? (await storefrontDelegation(data.site.id)).kind === "server" : false;
  const forwarded = delegated ? clientAddressFrom(req.headers.get(CLIENT_ADDRESS_HEADER)) : null;

  const body = await readBody(req);
  if (!body) return json(413, { error: { code: "VALIDATION_ERROR", message: "That message is too long to send." } });

  const outcome = await submitForm({ site: data.site, form, input: body.input, ip: forwarded ?? requestContextFrom(req).ip });
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
});
