import Link from "next/link";
import { SettingsShell } from "@/components/dashboard/settings-shell";

const sections = [
  {
    href: "/dashboard/settings/team",
    title: "Team",
    description: "Staff, invites, roles, and API tokens.",
  },
  {
    href: "/dashboard/settings/billing",
    title: "Billing",
    description: "Plan, threshold meter, payment method, and invoices.",
  },
  {
    href: "/dashboard/settings/tax",
    title: "Tax",
    description: "Tax rates and how prices include tax at checkout.",
  },
  {
    href: "/dashboard/settings/shipping",
    title: "Shipping",
    description: "Shipping zones and rates for checkout.",
  },
  {
    href: "/dashboard/settings/email",
    title: "Email",
    description:
      "Sending domains, deliverability, and suppressed addresses for customer email.",
  },
  {
    href: "/dashboard/settings/domains",
    title: "Domains",
    description: "Custom domain setup for your storefronts.",
  },
] as const;

export default function SettingsIndexPage() {
  return (
    <SettingsShell
      title="Settings"
      description="Account, billing, and store configuration."
    >
      <ul className="grid gap-3 sm:grid-cols-2">
        {sections.map((section) => (
          <li key={section.href}>
            <Link
              href={section.href}
              className="block rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)] transition-colors hover:border-brand/40"
            >
              <p className="font-medium text-foreground">{section.title}</p>
              <p className="mt-1 text-sm leading-6 text-muted">{section.description}</p>
            </Link>
          </li>
        ))}
      </ul>
    </SettingsShell>
  );
}
