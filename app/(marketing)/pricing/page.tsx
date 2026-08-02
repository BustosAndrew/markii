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
    threshold: "$150k",
    overage: "0.5%",
    highlight: false,
  },
  {
    id: "growth",
    name: "Growth",
    annual: 39,
    monthly: 49,
    stores: "3 storefronts",
    threshold: "$750k",
    overage: "0.4%",
    highlight: true,
  },
  {
    id: "scale",
    name: "Scale",
    annual: 99,
    monthly: 129,
    stores: "10 storefronts",
    threshold: "$3M",
    overage: "0.3%",
    highlight: false,
  },
] as const;

const included = [
  "Unlimited staff seats",
  "0% Markii fee on any payment provider",
  "0% on digital goods & memberships",
  "Agent-legible storefronts (HTML, JSON-LD, llms.txt, agent.md)",
  "API + MCP access",
  "Dispute inbox",
  "Threshold meter on every plan",
];

const addOns = [
  { name: "Agent Ops", price: "$29/mo", note: "+ metered usage above allowance" },
  { name: "Chargeback Assist", price: "$19/mo", note: "Included on Scale" },
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
        no platform penalty. Digital goods stay at 0%. Markii transaction fees
        only apply after you cross a high annual threshold — and only to sales
        above it.
      </p>
      <p className="mt-3 text-xs text-muted-soft">
        Figures from Markii&apos;s pricing proposal (verified competitor sources
        2026-07-29). Subject to final launch confirmation.
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
                <span className="text-foreground">{plan.threshold}</span> T12
              </li>
              <li>
                Above threshold{" "}
                <span className="text-foreground">{plan.overage}</span>
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
          goods until Advanced. Markii charges{" "}
          <strong className="font-medium text-foreground">0%</strong> in both
          cases, on every plan. Competitor figures verified 2026-07-29 from
          first-party pricing pages.
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
