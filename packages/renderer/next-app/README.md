# Your store, as a Next.js app

This is your Markii storefront as a Next.js app you own and can deploy anywhere. It draws every
page with **the same renderer Markii uses** (`renderer/`), so your published design — pages,
product and collection templates, header, footer, theme, custom CSS — looks the same here as it
does on Markii. Catalogue, stock and design are read live from your store on Markii.

## What is yours, and what stays on Markii

| Yours (this app) | Markii (your store) |
|---|---|
| Hosting, domain, and deploys | Catalogue, stock, collections, design — edit them in the Markii dashboard |
| **Shopper sign-in and its database** — `lib/shopper.ts` | Cart and **checkout** — shoppers pay on your store's hosted checkout, to your own Stripe account |
| Anything you add or change here | Orders, refunds, tax, email receipts, digital delivery, memberships |

**Payments never touch this app.** "Add to cart" builds the cart on Markii from this server and
sends the shopper to your store's hosted checkout.

## Set up

```bash
npm install
cp .env.example .env.local   # then fill it in
npm run dev
```

| Variable | |
|---|---|
| `MARKII_STORE_URL` | Your store on Markii, e.g. `https://leaf.markii.shop`. Required. |
| `SITE_URL` | Where this app is served, e.g. `https://shop.example.com`. Links, structured data and the agent documents use it. |
| `MARKII_STOREFRONT_KEY` | For **members-only products**, and so **forms** post through this app (see Forms). Create one in the Markii dashboard (your store's settings → exported storefront). **Server-only: never expose it to the browser** — Markii refuses a key sent from one. |
| `ACCOUNT_URL` | Where the header's "Account" link goes — your sign-in page. |

## Shopper accounts and memberships

This app ships with **no sign-in**. Guests can buy anything that is not members-only.

To sell members-only products, plug your own sign-in into `lib/shopper.ts`: return the signed-in
shopper's email **once your sign-in has verified it**, and set `MARKII_STOREFRONT_KEY`. This server
then tells Markii which of your customers is shopping, and their memberships unlock what they are
entitled to — including at checkout. **Markii trusts that address**: whoever holds your key can act as
any customer of your store, so keep the key secret and only ever return verified addresses.

## Forms

Forms you build on Markii (contact, wholesale enquiries…) work here too, on any page and at
`/forms/{handle}`. Markii keeps every submission, emails it if the form says to, and applies its spam
limits and your blocklist — see them in the Markii dashboard.

- **With `MARKII_STOREFRONT_KEY` set**, a form posts to this app's `/api/forms/{handle}`, which sends
  it on to Markii from this server along with the shopper's address, and the shopper stays on this
  site. The address is read from `x-forwarded-for`, which your host must set and overwrite (Vercel and
  most platforms do).
- **Without a key**, forms post straight to your store on Markii, and the shopper sees the thank-you
  page there. Markii only accepts the shopper's address from a server that holds your key, so without
  one this app cannot forward posts for its shoppers.

## Blog

Posts you publish on Markii appear at `/blog` and `/blog/{handle}`, drawn as Markii draws them, with the
same `BlogPosting` structured data. `/blog/feed.xml` is your store's RSS feed with its links pointed at
this site. A scheduled post appears when its time comes; drafts are never served. A "Latest posts" block
in your design works here too.

**Members-only posts and pages** work here when `MARKII_STOREFRONT_KEY` is set and `lib/shopper.ts`
returns the signed-in shopper: this server asks Markii for the content as that shopper, and Markii sends it
only to a member. Everyone else — and every visitor when there is no key — sees the title and a
"Members only" notice linking to the products that grant the membership. The content is never cached
here for the next visitor.

## For AI agents

`/llms.txt`, `/llms-full.txt`, `/agent.md` and `/sitemap.xml` are your store's own documents, served
from here with your pages pointed at this site. Product and collection pages carry the same
Schema.org structured data as on Markii. Agents that buy are pointed at your store's APIs on Markii.

## Updating

Design and catalogue changes you publish on Markii show up here within a minute — no redeploy. Export
again to pick up renderer updates.

## Licence

The renderer in `renderer/` and this app's code are licensed under the Apache License 2.0 — see
`LICENSE` and `NOTICE`. The Apache licence does not grant use of the Markii name or logo. Images in
your design belong to their owners.
