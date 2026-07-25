"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import {
  ArrowRight,
  Bot,
  FileCode2,
  ShoppingBag,
  Wallet,
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
  { agent: "Gemini", action: "crawled sitemap.xml" },
];

const navLinks = [
  { href: "#capabilities", label: "Capabilities" },
  { href: "#dashboard", label: "Dashboard" },
  { href: "#how", label: "How it works" },
];

// Rail and nodes inherit the section's variant state: animating them from a
// zero-size box would keep IntersectionObserver from ever reporting them.
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

const features = [
  {
    icon: ShoppingBag,
    title: "Import once",
    body: "CSV, Shopify, or Woo — structured for agents.",
  },
  {
    icon: FileCode2,
    title: "Machine-readable",
    body: "HTML, JSON-LD, llms.txt, and agent.md.",
  },
  {
    icon: Wallet,
    title: "x402 payouts",
    body: "Agents settle in USDC on Base Sepolia.",
  },
  {
    icon: Bot,
    title: "Agent traffic",
    body: "See who crawled, viewed, and bought.",
  },
];

const steps = [
  {
    title: "Import",
    body: "Catalog in seconds.",
    artifact: { value: "products.csv", meta: "· 128 rows" },
  },
  {
    title: "Deploy",
    body: "Crawlable storefront live.",
    artifact: { value: "aurora.markii.store", dot: true },
  },
  {
    title: "Get paid",
    body: "402 → pay → order.",
    artifact: { value: "+145.00 USDC", meta: "· 0x8f…c41" },
  },
] satisfies {
  title: string;
  body: string;
  artifact: { value: string; meta?: string; dot?: boolean };
}[];

const terminalLines = [
  { text: "$ GET /p/aurora-sneakers", tone: "text-foreground" },
  { text: "← 402 Payment Required", tone: "text-brand" },
  {
    text: '  { "asset": "USDC", "network": "base-sepolia" }',
    tone: "text-muted",
  },
  { text: "$ retry — x402 signature", tone: "text-foreground" },
  { text: "← 200 OK · order confirmed", tone: "text-brand" },
];

