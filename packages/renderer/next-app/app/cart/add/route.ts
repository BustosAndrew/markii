import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { asShopper, storeUrl } from "../../../lib/markii";

/**
 * `POST /cart/add` — the buy form's target. Builds the cart on Markii from
 * this server (as the signed-in shopper, when there is one, so members-only
 * products are allowed and the cart is theirs at checkout), keeps the cart's
 * token in a cookie on **this** site so later adds land in the same cart,
 * then sends the shopper to the store's hosted checkout on Markii to pay.
 *
 * Payment never touches this app: card details go to the merchant's own
 * Stripe account through Markii's checkout, as on the store itself.
 */
const CART_COOKIE = "markii_cart";

export async function POST(req: Request) {
  const form = await req.formData();
  const productId = Number(form.get("productId"));
  const variantRaw = form.get("variantId");
  const variantId = variantRaw ? Number(variantRaw) : undefined;
  const quantity = Math.min(Math.max(Number(form.get("quantity") ?? 1) || 1, 1), 99);
  const slug = String(form.get("slug") ?? "");
  const line = { productId, variantId, quantity };
  if (!Number.isInteger(productId) || productId <= 0) return NextResponse.json({ error: "productId is required" }, { status: 400 });

  const jar = await cookies();
  let token = jar.get(CART_COOKIE)?.value ?? null;
  let res: Response | null = null;
  if (token) {
    // A cart already checked out, expired or unknown answers non-200 here: start a fresh one.
    // Asked first so a real refusal of the line (members only, another currency) is shown, not hidden by a new cart.
    const current = await asShopper(`/api/cart/${encodeURIComponent(token)}`);
    if (current.ok) res = await asShopper(`/api/cart/${encodeURIComponent(token)}`, { method: "PATCH", body: { add: line } });
  }
  if (!res) {
    res = await asShopper("/api/cart", { method: "POST", body: line });
  }

  const body = (await res.json().catch(() => null)) as { token?: string; error?: { message?: string } } | null;
  if (!res.ok || !body?.token) {
    const message = body?.error?.message ?? "That could not be added to the cart.";
    return NextResponse.redirect(new URL(`/p/${encodeURIComponent(slug)}?cart_error=${encodeURIComponent(message)}`, req.url), 303);
  }

  token = body.token;
  jar.set(CART_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 60 * 60 * 24 * 30 });
  return NextResponse.redirect(`${storeUrl()}/cart?recover=${encodeURIComponent(token)}`, 303);
}
