import type { Metadata } from "next";
import { Mail } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Contact — Markii",
  description: "Contact Markii support at support@markii.shop.",
};

export default function ContactPage() {
  return (
    <div className="mx-auto w-full max-w-5xl px-6 pt-14 pb-20">
      <p className="text-sm font-medium text-brand">Contact</p>
      <h1 className="mt-2 max-w-xl text-4xl font-semibold tracking-[-0.04em] text-balance text-foreground sm:text-5xl">
        We&apos;re here when you need us
      </h1>
      <p className="mt-4 max-w-xl text-lg leading-8 text-muted">
        Product questions, onboarding help, or billing — reach the Markii team
        directly. Human support is on every plan; response targets scale with
        tier.
      </p>

      <div className="mt-12 max-w-lg rounded-[var(--radius-card)] border border-border bg-surface p-8">
        <div className="flex size-10 items-center justify-center rounded-[var(--radius-control)] bg-brand/10 text-brand">
          <Mail className="size-5" strokeWidth={1.75} />
        </div>
        <h2 className="mt-5 text-lg font-semibold tracking-tight text-foreground">
          Email support
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted">
          The fastest way to reach us. Include your store URL or org name if you
          already have an account.
        </p>
        <a
          href="mailto:support@markii.shop"
          className="mt-5 inline-flex text-xl font-medium tracking-tight text-foreground transition-colors hover:text-brand"
        >
          support@markii.shop
        </a>
        <div className="mt-8 flex flex-wrap gap-3">
          <a href="mailto:support@markii.shop">
            <Button type="button">Write an email</Button>
          </a>
          <ButtonLink href="/pricing" variant="secondary">
            View pricing
          </ButtonLink>
        </div>
      </div>

      <p className="mt-10 max-w-lg text-sm leading-6 text-muted">
        Severity outranks plan: a broken checkout is handled before a styling
        question, regardless of tier. First-response targets are 2 business
        days (Starter), 1 business day (Growth), and 8 business hours (Scale).
      </p>
    </div>
  );
}
