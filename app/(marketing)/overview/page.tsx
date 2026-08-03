import type { Metadata } from "next";
import {
  Bot,
  Boxes,
  CreditCard,
  Gauge,
  Layers,
  ShoppingCart,
  Users,
} from "lucide-react";
import { Logo } from "@/components/logo";
import { ButtonLink } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Overview — Markii",
  description:
    "Markii is a commerce platform with agent-readable storefronts and fair pricing.",
};

const pillars = [
  {
    icon: ShoppingCart,
    title: "Sell to people",
    body: "Cart, checkout, customers, discounts, tax, and shipping rates.",
  },
  {
    icon: Bot,
    title: "Sell to agents",
    body: "Clean HTML, JSON-LD, llms.txt, and agent.md so AI can find and buy from you.",
  },
  {
    icon: CreditCard,
    title: "Keep your processor",
    body: "0% Markii fee on Stripe, PayPal, card, or x402. We never hold your money.",
  },
  {
    icon: Gauge,
    title: "Fees after you grow",
    body: "No Markii cut until you pass your plan threshold, and only on sales above it.",
  },
];

const themes = [
  { id: "studio", name: "Studio", note: "Editorial", bg: "#FAFAF8", fg: "#1A1A18" },
  { id: "atlas", name: "Atlas", note: "Dense catalog", bg: "#F4F5F7", fg: "#111827" },
  { id: "noir", name: "Noir", note: "Dark portfolio", bg: "#0C0C0E", fg: "#F4F4F5" },
  { id: "bloom", name: "Bloom", note: "Warm shop", bg: "#FFF8F3", fg: "#2C1810" },
] as const;

const stack = [
  {
    icon: Boxes,
    title: "Catalog",
    body: "Products, variants, collections, inventory, and CSV / Shopify / Woo import.",
  },
  {
    icon: Users,
    title: "Team",
    body: "Orgs, invites, and roles so staff and agents share the same permissions.",
  },
  {
    icon: Layers,
    title: "Storefronts",
    body: "Four launch themes that stay crawlable. A full builder comes later.",
  },
];

