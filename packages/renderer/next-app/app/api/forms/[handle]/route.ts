import { NextResponse } from "next/server";
import { storeUrl } from "../../../../lib/markii";

/**
 * `POST /api/forms/{handle}` — where a form on this site posts when
 * `MARKII_STOREFRONT_KEY` is set (`lib/page.tsx` `formAction`). It sends the
 * answers on to your store on Markii from this server, then brings the shopper
 * back to this site's `/forms/{handle}` with the outcome.
 *
 * Markii keeps the submission, emails it if the form says to, and applies its
 * spam limits and your blocklist — none of that lives here. **The shopper's
 * address goes with it** (`Markii-Client-Address`), which Markii honours only
 * because your key comes with it; otherwise every shopper would count as this
 * server and share one shopper's limit. It is read from `x-forwarded-for`,
 * which your host must set and overwrite — Vercel and most platforms do. If
 * yours passes a client's own header through, set it from your proxy instead.
 *
 * No script on the page and none here: a plain HTML form, a redirect after.
 */

const BODY_MAX = 64 * 1024;

function back(handle: string, req: Request, status: string, extra: Record<string, string> = {}, from?: string | null) {
  const q = new URLSearchParams({ status, ...extra, ...(from ? { from } : {}) });
  return NextResponse.redirect(new URL(`/forms/${encodeURIComponent(handle)}?${q}`, req.url), 303);
}

function safeFrom(raw: unknown): string | null {
  return typeof raw === "string" && /^\/(?!\/)[^\s]{0,300}$/.test(raw) ? raw : null;
}

function clientAddress(req: Request): string | null {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip")?.trim() || null;
}

export async function POST(req: Request, { params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const key = process.env.MARKII_STOREFRONT_KEY;
  // Without a key, forms post to Markii directly; a post arriving here anyway has nowhere honest to go.
  if (!key) return NextResponse.json({ error: "Forms on this site post to the store directly." }, { status: 404 });

  const text = await req.text();
  if (text.length > BODY_MAX) return back(handle, req, "invalid");
  const input = Object.fromEntries(new URLSearchParams(text));
  const from = safeFrom(input._return);

  const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${key}` };
  const address = clientAddress(req);
  if (address) headers["markii-client-address"] = address;

  let res: Response;
  try {
    res = await fetch(`${storeUrl()}/api/forms/${encodeURIComponent(handle)}`, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
      cache: "no-store",
    });
  } catch (e) {
    console.error("Markii form post failed", e);
    return back(handle, req, "error", {}, from);
  }

  const body = (await res.json().catch(() => null)) as {
    error?: { code?: string; details?: { fields?: { field: string }[] } };
  } | null;
  if (res.status === 201) return back(handle, req, "sent", {}, from);
  if (res.status === 400) {
    const field = body?.error?.details?.fields?.[0]?.field;
    return back(handle, req, "invalid", field ? { field } : {}, from);
  }
  if (res.status === 429) return back(handle, req, "limited", {}, from);
  if (res.status === 403 && body?.error?.code === "SUBMISSION_REFUSED") return back(handle, req, "refused", {}, from);
  if (res.status === 404) return NextResponse.json({ error: "Form not found" }, { status: 404 });
  // A refused key (401/403) or Markii unavailable: the shopper is told it did not send; you are told why.
  console.error(`Markii answered ${res.status} for form "${handle}"`, body?.error?.code ?? "");
  return back(handle, req, "error", {}, from);
}
