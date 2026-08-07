"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import {
  ArrowRight,
  Bot,
  CreditCard,
  FileCode2,
  Gauge,
  Layers,
  ShoppingBag,
  Sparkles,
} from "lucide-react";
import { Logo } from "@/components/logo";
import { ButtonLink } from "@/components/ui/button";

const fadeUp = {
  hidden: { opacity: 0, y: 18, filter: "blur(4px)" },
  show: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: { duration: 0.55, ease: [0.22, 1, 0.36, 1] as const },
  },
};

const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.09 } },
};

const inView = { once: true, margin: "-60px" } as const;

const underlineDraw = {
  hidden: { scaleX: 0 },
  show: {
    scaleX: 1,
    transition: {
      delay: 0.45,
      duration: 0.7,
      ease: [0.22, 1, 0.36, 1] as const,
    },
  },
};

const agentFeed = [
  { agent: "ClaudeBot", action: "fetched llms.txt" },
  { agent: "GPTBot", action: "read 12 products" },
  { agent: "PerplexityBot", action: "paid 145.00 USDC" },
  { agent: "Shopper", action: "completed card checkout" },
];

const pillars = [
  {
    icon: ShoppingBag,
    title: "Full commerce",
    body: "Catalog, variants, collections, customers, cart, and checkout — humans and agents on the same store.",
  },
  {
    icon: FileCode2,
    title: "Agent-legible by default",
    body: "Semantic HTML, JSON-LD, llms.txt, and agent.md — built in, not bolted on.",
  },
  {
    icon: CreditCard,
    title: "Bring your own payments",
    body: "0% Markii platform fee on any processor. Stripe, PayPal, card, and x402 are peer rails.",
  },
  {
    icon: Gauge,
    title: "Grow before you pay fees",
    body: "No Markii transaction fee until you cross your plan threshold — then only on the slice above it.",
  },
];

const platform = [
  {
    title: "Catalog & inventory",
    body: "Products, variants, collections, locations, and import from CSV, Shopify, or Woo.",
  },
  {
    title: "Checkout for people & agents",
    body: "Human cart and sessions alongside x402 for agent purchase flows.",
  },
  {
    title: "Storefront themes",
    body: "Studio, Atlas, Noir, and Bloom — polished SSR themes that stay crawlable.",
  },
  {
    title: "Teams & billing",
    body: "Organizations, staff roles, and a threshold meter that never invents a zero.",
  },
  {
    title: "Readiness score",
    body: "Rule-based catalog health so agents can actually buy from what you publish.",
  },
  {
    title: "Agent-native admin",
    body: "One action registry for UI, API, and MCP — same permissions, same audit trail.",
  },
];

const steps = [
  {
    title: "Import",
    body: "Bring a catalog in seconds.",
    artifact: { value: "products.csv", meta: "· 128 rows" },
  },
  {
    title: "Theme & deploy",
    body: "Pick a theme. Go live.",
    artifact: { value: "aurora.markii.shop", dot: true },
  },
  {
    title: "Sell",
    body: "Humans check out. Agents settle.",
    artifact: { value: "card · x402", meta: "· peer rails" },
  },
] satisfies {
  title: string;
  body: string;
  artifact: { value: string; meta?: string; dot?: boolean };
}[];

const railDraw = {
  hidden: { scaleX: 0 },
  show: {
    scaleX: 1,
    transition: { duration: 1.1, ease: [0.22, 1, 0.36, 1] as const },
  },
};

const nodePop = {
  hidden: { scale: 0, opacity: 0 },
  show: {
    scale: 1,
    opacity: 1,
    transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] as const },
  },
};

