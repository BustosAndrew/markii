"use client";

import Link from "next/link";
import { motion } from "motion/react";
import {
  ArrowRight,
  BarChart3,
  Bot,
  Download,
  FileText,
  Globe,
  Wallet,
} from "lucide-react";
import { Logo } from "@/components/logo";

const fadeUp = {
  hidden: { opacity: 0, y: 24 },
  show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: "easeOut" as const } },
};

const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08 } },
};

const features = [
  {
    icon: Bot,
    title: "Agent-readable storefronts",
    body: "Plain HTML + JSON-LD every crawler and LLM can parse. No JS required to buy.",
  },
  {
    icon: FileText,
    title: "llms.txt & agent.md",
    body: "Auto-generated protocol files that tell agents what you sell and how to pay.",
  },
  {
    icon: Wallet,
    title: "x402 payments",
    body: "Agents settle in USDC on Base Sepolia. No cards, no checkout forms.",
  },
  {
    icon: Download,
    title: "One-click import",
    body: "Pull your catalog from Shopify, WooCommerce, or a CSV in seconds.",
  },
  {
    icon: Globe,
    title: "Multi-tenant domains",
    body: "Every store gets a subdomain. Bring a custom domain when you're ready.",
  },
  {
    icon: BarChart3,
    title: "Agent analytics",
    body: "See which agents visited, what they viewed, and what they bought.",
  },
];

const steps = [
  {
    n: "01",
    title: "Import",
    body: "Upload a CSV or paste a store URL. Markii structures the catalog for you.",
  },
  {
    n: "02",
    title: "Deploy",
    body: "One click spins up a crawlable storefront with JSON-LD, llms.txt, and agent.md.",
  },
  {
    n: "03",
    title: "Get paid",
    body: "Agents hit a 402 challenge, settle in USDC, and the order confirms instantly.",
  },
];

const terminalLines = [
  { text: "$ GET markii.store/p/aurora-sneakers", tone: "text-foreground" },
  { text: "← 402 Payment Required", tone: "text-brand" },
  { text: '  { "asset": "USDC", "amount": "45.00", "network": "base-sepolia" }', tone: "text-muted" },
  { text: "$ retry — x402-payment-signature: 0x8f2a…c41d", tone: "text-foreground" },
  { text: "← 200 OK · order confirmed ✓", tone: "text-brand-amber" },
];

