/**
 * What the assistant knows about Markii itself (§27) — a curated set of help
 * topics, not a model's recollection.
 *
 * **Every sentence here is a factual claim made to a merchant**, so each one
 * is taken from this repository's own decisions and code, never from memory.
 * The assistant is told to answer product questions from these topics and to
 * say so when a question is not covered, rather than fill the gap.
 *
 * Plan prices and fee rates are deliberately **absent**: they live in
 * `lib/plans.ts` alone and reach the assistant through its `get_plans` tool,
 * so a price change cannot leave a stale number in here. Competitor pricing is
 * absent for the same reason the docs give — it changes, and it is only
 * sayable when verified (`docs/COMPETITORS.md`).
 *
 * Pure, so a unit test can check every link names a real dashboard page.
 */

export type HelpTopic = {
  id: string;
  title: string;
  /** One line, listed in the assistant's instructions so it knows which topic to open. */
  summary: string;
  body: string;
  /** Dashboard pages the topic refers to. Each must exist (unit-tested). */
  links: { label: string; href: string }[];
};

export function helpTopics(context: { rootDomain: string }): HelpTopic[] {
  const storeAddress = `{your-store}.${context.rootDomain}`;

  return [
    {
      id: "getting_started",
      title: "Getting started",
      summary: "The order to set up a new store in, and what each step is for.",
      body: `A store can take its first order once it has products, a way to be paid, shipping (only if something ships), a tax decision, and is put live. The setup checklist tracks each of these from your store's real state — nothing is ticked off by hand.

1. Create a store — from scratch, or by importing an existing catalog (Shopify, WooCommerce, or a sitemap).
2. Add products.
3. Set up payments — card through your own Stripe account, and/or x402 (USDC).
4. Shipping zones and rates, if you sell anything that ships.
5. Decide on tax — none, your own rates, or Stripe Tax.
6. Put the store live.

Recommended after that: fill catalog gaps (the Catalog agent can propose fixes), send email from your own domain, and connect a custom domain. Every account starts with one free month; choose a plan before it ends to keep the storefront running.`,
      links: [
        { label: "Create a store", href: "/dashboard/websites/new" },
        { label: "Add a product", href: "/dashboard/products/new" },
        { label: "Payments", href: "/dashboard/payments" },
      ],
    },
    {
      id: "payments",
      title: "Payments",
      summary: "Card via your own Stripe account, x402/USDC, what Markii takes, and connecting a rail.",
      body: `Payment methods are peers — pick any combination per store.

- Card, through Stripe Connect. You connect your own Stripe account; charges are made on it, payouts go straight to you, and your rates and dashboard are Stripe's. Markii takes no cut of the charge and never holds your funds. Stripe's processing fee is Stripe's. Stripe may ask for verification documents before it enables charges — until it does, card payments are not offered at checkout.
- x402 (USDC). Payment goes to a wallet address you set, on the store or as your organization's default.
- PayPal is not available yet.

Markii charges no platform fee for using your own payment provider, on any plan.

Connecting or changing a payment method moves where money goes, so it needs the owner or an administrator (billing permission) and a fresh MFA code from the last 15 minutes.`,
      links: [{ label: "Payments", href: "/dashboard/payments" }],
    },
    {
      id: "pricing_and_fees",
      title: "Plans and Markii's fee",
      summary: "How plans and the sales-threshold fee work. Exact prices come from get_plans.",
      body: `Every account starts with one free month, with no card taken.

Plans differ by price, number of storefronts, media storage, and the sales threshold. Staff seats are unlimited on every plan, and the full commerce feature set, API and MCP access are on every plan. Use get_plans for exact prices and numbers — never quote them from memory.

Markii's own fee applies only to sales above your plan's threshold:
- Measured over trailing 12 months of net sales.
- Physical goods and digital goods (downloads and memberships) are counted separately, against separate thresholds, at different rates.
- Charged only on the slice above the threshold, not on everything.
- It appears as its own named line on your Markii subscription invoice, showing its arithmetic.

There is no platform fee for using your own payment provider. Processor fees (Stripe's) are separate and never marked up.`,
      links: [{ label: "Billing", href: "/dashboard/billing" }],
    },
    {
      id: "trial_and_billing",
      title: "The free month, billing, and failed payments",
      summary: "What happens when the free month ends, and what a failing card holds.",
      body: `When the free month ends without a plan, the storefront stops — shoppers are told it is unavailable, never why — and changes are on hold. Reading your data is never blocked, and billing stays open so you can choose a plan; everything returns the moment you subscribe. Reminder emails go out in the last three days.

If a renewal payment fails, nothing stops at once. Creating storefronts and API tokens is held from day 7, changes from day 14, and the storefront from day 30. Updating your card lets Stripe retry, and everything is reinstated as soon as it is paid.

A store that is halted also stops membership renewals (paused, never cancelled) and digital downloads.`,
      links: [{ label: "Billing", href: "/dashboard/billing" }],
    },
    {
      id: "shipping",
      title: "Shipping",
      summary: "Zones, rates, and why an empty zone refuses checkout.",
      body: `Shipping is a set of zones, each with one or more rates the shopper chooses from.

- A zone lists countries, optionally narrowed to provinces or states. A zone with no countries is the catch-all for everywhere else. The most specific matching zone wins.
- A zone with no rates refuses checkout to its destinations — it looks configured but quotes nothing.
- If you sell goods that ship and have no zones, checkout is refused rather than quoting zero postage, which would leave you paying for it.
- Digital products never need shipping.

Markii does not buy labels or handle fulfillment logistics; you mark orders fulfilled yourself.`,
      links: [{ label: "Shipping settings", href: "/dashboard/settings/shipping" }],
    },
    {
      id: "tax",
      title: "Tax",
      summary: "None, manual rates, or Stripe Tax — and the zero-registrations trap.",
      body: `You are the seller of record, so what tax you owe depends on where you are registered. Markii cannot give tax advice — an accountant can.

Three options per store:
- None. No tax is charged.
- Manual rates. One rate per country or province; the most specific match wins. Manual rates cannot exempt individual products.
- Stripe Tax. Calculated on your own connected Stripe account, which Stripe bills per calculation. It only collects where you have added registrations in Stripe — with none, it calculates zero everywhere and the store looks configured while collecting nothing.

Prices can be entered tax-inclusive or tax-exclusive. Recurring memberships can only be sold on a store using Stripe Tax.`,
      links: [{ label: "Tax settings", href: "/dashboard/settings/tax" }],
    },
    {
      id: "domains",
      title: "Your store's address and custom domains",
      summary: "The built-in address, connecting your own domain, and DNS verification.",
      body: `Every live store has its own address at ${storeAddress}.

To use your own domain:
1. Add it in domain settings.
2. Publish the TXT record shown, at _markii-verify.{your-domain}. This proves you own it.
3. Point the domain at Markii with the CNAME or A record shown.

Verification is what makes Markii serve the domain; pointing is reported separately and can take time to propagate. Once verified, a later DNS hiccup does not take the store offline.`,
      links: [{ label: "Domains", href: "/dashboard/settings/domains" }],
    },
    {
      id: "email",
      title: "Customer email",
      summary: "Order emails, sending from your own domain, sending limits, abandoned carts.",
      body: `Order confirmations, shipping and refund notices, and digital deliveries are sent automatically.

Until you verify a domain of your own, they go from your store's own address (accounts@${storeAddress}), under your store's name. Verifying your domain — publishing the DNS records shown in email settings — makes them come from you.

New accounts have a daily sending limit while they build a track record: 100 a day during the free month, 1,000 a day for a paying account's first 30 days.

Abandoned-cart reminders are off by default and switched on per store — one reminder per cart. Marketing campaigns and newsletters are not offered; use a dedicated email marketing service for those.`,
      links: [{ label: "Email settings", href: "/dashboard/settings/email" }],
    },
    {
      id: "products_and_catalog",
      title: "Products, variants, collections and importing",
      summary: "Adding products, variants and stock, collections, categories, and imports.",
      body: `Products can have options and variants (size, colour), each with its own price, SKU and stock. Stock is tracked per location as a ledger, so every change has a reason and can be reversed.

Categories organise a store's catalog; collections are curated (manual) or rule-based groups that appear on the storefront once published.

You can import a catalog from a CSV file, a Shopify or WooCommerce store, or a site's product pages — when creating a store or from the Catalog page. What an import brings across:
- Shopify products keep all their variants (sizes, colours) with their own prices and SKUs. Option combinations the original store never sold are created too, with no stock.
- WooCommerce products with variations come in as the base product only; add the options afterwards.
- Stock counts usually are not published by the source store, so those products come in at 0 and cannot be bought until you set the real quantity. The import tells you which ones.
- Prices keep the source store's currency. Prices in currencies without two decimal places (such as yen) cannot be imported yet.
- Up to 1,000 products per store import; for more, use a CSV export.

The Catalog agent can review your catalog and propose fixes — descriptions, prices, collections, stock — for you to approve one by one.`,
      links: [
        { label: "Catalog", href: "/dashboard/catalog" },
        { label: "Add a product", href: "/dashboard/products/new" },
        { label: "Collections", href: "/dashboard/collections/new" },
      ],
    },
    {
      id: "digital_products",
      title: "Digital products",
      summary: "Selling downloads and licence keys.",
      body: `Attach files or licence keys to a product and it becomes digital: buyers get a download link by email after paying, and nothing ships.

Files are stored privately and each download link is signed, limited, and throttled, so download limits mean something. You can reissue or revoke a buyer's access from the order. A refund revokes access too.`,
      links: [{ label: "Digital delivery", href: "/dashboard/delivery" }],
    },
    {
      id: "memberships",
      title: "Memberships",
      summary: "Gating products behind tiers, and recurring memberships.",
      body: `Membership tiers gate products. Buying a product that grants a tier gives the shopper that membership; a refund revokes it.

A membership product can renew monthly or yearly. Renewals are a subscription on your own Stripe account, so the shopper pays you directly; shoppers must sign in to buy one, and can cancel their own renewal (access runs to the end of what they paid for). Recurring memberships require Stripe Tax on the store.`,
      links: [{ label: "Memberships", href: "/dashboard/memberships" }],
    },
    {
      id: "orders_and_refunds",
      title: "Orders, fulfillment and refunds",
      summary: "Fulfilling, cancelling and refunding orders, per payment method.",
      body: `Orders are where you fulfil, cancel, add notes, resend the confirmation, and refund.

Card refunds are made by Stripe, out of your own Stripe balance. x402 (USDC) payments cannot be refunded through Markii — a refund has to be sent from your wallet yourself.

Refunds and other actions that move money ask for a fresh MFA code.`,
      links: [{ label: "Orders", href: "/dashboard/orders" }],
    },
    {
      id: "agent_discovery",
      title: "How AI shopping agents see your store",
      summary: "llms.txt, agent.md, structured data, search, and the readiness score.",
      body: `Every storefront is built to be read by AI shopping agents as well as people: plain HTML with structured product data (JSON-LD), a sitemap, a search endpoint, and two documents written for agents — llms.txt and agent.md. Agent discovery can be switched off per store.

The readiness score on the Health page checks your store and catalog against fixed rules — missing descriptions, images, prices, shipping and payment setup — and tells you what each finding affects. It describes rules a store passes or fails; it does not predict search ranking, recommendations or sales.`,
      links: [{ label: "Health", href: "/dashboard/health" }],
    },
    {
      id: "merchant_agents",
      title: "Markii's agents, MCP and the API",
      summary: "Which agent does what, the beta allowance, and connecting your own AI tools.",
      body: `Markii's agents are in beta and free, within a monthly allowance shared by your organization (it resets on the 1st, UTC), and a limit on messages per person per hour.

- The assistant (this chat) answers questions, checks your setup, and points you to the right page or agent. It changes nothing.
- The Catalog agent, opened from the Catalog page, reviews products and proposes edits. Nothing changes until you approve each proposal, every approved change is in the audit log, and it can be undone.

Agents only ever propose. You approve, and you can do only what your role allows.

To drive your store from your own AI tools — Claude Code, Cursor — connect over MCP with an API token from team settings. Tokens are scoped, revocable, and go through the same permissions and audit log as the dashboard.`,
      links: [
        { label: "Catalog", href: "/dashboard/catalog" },
        { label: "Team and API tokens", href: "/dashboard/settings/team" },
      ],
    },
    {
      id: "team_and_security",
      title: "Team, roles and security",
      summary: "Staff roles, MFA, step-up, the audit log, sessions and undo.",
      body: `Staff seats are unlimited. Roles: owner, administrator, catalog manager, commerce manager, analyst, developer, and viewer. Staff can be limited to particular stores.

Every staff account uses two-factor authentication (an authenticator app) with recovery codes. Anything that moves money or grants access — payment methods, refunds — also asks for a fresh code from the last 15 minutes.

Owners and administrators can see the audit log: every change, who made it, from where, and refused attempts. Many changes can be undone from there. Account settings show the devices you are signed in on, and any of them can be signed out.`,
      links: [
        { label: "Team", href: "/dashboard/settings/team" },
        { label: "Audit log", href: "/dashboard/settings/audit" },
        { label: "Account", href: "/dashboard/settings/account" },
      ],
    },
    {
      id: "not_offered",
      title: "What Markii does not do",
      summary: "Features that are not available, so the answer is a clear no.",
      body: `Not available:
- Shipping labels and fulfillment logistics.
- Gift cards.
- Email marketing campaigns and newsletters.
- PayPal.
- The drag-and-drop site builder is not available yet; stores use one of the built-in themes.

When something is not available, say so plainly rather than suggesting a workaround that does not exist.`,
      links: [],
    },
  ];
}