export default function Home() {
  return (
    <MotionConfig reducedMotion="user">
      <motion.section
        variants={stagger}
        initial="hidden"
        animate="show"
        className="mx-auto flex w-full max-w-5xl flex-col items-center px-6 pt-16 pb-14 text-center sm:pt-20 sm:pb-16"
      >
        <motion.div variants={fadeUp} className="relative mb-8">
          <span
            aria-hidden
            className="animate-beacon absolute top-1/2 left-1/2 size-44 -translate-x-1/2 -translate-y-1/2 rounded-full border border-brand/25"
          />
          <span
            aria-hidden
            className="animate-beacon absolute top-1/2 left-1/2 size-44 -translate-x-1/2 -translate-y-1/2 rounded-full border border-brand/25 [animation-delay:1.5s]"
          />
          <span
            aria-hidden
            className="animate-beacon absolute top-1/2 left-1/2 size-44 -translate-x-1/2 -translate-y-1/2 rounded-full border border-brand/25 [animation-delay:3s]"
          />
          <div className="animate-logo-float relative drop-shadow-[0_10px_28px_rgba(201,24,74,0.18)]">
            <Logo size={128} awake />
          </div>
        </motion.div>

        <motion.h1
          variants={fadeUp}
          className="max-w-3xl text-[2.75rem] leading-[1.14] font-semibold tracking-[-0.04em] text-balance sm:text-6xl sm:leading-[1.08] lg:text-[4.25rem]"
        >
          Commerce for{" "}
          <span className="relative whitespace-nowrap">
            people & AI
            <motion.span
              aria-hidden
              variants={underlineDraw}
              className="absolute -bottom-[0.02em] left-0 -z-10 h-[0.08em] w-full origin-left rounded-full bg-brand"
            />
          </span>
        </motion.h1>
        <motion.p
          variants={fadeUp}
          className="mt-5 max-w-xl text-lg leading-8 text-muted text-pretty sm:text-xl sm:leading-9"
        >
          A Shopify-class store with agent-readable storefronts — and no Markii
          fee until you cross your annual sales threshold.
        </motion.p>
        <motion.div
          variants={fadeUp}
          className="mt-8 flex flex-wrap items-center justify-center gap-3"
        >
          <ButtonLink href="/sign-up" className="gap-2 px-6 py-3">
            Start selling
            <ArrowRight className="size-4" />
          </ButtonLink>
          <ButtonLink href="/pricing" variant="secondary" className="px-6 py-3">
            View pricing
          </ButtonLink>
        </motion.div>

        <motion.div variants={fadeUp} className="mt-8">
          <AgentFeed />
        </motion.div>

        <motion.div variants={fadeUp} className="mt-14 w-full">
          <StorefrontArtifact />
        </motion.div>
      </motion.section>

      <motion.section
        initial="hidden"
        whileInView="show"
        viewport={inView}
        variants={stagger}
        id="capabilities"
        className="mx-auto w-full max-w-5xl scroll-mt-28 border-y border-border-nav px-6 py-14"
      >
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          {pillars.map((f) => (
            <motion.div key={f.title} variants={fadeUp} className="text-left">
              <f.icon className="size-5 text-brand" strokeWidth={1.75} />
              <h2 className="mt-3 text-sm font-semibold tracking-tight text-foreground">
                {f.title}
              </h2>
              <p className="mt-1 text-sm leading-6 text-muted">{f.body}</p>
            </motion.div>
          ))}
        </div>
      </motion.section>

      <section className="mx-auto w-full max-w-5xl px-6 py-16">
        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={inView}
          variants={stagger}
        >
          <motion.p
            variants={fadeUp}
            className="text-sm font-medium text-brand"
          >
            Platform
          </motion.p>
          <motion.h2
            variants={fadeUp}
            className="mt-2 max-w-lg text-2xl font-semibold tracking-[-0.03em] text-balance text-foreground sm:text-3xl"
          >
            Everything you need to sell — plus the agent layer
          </motion.h2>
          <div className="mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
            {platform.map((item) => (
              <motion.div key={item.title} variants={fadeUp}>
                <h3 className="text-sm font-semibold tracking-tight text-foreground">
                  {item.title}
                </h3>
                <p className="mt-1.5 text-sm leading-6 text-muted">{item.body}</p>
              </motion.div>
            ))}
          </div>
          <motion.div variants={fadeUp} className="mt-10">
            <Link
              href="/overview"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground transition-colors hover:text-brand"
            >
              Full product overview
              <ArrowRight className="size-4" />
            </Link>
          </motion.div>
        </motion.div>
      </section>

      <PricingTeaser />

      <section
        id="how"
        className="mx-auto w-full max-w-5xl scroll-mt-24 px-6 py-16 text-left"
      >
        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={inView}
          variants={stagger}
        >
          <motion.h2
            variants={fadeUp}
            className="max-w-lg text-2xl font-semibold tracking-[-0.03em] text-balance text-foreground sm:text-3xl"
          >
            Live in three moves
          </motion.h2>
          <motion.p variants={fadeUp} className="mt-3 max-w-md text-muted">
            From a catalog file to settled orders — without agent plumbing to
            build yourself.
          </motion.p>

          <div className="relative mt-12">
            <span className="pointer-events-none absolute top-[7px] right-0 left-2 hidden h-px bg-border [mask-image:linear-gradient(to_right,black_72%,transparent)] lg:block" />
            <motion.span
              variants={railDraw}
              style={{ transformOrigin: "left" }}
              className="pointer-events-none absolute top-[7px] right-0 left-2 hidden h-px bg-brand [mask-image:linear-gradient(to_right,black_72%,transparent)] lg:block"
            />
            <ol className="grid gap-10 lg:grid-cols-3 lg:gap-8">
              {steps.map((s, i) => (
                <motion.li
                  key={s.title}
                  variants={fadeUp}
                  className="relative pl-7 lg:pl-0"
                >
                  {i < steps.length - 1 ? (
                    <span className="absolute top-6 -bottom-10 left-[6px] w-px bg-border lg:hidden" />
                  ) : null}
                  <motion.span
                    variants={nodePop}
                    className="absolute top-1.5 left-0 block size-3.5 rounded-full bg-brand ring-4 ring-background lg:static"
                  />
                  <p className="text-lg font-medium tracking-tight text-foreground lg:mt-5">
                    {s.title}
                  </p>
                  <p className="mt-1 text-sm leading-6 text-muted">{s.body}</p>
                  <div className="mt-4 inline-flex items-center gap-2 rounded-[var(--radius-control)] border border-border bg-surface px-3 py-2 font-mono text-xs text-muted">
                    {s.artifact.dot ? (
                      <span className="size-1.5 shrink-0 rounded-full bg-success-text" />
                    ) : null}
                    <span className="text-foreground">{s.artifact.value}</span>
                    {s.artifact.meta ? <span>{s.artifact.meta}</span> : null}
                  </div>
                </motion.li>
              ))}
            </ol>
          </div>
        </motion.div>
      </section>

      <motion.section
        initial={{ opacity: 0, y: 12 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.45 }}
        className="mx-auto w-full max-w-5xl px-6 pb-16"
      >
        <div className="flex flex-col items-start justify-between gap-6 rounded-[var(--radius-card)] border border-border bg-surface px-6 py-8 sm:flex-row sm:items-center">
          <div>
            <p className="text-lg font-semibold tracking-tight text-foreground">
              Sell to shoppers and the agents that find them.
            </p>
            <p className="mt-1 text-sm text-muted">
              Open the dashboard, or see how pricing works first.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <ButtonLink href="/sign-up" className="shrink-0 gap-2 px-5 py-2.5">
              Start selling
              <ArrowRight className="size-4" />
            </ButtonLink>
            <ButtonLink
              href="/contact"
              variant="secondary"
              className="shrink-0 px-5 py-2.5"
            >
              Contact us
            </ButtonLink>
          </div>
        </div>
      </motion.section>
    </MotionConfig>
  );
}

