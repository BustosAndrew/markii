---
name: run-markii
description: Launch the Markii dev server and drive a storefront or dashboard page in a real browser to see a change working. Use when asked to run or start the app, screenshot a page, or confirm a UI change renders correctly (not just that tests pass).
---

# Running Markii

Verified 2026-08-18 on Windows 11 (git bash). Every step below was run; the
traps are ones that actually cost time, not hypotheticals.

## Start the server

```bash
DEMO_SKIP_PAYMENT_VERIFICATION=1 ROOT_DOMAIN=localhost pnpm dev > /tmp/dev.log 2>&1 &
sleep 6 && curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/   # expect 200
```

**Both env vars are load-bearing and set on the *server*, not the test process.**
`ROOT_DOMAIN=localhost` is what makes storefront subdomains resolve; without it
`.env.local`'s real `markii.shop` wins and requests either fail to resolve or hit
**production**. `DEMO_SKIP_PAYMENT_VERIFICATION=1` stops checkout completion from
trying to settle on-chain.

Needs `DATABASE_URL` in `.env.local`. Without it the app boots and every
DB-backed route returns 500 — which is correct behaviour, not a bug to chase.

## Trap: storefront pages only work on the subdomain host

**`http://localhost:3000/_sites/{slug}/cart` looks right and is broken.** The
cart island calls root-relative `/api/cart/...`, which only resolves through
`proxy.ts` on a storefront host. Loaded via the internal path those calls 404 and
the page renders "Your cart is empty" with no visible error.

```
✅ http://{slug}.localhost:3000/cart      ← how a shopper reaches it
❌ http://localhost:3000/_sites/{slug}/cart
```

`*.localhost` resolves to 127.0.0.1 in Chromium/Edge with no hosts-file edit.

## Trap: the cart needs a token, and cookies must be set through the app

The cart is a bearer token in a `markii_cart` cookie. Playwright's `addCookies`
did **not** take (the page saw an empty `document.cookie`). Use the app's own
recovery path instead — it writes the cookie and loads the cart:

```
http://{slug}.localhost:3000/cart?recover=<token>
```

## Driving a browser

No browser driver is installed and **none should be added to `package.json`**.
Use `playwright-core` against the Edge already on the machine, installed in a
scratch directory:

```bash
cd "$SCRATCH" && npm init -y >/dev/null && npm install playwright-core postgres --silent
```

```js
import { chromium } from "playwright-core";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await (await browser.newContext()).newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", String(e)));
page.on("console", (m) => { if (m.type() === "error") console.log("console.error:", m.text()); });
await page.goto(`http://${slug}.localhost:3000/cart?recover=${encodeURIComponent(token)}`,
                { waitUntil: "networkidle" });
await page.waitForSelector(".sf-totals", { timeout: 20000 });
console.log(await page.locator(".sf-totals").innerText());
await page.locator(".sf-cart-island").screenshot({ path: "shot.png" });
```

**Read the screenshot, not just the text.** The CTA bug ("Complete shipping to
continue" when tax was the blocker) was only visible in the rendered image —
the totals text alone looked fine.

Scripts run from the scratch dir cannot resolve the project's `node_modules`;
install what you need locally there and point `--env-file-if-exists` at the
repo's `.env.local`.

## Seeding a storefront

Each integration test file builds and tears down its own fixtures — copy that
pattern rather than `pnpm db:seed`. Minimum for a purchasable cart: an
`organizations` row, a `sites` row (`status: 'live'`, `purchases_enabled: true`,
a `wallet_address`, `payment_providers: {"x402":true}`), a product, a
`locations` row, a variant with an `inventory_ledger` credit, and a
`shipping_zones` + `shipping_rates` pair.

**`carts.shipping_rate_id` is `text`.** PATCHing it as a JSON number silently
does nothing and shipping stays `not_configured`. Send `"3"`, not `3`.

Clean up by deleting the org — everything cascades:

```sql
delete from organizations where id = '<orgId>';
```

## Stop the server

```bash
PID=$(netstat -ano | grep LISTENING | grep ":3000" | head -1 | awk '{print $NF}')
[ -n "$PID" ] && taskkill //PID $PID //F
```

Kill by port, never a blanket `taskkill /IM node.exe` — that takes editor
language servers with it.

## When a browser is overkill

For anything that is really about response *shape*, hit the API directly and
skip the browser entirely:

```bash
curl -s "http://localhost:3000/_sites/{slug}/api/cart/{token}" | python -m json.tool
```

That is enough to confirm a field exists and is well-formed. It is **not** enough
to confirm a render — the two bugs this skill's traps came from were both
correct in JSON and wrong on screen.
