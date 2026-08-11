import type { Metadata } from "next";
import { Check } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Pricing — Markii",
  description:
    "Markii plans from $15/mo. Bring your own payment provider with 0% platform fee. Threshold fees only after you grow.",
};

const plans = [
  {
    id: "starter",
    name: "Starter",
    annual: 15,
    monthly: 19,
    stores: "1 storefront",
    threshold: "$1k",
    physical: "1.5%",
    digital: "3%",
    highlight: false,
  },
  {
    id: "growth",
    name: "Growth",
    annual: 39,
    monthly: 49,
    stores: "3 storefronts",
    threshold: "$50k",
    physical: "0.5%",
    digital: "1.5%",
    highlight: true,
  },
  {
    id: "scale",
    name: "Scale",
    annual: 99,
    monthly: 129,
    stores: "10 storefronts",
    threshold: "$100k",
    physical: "0.25%",
    digital: "0.5%",
    highlight: false,
  },
] as const;

const included = [
  "Unlimited staff seats",
  "0% Markii fee on any payment provider — every plan, forever",
  "Physical and digital metered separately, each against its own threshold",
  "Agent-legible storefronts (HTML, JSON-LD, llms.txt, agent.md)",
  "API + MCP access",
  "Dispute inbox",
  "Threshold meter on every plan",
];

const addOns = [
  {
    name: "Agent Ops",
    price: "Unavailable",
    note: "Not for purchase — the product does not exist yet.",
  },
  {
    name: "Chargeback Assist",
    price: "Unavailable",
    note: "Included on Scale when it ships; purchase is refused until then.",
  },
  { name: "Extra storefront", price: "$9/mo", note: "Beyond plan limit" },
];

export default function PricingPage() {
  return (
    <div className="mx-auto w-full max-w-5xl px-6 pt-14 pb-20">
      <p className="text-sm font-medium text-brand">Pricing</p>
      <h1 className="mt-2 max-w-2xl text-4xl font-semibold tracking-[-0.04em] text-balance text-foreground sm:text-5xl">
        Grow first. Pay fees later.
      </h1>
      <p className="mt-4 max-w-2xl text-lg leading-8 text-muted">
        Lower monthly than the $29 market cluster. Bring your own processor with
        no platform penalty — ever, on any plan. Markii&apos;s own fee starts
        only after you pass your plan&apos;s annual threshold, and then applies
        only to the sales above it. Physical and digital are metered separately,
        each against its own threshold.
      </p>
      <p className="mt-3 text-xs text-muted-soft">
        Current Markii pricing. Competitor sources last verified 2026-07-29.
      </p>

      <div className="mt-12 grid gap-4 lg:grid-cols-3">
        {plans.map((plan) => (
          <article
            key={plan.id}
            className={`flex flex-col rounded-[var(--radius-card)] border bg-surface p-6 ${
              plan.highlight
                ? "border-brand shadow-[var(--shadow-md)]"
                : "border-border"
            }`}
          >
            {plan.highlight ? (
              <p className="text-xs font-medium tracking-wide text-brand uppercase">
                Most teams
              </p>
            ) : (
              <p className="text-xs font-medium tracking-wide text-muted-soft uppercase">
                Plan
              </p>
            )}
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-foreground">
              {plan.name}
            </h2>
            <p className="mt-4">
              <span className="text-4xl font-semibold tracking-tight text-foreground">
                ${plan.annual}
              </span>
              <span className="text-sm text-muted">/mo</span>
            </p>
            <p className="mt-1 text-sm text-muted">
              billed yearly · ${plan.monthly}/mo monthly
            </p>
            <ul className="mt-6 space-y-2 text-sm text-muted">
              <li className="text-foreground">{plan.stores}</li>
              <li>
                Fee threshold{" "}
                <span className="text-foreground">{plan.threshold}</span> T12,
                counted separately for physical and digital
              </li>
              <li>
                Above it:{" "}
                <span className="text-foreground">{plan.physical}</span>{" "}
                physical ·{" "}
                <span className="text-foreground">{plan.digital}</span> digital
              </li>
            </ul>
            <ButtonLink
              href="/sign-up"
              variant={plan.highlight ? "primary" : "secondary"}
              className="mt-8 w-full"
            >
              Get started
            </ButtonLink>
          </article>
        ))}
      </div>

      <section className="mt-16">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">
          On every plan
        </h2>
        <ul className="mt-6 grid gap-3 sm:grid-cols-2">
          {included.map((item) => (
            <li
              key={item}
              className="flex items-start gap-2.5 text-sm leading-6 text-muted"
            >
              <Check className="mt-0.5 size-4 shrink-0 text-brand" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-16">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">
          Add-ons
        </h2>
        <ul className="mt-6 divide-y divide-border rounded-[var(--radius-card)] border border-border bg-surface">
          {addOns.map((addon) => (
            <li
              key={addon.name}
              className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-4"
            >
              <div>
                <p className="text-sm font-medium text-foreground">
                  {addon.name}
                </p>
                <p className="text-sm text-muted">{addon.note}</p>
              </div>
              <p className="font-mono text-sm tabular-nums text-foreground">
                {addon.price}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-16 max-w-2xl">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">
          How we compare — honestly
        </h2>
        <p className="mt-3 text-sm leading-6 text-muted">
          Squarespace already offers 0% store fees from $29/mo Core — so
          &ldquo;no transaction fees&rdquo; alone is parity, not advantage. The
          gaps that matter: Shopify and BigCommerce charge up to{" "}
          <strong className="font-medium text-foreground">2%</strong> for using
          your own processor from the first sale; Squarespace takes up to{" "}
          <strong className="font-medium text-foreground">5%</strong> on digital
          goods until Advanced.
        </p>
        <p className="mt-3 text-sm leading-6 text-muted">
          Markii charges{" "}
          <strong className="font-medium text-foreground">0%</strong> for
          bringing your own processor, on every plan, forever — that is the gap
          we are built around, and the one nobody else closes. On digital goods
          we charge{" "}
          <strong className="font-medium text-foreground">3%</strong> above your
          threshold at Starter, against Squarespace&apos;s 5% from the very
          first sale. On physical goods Squarespace charges 0% from Core, so on
          the platform fee alone they are cheaper than us there — what you get
          back is the freedom to keep your own processor and its rates.
          Competitor figures verified 2026-07-29 from first-party pricing pages.
        </p>
      </section>

      <div className="mt-14 flex flex-wrap gap-3">
        <ButtonLink href="/sign-up">Start selling</ButtonLink>
        <ButtonLink href="/contact" variant="secondary">
          Talk to us
        </ButtonLink>
      </div>
    </div>
  );
}
