import type { Metadata } from "next";
import {
  Bot,
  Boxes,
  CreditCard,
  Gauge,
  Layers,
  ShieldCheck,
  ShoppingCart,
  Users,
  Wallet,
} from "lucide-react";
import { ButtonLink } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Overview — Markii",
  description:
    "Markii is a commerce platform with agent-readable storefronts and threshold-based pricing.",
};

const sections = [
  {
    icon: ShoppingCart,
    title: "Sell to humans",
    body: "Cart, checkout sessions, customers, discounts, tax, and shipping rates — the commerce core merchants expect from Shopify-class software.",
  },
  {
    icon: Bot,
    title: "Sell to agents",
    body: "Storefronts ship semantic HTML, JSON-LD, llms.txt, and agent.md. Agents can crawl, recommend, and purchase (including x402) without a custom integration.",
  },
  {
    icon: Boxes,
    title: "Catalog that scales",
    body: "Products, variants, collections, inventory levels, locations, and importers for CSV, Shopify, and WooCommerce.",
  },
  {
    icon: Layers,
    title: "Themes, not soup",
    body: "Launch with Studio, Atlas, Noir, and Bloom on the SSR renderer. A full block builder is planned — without breaking agent legibility.",
  },
  {
    icon: Users,
    title: "Organizations & staff",
    body: "Auth, orgs, invites, and roles so agencies and teams share stores under the same permission model agents will use.",
  },
  {
    icon: Wallet,
    title: "Honest money",
    body: "Bring your own processor with 0% Markii platform fee. We never hold merchant funds and never mark up Stripe’s cut.",
  },
  {
    icon: Gauge,
    title: "Threshold metering",
    body: "No Markii transaction fee until trailing annual sales cross your plan threshold — then only the slice above it, with a live meter and no forced upgrade.",
  },
  {
    icon: ShieldCheck,
    title: "Readiness & ops",
    body: "Rule-based Agent Readiness Score at launch. Channels, Test Lab, Chargeback Assist, and Agent Ops chat follow as the AI layer and add-ons.",
  },
  {
    icon: CreditCard,
    title: "Payment rails as peers",
    body: "Card, Stripe, PayPal, and x402/USDC sit side by side. x402 is the agent-native rail — not the product identity.",
  },
];

export default function OverviewPage() {
  return (
    <div className="mx-auto w-full max-w-5xl px-6 pt-14 pb-20">
      <p className="text-sm font-medium text-brand">Overview</p>
      <h1 className="mt-2 max-w-2xl text-4xl font-semibold tracking-[-0.04em] text-balance text-foreground sm:text-5xl">
        A commerce platform agents can shop
      </h1>
      <p className="mt-4 max-w-2xl text-lg leading-8 text-muted">
        Markii sits in the Shopify / Squarespace category — catalog, checkout,
        teams, and billing — with storefronts that are natively legible to AI
        shopping agents, and pricing that does not tax growth until you are
        genuinely big.
      </p>

      <div className="mt-14 grid gap-10 sm:grid-cols-2 lg:grid-cols-3">
        {sections.map((item) => (
          <article key={item.title}>
            <item.icon className="size-5 text-brand" strokeWidth={1.75} />
            <h2 className="mt-3 text-base font-semibold tracking-tight text-foreground">
              {item.title}
            </h2>
            <p className="mt-1.5 text-sm leading-6 text-muted">{item.body}</p>
          </article>
        ))}
      </div>

      <div className="mt-16 rounded-[var(--radius-card)] border border-border bg-surface px-6 py-8">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">
          What we deliberately do not build
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
          No fulfillment logistics, no POS / in-person retail, no custodial
          funds, and no chargeback guarantees. Dispute visibility is included;
          assisted response is an add-on. Native email campaigns stay out of
          launch — integrate Klaviyo or peers as channels instead.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <ButtonLink href="/pricing">View pricing</ButtonLink>
          <ButtonLink href="/contact" variant="secondary">
            Contact
          </ButtonLink>
        </div>
      </div>
    </div>
  );
}
