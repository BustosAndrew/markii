import { NextResponse } from "next/server";
import { accountUrl } from "../../lib/shopper";

/** `GET /account` — the header's Account link. Shopper accounts are yours (`lib/shopper.ts`): this goes to your sign-in. */
export async function GET(req: Request) {
  return NextResponse.redirect(new URL(accountUrl(), req.url), 303);
}