export default function Home() {
  return (
    <MotionConfig reducedMotion="user">
      <div className="relative flex flex-1 flex-col bg-background">
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="animate-drift absolute -top-32 left-1/2 h-120 w-120 -translate-x-[70%] rounded-full bg-brand/8 blur-[120px]" />
        <div className="animate-drift-slow absolute top-48 right-0 h-100 w-100 translate-x-1/4 rounded-full bg-brand-light/10 blur-[120px]" />
      </div>

      <header className="sticky top-3 z-50 px-3 sm:top-5 sm:px-6">
        <nav className="mx-auto flex h-16 w-full max-w-5xl items-center gap-6 rounded-full border border-border bg-surface/90 pr-2 pl-4 shadow-[var(--shadow-md)] backdrop-blur-2xl backdrop-saturate-150 sm:h-[4.25rem] sm:pl-6">
          <Link href="/" className="flex shrink-0 items-center gap-2.5">
            <Logo size={36} />
            <span className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
              markii
            </span>
          </Link>

          <ul className="hidden flex-1 items-center justify-center gap-8 text-sm text-muted md:flex">
            {navLinks.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="transition-colors hover:text-foreground"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>

          <ButtonLink
            href="/dashboard"
            className="ml-auto shrink-0 gap-1.5 rounded-full px-5 py-2.5 md:ml-0"
          >
            Open Dashboard
            <ArrowRight className="size-4" />
          </ButtonLink>
        </nav>
      </header>

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
          Storefronts for{" "}
          <span className="relative whitespace-nowrap">
            AI Agents
            <motion.span
              aria-hidden
              variants={underlineDraw}
              className="absolute -bottom-[0.02em] left-0 -z-10 h-[0.08em] w-full origin-left rounded-full bg-brand"
            />
          </span>
        </motion.h1>
        <motion.p
          variants={fadeUp}
          className="mt-5 max-w-lg text-lg leading-8 text-muted text-pretty sm:text-xl sm:leading-9"
        >
          Import your catalog. Deploy machine-readable stores. Get paid in USDC
          over x402.
        </motion.p>
        <motion.div
          variants={fadeUp}
          className="mt-8 flex flex-wrap items-center justify-center gap-3"
        >
          <ButtonLink href="/dashboard" className="gap-2 px-6 py-3">
            Open Dashboard
            <ArrowRight className="size-4" />
          </ButtonLink>
          <ButtonLink href="#how" variant="secondary" className="px-6 py-3">
            How it works
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
        className="mx-auto w-full max-w-5xl scroll-mt-28 border-y border-border-nav px-6 py-12"
      >
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {features.map((f) => (
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

      <DashboardTour />

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
            From a catalog file to settled USDC, with no agent plumbing to
            build.
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

        <motion.div
          id="proof"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={inView}
          transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
          className="mt-14 overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface shadow-[var(--shadow-md)]"
        >
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <span className="size-2 rounded-full bg-border" />
            <span className="size-2 rounded-full bg-border" />
            <span className="size-2 rounded-full bg-brand" />
            <span className="ml-2 font-mono text-xs text-muted">
              agent · x402 checkout
            </span>
            <span className="ml-auto font-mono text-xs text-muted-soft">
              base-sepolia
            </span>
          </div>
          <div className="space-y-2.5 overflow-x-auto px-5 py-6 font-mono text-xs sm:px-8 sm:py-8 sm:text-sm">
            {terminalLines.map((line, i) => (
              <motion.p
                key={line.text}
                initial={{ opacity: 0, x: -8 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ delay: 0.15 + i * 0.28, duration: 0.28 }}
                className={`whitespace-pre ${line.tone}`}
              >
                {line.text}
                {i === terminalLines.length - 1 ? (
                  <motion.span
                    animate={{ opacity: [1, 1, 0, 0] }}
                    transition={{ duration: 1.1, repeat: Infinity }}
                    className="ml-1 inline-block h-3.5 w-1.5 translate-y-px bg-brand align-middle"
                  />
                ) : null}
              </motion.p>
            ))}
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
              Put your catalog where agents shop.
            </p>
            <p className="mt-1 text-sm text-muted">
              No checkout forms. No JS required to buy.
            </p>
          </div>
          <ButtonLink href="/dashboard" className="shrink-0 gap-2 px-5 py-2.5">
            Open Dashboard
            <ArrowRight className="size-4" />
          </ButtonLink>
        </div>
      </motion.section>

      <footer className="border-t border-border-nav">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-8 text-sm text-muted">
          <div className="flex items-center gap-2 text-foreground">
            <Logo size={24} />
            <span className="font-medium">markii</span>
          </div>
          <span>Agentic commerce infrastructure</span>
        </div>
        </footer>
      </div>
    </MotionConfig>
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
      <span className="hidden text-muted sm:inline">aurora.markii.store</span>
      <AnimatePresence mode="wait">
        <motion.span
          key={entry.agent}
          initial={{ opacity: 0, y: 7 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -7 }}
          transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
          className="whitespace-nowrap text-muted"
        >
          <span className="text-foreground">{entry.agent}</span>{" "}
          {entry.action}
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
          aurora.markii.store/p/aurora-sneakers
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
            Everyday trainer, recycled knit upper. Ships in 2 days.
          </p>
          <div className="mt-5 flex items-center gap-3">
            <span className="rounded-[var(--radius-control)] bg-brand px-4 py-2 text-sm font-medium text-on-brand">
              Buy · x402
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
            transition={{ delay: 0.55, duration: 0.75, ease: [0.22, 1, 0.36, 1] }}
            style={{ transformOrigin: "right" }}
            className="pointer-events-none absolute inset-0 z-10 bg-surface-elevated"
          />
          <p className="font-mono text-[11px] text-muted-soft">agent view</p>
          <pre className="mt-4 overflow-x-auto font-mono text-[11px] leading-5 text-muted sm:text-xs">
            {`{
  "@context": "https://schema.org",
  "@type": "Product",
  "name": "Aurora Sneakers",
  "offers": {
    "@type": "Offer",
    "price": "145.00",
    "priceCurrency": "USDC",
    "availability": "InStock",
    "paymentMethod": "x402"
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

function DashboardTour() {
  return (
    <section id="dashboard" className="relative scroll-mt-24">
      <div className="bg-dot-grid pointer-events-none absolute inset-0 opacity-60 [mask-image:linear-gradient(to_bottom,transparent,black_12%,black_88%,transparent)]" />
      <motion.div
        initial="hidden"
        whileInView="show"
        viewport={inView}
        variants={stagger}
        className="relative mx-auto w-full max-w-5xl px-6 py-16"
      >
        <motion.h2
          variants={fadeUp}
          className="max-w-lg text-2xl font-semibold tracking-tight text-balance text-foreground sm:text-3xl"
        >
          One dashboard for the whole agent storefront
        </motion.h2>
        <motion.p variants={fadeUp} className="mt-3 max-w-md text-muted">
          Catalog, deploys, traffic, payouts, and connections.
        </motion.p>

        <motion.div
          variants={fadeUp}
          className="mt-10 grid gap-4 sm:grid-cols-3"
        >
          <StatMock
            label="Sites"
            value="3"
            detail="2 live · 1 draft · 0 paused"
          />
          <StatMock
            label="Agent traffic"
            value="512"
            detail="287 in the last 7 days"
            spark
          />
          <StatMock
            label="Total balance"
            value="$638.00"
            detail="15 settled orders"
          />
        </motion.div>

        <div className="mt-4 grid gap-4 lg:grid-cols-6">
          <Panel
            className="lg:col-span-4"
            title="Site wizard"
            body="Preview HTML, llms.txt, agent.md, and sitemap before deploy."
          >
            <WizardMock />
          </Panel>

          <Panel
            className="lg:col-span-2"
            title="Categories"
            body="Nest subcategories, reassign across sites."
          >
            <CategoryMock />
          </Panel>

          <Panel
            className="lg:col-span-2"
            title="Analytics"
            body="Which agents crawl, and what they read."
          >
            <AnalyticsMock />
          </Panel>

          <Panel
            className="lg:col-span-4"
            title="Finances"
            body="Every settlement with agent, status, and tx hash."
          >
            <FinancesMock />
          </Panel>

          <Panel
            className="lg:col-span-4"
            title="Inventory"
            body="Search, filter, and bulk-import products across sites."
          >
            <InventoryMock />
          </Panel>

          <Panel
            className="lg:col-span-2"
            title="Integrations"
            body="x402 wallet, Merchant Center, optional Stripe."
          >
            <IntegrationsMock />
          </Panel>
        </div>
      </motion.div>
    </section>
  );
}

function StatMock({
  label,
  value,
  detail,
  spark,
}: {
  label: string;
  value: string;
  detail: string;
  spark?: boolean;
}) {
  const bars = [40, 52, 38, 61, 45, 57, 36, 63, 48, 55, 41, 59];
  const peak = Math.max(...bars);
  return (
    <div className="flex flex-col rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-3 text-3xl font-semibold tracking-tight text-foreground">
        {value}
      </p>
      {spark ? (
        <div className="mt-3 flex h-8 items-end gap-px" aria-hidden>
          {bars.map((b, i) => (
            <span
              key={i}
              className="flex-1 rounded-t-[2px] bg-brand"
              style={{ height: `${(b / peak) * 100}%`, opacity: 0.3 + 0.7 * (b / peak) }}
            />
          ))}
        </div>
      ) : null}
      <p className="mt-auto pt-2 text-sm text-muted">{detail}</p>
    </div>
  );
}

function Panel({
  title,
  body,
  children,
  className = "",
}: {
  title: string;
  body: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <motion.article
      variants={fadeUp}
      className={`flex flex-col rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)] transition-shadow hover:shadow-[var(--shadow-md)] ${className}`}
    >
      <h3 className="text-sm font-semibold tracking-tight text-foreground">
        {title}
      </h3>
      <p className="mt-1 text-sm leading-6 text-muted">{body}</p>
      <div className="mt-5 flex-1">{children}</div>
    </motion.article>
  );
}

function WizardMock() {
  const tabs = ["HTML", "llms.txt", "agent.md", "sitemap"];
  return (
    <div className="overflow-hidden rounded-[var(--radius-control)] border border-border bg-surface-elevated">
      <div className="flex gap-1 border-b border-border p-2">
        {tabs.map((tab, i) => (
          <span
            key={tab}
            className={`rounded-full px-2.5 py-1 font-mono text-[11px] ${
              i === 1
                ? "bg-brand text-on-brand"
                : "bg-hover-soft text-muted"
            }`}
          >
            {tab}
          </span>
        ))}
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[11px] leading-5 text-muted">
        {`# Aurora Supply
> Sneakers and gear, agent-ready.

## Products
- /p/aurora-sneakers — $145.00 USDC
- /p/trail-runner — $118.00 USDC

## Payment
x402 · USDC · base-sepolia`}
      </pre>
    </div>
  );
}

function CategoryMock() {
  return (
    <ul className="space-y-2 text-sm">
      <li className="font-medium text-foreground">Footwear</li>
      <li className="ml-3 border-l border-border pl-3 text-muted">Sneakers</li>
      <li className="ml-3 border-l border-border pl-3 text-muted">Trail</li>
      <li className="mt-3 font-medium text-foreground">Apparel</li>
      <li className="ml-3 border-l border-border pl-3 text-muted">Jackets</li>
    </ul>
  );
}

function AnalyticsMock() {
  // one measure → one hue, matching the dashboard's charts
  const rows = [
    { label: "GPTBot", pct: 100, count: 116 },
    { label: "Perplexity", pct: 89, count: 103 },
    { label: "Gemini", pct: 87, count: 101 },
    { label: "Claude", pct: 84, count: 97 },
  ];
  const days = [38, 44, 35, 50, 41, 46, 33, 47, 39, 43, 36, 45];
  const peak = Math.max(...days);

  return (
    <div className="space-y-4">
      <div className="flex h-14 items-end gap-[3px]" aria-hidden>
        {days.map((d, i) => (
          <span
            key={i}
            className={`flex-1 rounded-t-[3px] ${d === peak ? "bg-brand" : "bg-brand/55"}`}
            style={{ height: `${(d / peak) * 100}%` }}
          />
        ))}
      </div>
      <div className="space-y-2.5">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center gap-3 text-xs">
            <span className="w-16 shrink-0 text-foreground">{row.label}</span>
            <span className="h-2 flex-1 rounded-full bg-hover">
              <span
                className="block h-full rounded-l-full rounded-r-[3px] bg-brand"
                style={{ width: `${row.pct}%` }}
              />
            </span>
            <span className="w-7 shrink-0 text-right tabular-nums text-muted">
              {row.count}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function FinancesMock() {
  const rows = [
    {
      product: "Aurora Sneakers",
      amount: "145.00 USDC",
      status: "success",
      agent: "Claude",
    },
    {
      product: "Trail Runner",
      amount: "118.00 USDC",
      status: "pending",
      agent: "GPTBot",
    },
    {
      product: "Alpine Jacket",
      amount: "212.00 USDC",
      status: "success",
      agent: "Perplexity",
    },
  ];
  return (
    <div className="overflow-hidden rounded-[var(--radius-control)] border border-border">
      {rows.map((row, i) => (
        <div
          key={row.product}
          className={`flex items-center justify-between gap-3 px-3 py-2.5 text-sm ${
            i > 0 ? "border-t border-border" : ""
          }`}
        >
          <div className="min-w-0">
            <p className="truncate font-medium text-foreground">
              {row.product}
            </p>
            <p className="text-xs text-muted">{row.agent}</p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <span className="font-mono text-xs tabular-nums text-foreground">
              {row.amount}
            </span>
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                row.status === "success"
                  ? "bg-success-bg text-success-text"
                  : "bg-warning-bg text-warning-text"
              }`}
            >
              {row.status}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function InventoryMock() {
  const rows = [
    { name: "Aurora Sneakers", price: "$145.00", stock: 24 },
    { name: "Trail Runner", price: "$118.00", stock: 8 },
    { name: "Alpine Jacket", price: "$212.00", stock: 0 },
  ];
  return (
    <div className="overflow-hidden rounded-[var(--radius-control)] border border-border">
      <div className="grid grid-cols-[1fr_auto_auto] gap-4 bg-surface-elevated px-3 py-2 text-[11px] text-muted">
        <span>Product</span>
        <span>Price</span>
        <span>Stock</span>
      </div>
      {rows.map((row) => (
        <div
          key={row.name}
          className="grid grid-cols-[1fr_auto_auto] items-center gap-4 border-t border-border px-3 py-2.5 text-sm"
        >
          <span className="truncate text-foreground">{row.name}</span>
          <span className="font-mono text-xs tabular-nums text-muted">
            {row.price}
          </span>
          <span
            className={`w-8 text-right font-mono text-xs tabular-nums ${
              row.stock === 0 ? "text-error-text" : "text-muted"
            }`}
          >
            {row.stock}
          </span>
        </div>
      ))}
    </div>
  );
}

function IntegrationsMock() {
  const rows = [
    { name: "x402 wallet", connected: true },
    { name: "Merchant Center", connected: false },
    { name: "Stripe", connected: false },
  ];
  return (
    <ul className="space-y-3 text-sm">
      {rows.map((row) => (
        <li key={row.name} className="flex items-center justify-between gap-3">
          <span className="text-foreground">{row.name}</span>
          <span className="flex items-center gap-2 text-xs text-muted">
            <span
              className={`size-2 rounded-full ${
                row.connected ? "bg-success-text" : "bg-border"
              }`}
            />
            {row.connected ? "Connected" : "Not set"}
          </span>
        </li>
      ))}
    </ul>
  );
}