export default function OverviewPage() {
  return (
    <div className="mx-auto w-full max-w-5xl px-6 pt-14 pb-20">
      <section className="grid gap-10 lg:grid-cols-[1.2fr_1fr] lg:items-end">
        <div>
          <p className="text-sm font-medium text-brand">Overview</p>
          <h1 className="mt-2 text-4xl font-semibold tracking-[-0.04em] text-balance text-foreground sm:text-5xl">
            Your store, ready for shoppers and AI
          </h1>
          <p className="mt-4 max-w-xl text-lg leading-8 text-muted">
            Markii is a full commerce platform. Catalog, checkout, and teams on
            one side. Storefronts AI agents can actually read on the other. And
            pricing that waits until you are doing real volume.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <ButtonLink href="/sign-up">Start selling</ButtonLink>
            <ButtonLink href="/pricing" variant="secondary">
              See pricing
            </ButtonLink>
          </div>
        </div>

        <div className="overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface shadow-[var(--shadow-md)]">
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <Logo size={22} />
            <span className="text-sm font-medium text-foreground">aurora.markii.shop</span>
            <span className="ml-auto flex items-center gap-1.5 font-mono text-[11px] text-muted">
              <span className="size-1.5 rounded-full bg-success-text" />
              live
            </span>
          </div>
          <div className="grid grid-cols-2 divide-x divide-border">
            <div className="p-5">
              <p className="font-mono text-[10px] tracking-wide text-muted-soft uppercase">
                Shopper
              </p>
              <p className="mt-3 text-sm font-semibold text-foreground">
                Aurora Sneakers
              </p>
              <p className="mt-1 text-lg tabular-nums text-foreground">$145</p>
              <span className="mt-4 inline-block rounded-[var(--radius-control)] bg-brand px-3 py-1.5 text-xs font-medium text-on-brand">
                Add to cart
              </span>
            </div>
            <div className="bg-surface-elevated p-5">
              <p className="font-mono text-[10px] tracking-wide text-muted-soft uppercase">
                Agent
              </p>
              <pre className="mt-3 overflow-x-auto font-mono text-[10px] leading-4 text-muted">
                {`{
  "@type": "Product",
  "price": "145.00"
}`}
              </pre>
            </div>
          </div>
        </div>
      </section>

      <section className="mt-20 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
        {pillars.map((item) => (
          <article key={item.title}>
            <item.icon className="size-5 text-brand" strokeWidth={1.75} />
            <h2 className="mt-3 text-base font-semibold tracking-tight text-foreground">
              {item.title}
            </h2>
            <p className="mt-1.5 text-sm leading-6 text-muted">{item.body}</p>
          </article>
        ))}
      </section>

      <section className="mt-20">
        <h2 className="text-2xl font-semibold tracking-[-0.03em] text-foreground">
          Themes that stay readable
        </h2>
        <p className="mt-2 max-w-lg text-sm leading-6 text-muted">
          Pick a look for launch. Every theme still ships clean markup agents
          can parse.
        </p>
        <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {themes.map((theme) => (
            <div
              key={theme.id}
              className="overflow-hidden rounded-[var(--radius-card)] border border-border"
              style={{ background: theme.bg, color: theme.fg }}
            >
              <div className="border-b px-4 py-3" style={{ borderColor: `${theme.fg}22` }}>
                <p className="text-sm font-semibold">{theme.name}</p>
                <p className="text-xs opacity-70">{theme.note}</p>
              </div>
              <div className="space-y-2 p-4">
                <div
                  className="h-2 w-2/3 rounded-full opacity-30"
                  style={{ background: theme.fg }}
                />
                <div
                  className="h-2 w-1/2 rounded-full opacity-20"
                  style={{ background: theme.fg }}
                />
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <div
                    className="aspect-[4/3] rounded-md opacity-15"
                    style={{ background: theme.fg }}
                  />
                  <div
                    className="aspect-[4/3] rounded-md opacity-10"
                    style={{ background: theme.fg }}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-20 grid gap-10 lg:grid-cols-[1fr_1.2fr] lg:items-center">
        <div>
          <h2 className="text-2xl font-semibold tracking-[-0.03em] text-foreground">
            The rest of the store
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            Familiar commerce tools, without the usual lock-in story.
          </p>
          <ul className="mt-8 space-y-6">
            {stack.map((item) => (
              <li key={item.title} className="flex gap-3">
                <item.icon className="mt-0.5 size-5 shrink-0 text-brand" />
                <div>
                  <p className="font-medium text-foreground">{item.title}</p>
                  <p className="mt-1 text-sm leading-6 text-muted">{item.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-[var(--radius-card)] border border-border bg-surface p-6 shadow-[var(--shadow-sm)]">
          <p className="font-mono text-[11px] text-muted-soft">threshold meter</p>
          <p className="mt-4 text-sm text-muted">Trailing 12-month sales</p>
          <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums text-foreground">
            $482k
            <span className="text-base font-normal text-muted"> / $750k</span>
          </p>
          <div className="mt-4 h-2 overflow-hidden rounded-full bg-hover">
            <div className="h-full w-[64%] rounded-full bg-brand" />
          </div>
          <p className="mt-3 text-sm text-muted">
            Still below Growth threshold. No Markii fee this period.
          </p>
          <div className="mt-6 grid grid-cols-3 gap-3 border-t border-border pt-5 text-center">
            {[
              { label: "Stores", value: "3" },
              { label: "Seats", value: "∞" },
              { label: "Digital fee", value: "0%" },
            ].map((stat) => (
              <div key={stat.label}>
                <p className="text-lg font-semibold tabular-nums text-foreground">
                  {stat.value}
                </p>
                <p className="text-xs text-muted">{stat.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mt-20 border-t border-border-nav pt-14">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">
          What we skip on purpose
        </h2>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">
          No warehouses, shipping labels, or POS. No holding your payouts. No
          chargeback insurance. You get dispute visibility for free, and
          optional help responding. For email campaigns, plug in Klaviyo or a
          similar tool.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <ButtonLink href="/pricing">View pricing</ButtonLink>
          <ButtonLink href="/contact" variant="secondary">
            Talk to us
          </ButtonLink>
        </div>
      </section>
    </div>
  );
}