function PricingTeaser() {
  return (
    <section className="border-y border-border-nav bg-surface/40">
      <div className="mx-auto grid w-full max-w-5xl gap-10 px-6 py-16 lg:grid-cols-[1.1fr_1fr] lg:items-center">
        <div>
          <p className="flex items-center gap-2 text-sm font-medium text-brand">
            <Sparkles className="size-4" />
            Pricing
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-foreground sm:text-3xl">
            Undercut the $29 market. Keep your processor.
          </h2>
          <p className="mt-3 max-w-md text-sm leading-6 text-muted">
            Starter from $15/mo billed yearly. 0% Markii fee on any payment
            provider. Threshold fees only after you grow, counted separately for
            physical and digital — never a forced upgrade.
          </p>
          <ButtonLink href="/pricing" className="mt-6 gap-2">
            See plans
            <ArrowRight className="size-4" />
          </ButtonLink>
        </div>
        <ul className="space-y-4 text-sm">
          {[
            {
              icon: Layers,
              title: "Starter · Growth · Scale",
              body: "$15 / $39 / $99 per month, billed yearly",
            },
            {
              icon: CreditCard,
              title: "0% platform fee on any processor",
              body: "Unlike Shopify/BigCommerce penalties for bringing your own",
            },
            {
              icon: Bot,
              title: "Digital priced for creators",
              body: "3% above your threshold at Starter; Squarespace takes 5% from the first sale",
            },
          ].map((row) => (
            <li key={row.title} className="flex gap-3">
              <row.icon className="mt-0.5 size-4 shrink-0 text-brand" />
              <div>
                <p className="font-medium text-foreground">{row.title}</p>
                <p className="mt-0.5 text-muted">{row.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function AgentFeed() {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      if (document.hidden) return;
      setIndex((i) => (i + 1) % agentFeed.length);
    }, 2600);
    return () => clearInterval(id);
  }, []);

  const entry = agentFeed[index];

  return (
    <div className="inline-flex h-9 items-center gap-2.5 rounded-full border border-border bg-surface/70 px-4 font-mono text-xs">
      <span className="relative flex size-1.5 shrink-0">
        <span className="absolute inset-0 animate-ping rounded-full bg-brand/70" />
        <span className="size-1.5 rounded-full bg-brand" />
      </span>
      <span className="hidden text-muted sm:inline">aurora.markii.shop</span>
      <AnimatePresence mode="wait">
        <motion.span
          key={entry.agent}
          initial={{ opacity: 0, y: 7 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -7 }}
          transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
          className="whitespace-nowrap text-muted"
        >
          <span className="text-foreground">{entry.agent}</span> {entry.action}
        </motion.span>
      </AnimatePresence>
    </div>
  );
}

function StorefrontArtifact() {
  return (
    <div className="overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface text-left shadow-[var(--shadow-md)]">
      <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <span className="truncate font-mono text-xs text-muted">
          aurora.markii.shop/p/aurora-sneakers
        </span>
        <span className="ml-auto flex items-center gap-1.5 font-mono text-xs text-muted">
          <span className="size-1.5 rounded-full bg-success-text" />
          live
        </span>
      </div>

      <div className="grid md:grid-cols-2">
        <div className="p-6 sm:p-8">
          <p className="font-mono text-[11px] text-muted-soft">human view</p>
          <h2 className="mt-4 text-xl font-semibold tracking-tight text-foreground">
            Aurora Sneakers
          </h2>
          <p className="mt-1 text-2xl font-medium tabular-nums text-foreground">
            $145.00
          </p>
          <p className="mt-3 max-w-xs text-sm leading-6 text-muted">
            Everyday purchase for people — card, Stripe, or PayPal.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <span className="rounded-[var(--radius-control)] bg-brand px-4 py-2 text-sm font-medium text-on-brand">
              Add to cart
            </span>
            <span className="rounded-full bg-success-bg px-2.5 py-0.5 text-xs font-medium text-success-text">
              In stock
            </span>
          </div>
        </div>

        <div className="relative border-t border-border bg-surface-elevated p-6 sm:p-8 md:border-t-0 md:border-l">
          <motion.span
            initial={{ scaleX: 1 }}
            animate={{ scaleX: 0 }}
            transition={{
              delay: 0.55,
              duration: 0.75,
              ease: [0.22, 1, 0.36, 1],
            }}
            style={{ transformOrigin: "right" }}
            className="pointer-events-none absolute inset-0 z-10 bg-surface-elevated"
          />
          <p className="font-mono text-[11px] text-muted-soft">agent view</p>
          <pre className="mt-4 overflow-x-auto font-mono text-[11px] leading-5 text-muted sm:text-xs">
            {`{
  "@type": "Product",
  "name": "Aurora Sneakers",
  "offers": {
    "price": "145.00",
    "priceCurrency": "USD",
    "paymentMethod": ["card", "x402"]
  }
}`}
          </pre>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border px-4 py-3 font-mono text-xs text-muted">
        <span className="text-muted-soft">emits</span>
        {["llms.txt", "agent.md", "JSON-LD", "sitemap.xml", "x402"].map(
          (chip) => (
            <span key={chip}>{chip}</span>
          ),
        )}
      </div>
    </div>
  );
}