export default function Home() {
  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      {/* ambient gradient blobs */}
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="animate-drift absolute -top-40 left-1/2 h-130 w-130 -translate-x-full rounded-full bg-brand/25 blur-[140px]" />
        <div className="animate-drift-slow absolute top-20 right-0 h-110 w-110 translate-x-1/3 rounded-full bg-brand-orange/20 blur-[140px]" />
        <div className="absolute top-[42rem] left-0 h-100 w-100 -translate-x-1/2 rounded-full bg-brand-deep/30 blur-[140px]" />
      </div>

      {/* nav */}
      <header className="sticky top-0 z-50 border-b border-white/5 bg-background/70 backdrop-blur-md">
        <nav className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <Logo size={30} />
            <span className="text-lg font-semibold tracking-tight">markii</span>
          </Link>
          <div className="flex items-center gap-6">
            <a
              href="#features"
              className="hidden text-sm text-muted transition-colors hover:text-foreground sm:block"
            >
              Features
            </a>
            <a
              href="#how"
              className="hidden text-sm text-muted transition-colors hover:text-foreground sm:block"
            >
              How it works
            </a>
            <Link
              href="/dashboard"
              className="bg-gradient-brand flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
            >
              Open Dashboard
              <ArrowRight className="size-4" />
            </Link>
          </div>
        </nav>
      </header>

      {/* hero */}
      <motion.section
        variants={stagger}
        initial="hidden"
        animate="show"
        className="mx-auto flex w-full max-w-6xl flex-col items-center px-6 pt-24 pb-20 text-center sm:pt-32"
      >
        <motion.span
          variants={fadeUp}
          className="mb-6 rounded-full border border-white/10 bg-surface px-4 py-1.5 font-mono text-xs tracking-wide text-muted"
        >
          x402 · llms.txt · JSON-LD · MCP
        </motion.span>
        <motion.h1
          variants={fadeUp}
          className="max-w-3xl text-5xl font-semibold tracking-tight text-balance sm:text-6xl"
        >
          The storefront built for <span className="text-gradient">AI buyers</span>
        </motion.h1>
        <motion.p
          variants={fadeUp}
          className="mt-6 max-w-xl text-lg leading-8 text-muted text-pretty"
        >
          Markii turns your catalog into machine-readable stores that agents can
          crawl, understand, and pay — in USDC over x402.
        </motion.p>
        <motion.div variants={fadeUp} className="mt-10 flex flex-wrap items-center justify-center gap-4">
          <Link
            href="/dashboard"
            className="bg-gradient-brand flex items-center gap-2 rounded-full px-6 py-3 font-medium text-white shadow-lg shadow-brand/25 transition-all hover:opacity-90 hover:shadow-brand/40"
          >
            Open Dashboard
            <ArrowRight className="size-4" />
          </Link>
          <a
            href="#how"
            className="rounded-full border border-white/10 px-6 py-3 font-medium text-foreground transition-colors hover:border-white/25"
          >
            See how it works
          </a>
        </motion.div>

        {/* agent purchase terminal */}
        <motion.div
          variants={fadeUp}
          className="mt-16 w-full max-w-2xl rounded-2xl border border-white/10 bg-surface/80 text-left shadow-2xl shadow-brand-deep/20 backdrop-blur"
        >
          <div className="flex items-center gap-1.5 border-b border-white/5 px-4 py-3">
            <span className="size-2.5 rounded-full bg-brand-deep" />
            <span className="size-2.5 rounded-full bg-brand" />
            <span className="size-2.5 rounded-full bg-brand-orange" />
            <span className="ml-3 font-mono text-xs text-muted">agent — checkout via x402</span>
          </div>
          <div className="space-y-2 overflow-x-auto p-5 font-mono text-xs sm:text-sm">
            {terminalLines.map((line, i) => (
              <motion.p
                key={line.text}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.9 + i * 0.45, duration: 0.35 }}
                className={`whitespace-pre ${line.tone}`}
              >
                {line.text}
              </motion.p>
            ))}
          </div>
        </motion.div>
      </motion.section>

      {/* features */}
      <section id="features" className="mx-auto w-full max-w-6xl px-6 py-20">
        <motion.div
          variants={stagger}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, margin: "-80px" }}
        >
          <motion.h2 variants={fadeUp} className="text-3xl font-semibold tracking-tight">
            Everything a store needs to <span className="text-gradient">speak agent</span>
          </motion.h2>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((f) => (
              <motion.div
                key={f.title}
                variants={fadeUp}
                whileHover={{ y: -4 }}
                className="rounded-2xl border border-white/10 bg-surface/60 p-6 transition-colors hover:border-brand/40"
              >
                <f.icon className="size-6 text-brand" />
                <h3 className="mt-4 font-medium">{f.title}</h3>
                <p className="mt-2 text-sm leading-6 text-muted">{f.body}</p>
              </motion.div>
            ))}
          </div>
        </motion.div>
      </section>

      {/* how it works */}
      <section id="how" className="mx-auto w-full max-w-6xl px-6 py-20">
        <motion.div
          variants={stagger}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, margin: "-80px" }}
        >
          <motion.h2 variants={fadeUp} className="text-3xl font-semibold tracking-tight">
            Live in <span className="text-gradient">three steps</span>
          </motion.h2>
          <div className="mt-10 grid gap-4 sm:grid-cols-3">
            {steps.map((s) => (
              <motion.div
                key={s.n}
                variants={fadeUp}
                className="rounded-2xl border border-white/10 bg-surface/60 p-6"
              >
                <span className="text-gradient font-mono text-sm font-semibold">{s.n}</span>
                <h3 className="mt-3 text-lg font-medium">{s.title}</h3>
                <p className="mt-2 text-sm leading-6 text-muted">{s.body}</p>
              </motion.div>
            ))}
          </div>
        </motion.div>
      </section>

      {/* cta */}
      <section className="mx-auto w-full max-w-6xl px-6 py-20">
        <motion.div
          initial={{ opacity: 0, scale: 0.97 }}
          whileInView={{ opacity: 1, scale: 1 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6, ease: "easeOut" }}
          className="bg-gradient-brand relative overflow-hidden rounded-3xl px-8 py-16 text-center"
        >
          <h2 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            Agents are already shopping.
          </h2>
          <p className="mx-auto mt-3 max-w-md text-white/80">
            Put your catalog where they can find it — and pay for it.
          </p>
          <Link
            href="/dashboard"
            className="mt-8 inline-flex items-center gap-2 rounded-full bg-white px-6 py-3 font-medium text-brand-deep transition-transform hover:scale-[1.03]"
          >
            Open Dashboard
            <ArrowRight className="size-4" />
          </Link>
        </motion.div>
      </section>

      {/* footer */}
      <footer className="border-t border-white/5">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-8 text-sm text-muted">
          <div className="flex items-center gap-2">
            <Logo size={22} />
            <span>markii</span>
          </div>
          <span>Agentic commerce, headless by design.</span>
        </div>
      </footer>
    </div>
  );
}
