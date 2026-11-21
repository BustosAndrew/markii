import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { storeUrl } from "../../lib/markii";

/** `GET /cart` — the header's Cart link: the store's hosted cart, with this shopper's cart when there is one. */
export async function GET() {
  const token = (await cookies()).get("markii_cart")?.value;
  return NextResponse.redirect(`${storeUrl()}/cart${token ? `?recover=${encodeURIComponent(token)}` : ""}`, 303);
}
