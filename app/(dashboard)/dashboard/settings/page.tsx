import Link from "next/link";
import { SettingsShell } from "@/components/dashboard/settings-shell";

const sections = [
  {
    href: "/dashboard/settings/team",
    title: "Team",
    description: "Staff, invites, and org structure for the upcoming multi-org launch.",
  },
  {
    href: "/dashboard/settings/billing",
    title: "Billing",
    description: "Plan structure, threshold metering, and invoice history.",
  },
  {
    href: "/dashboard/settings/tax",
    title: "Tax",
    description: "Tax provider configuration and nexus settings when commerce core lands.",
  },
  {
    href: "/dashboard/settings/shipping",
    title: "Shipping",
    description: "Shipping zones and rates for human checkout after Phase C.",
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
    description: "Custom domain setup lives here once org-scoped settings are expanded.",
  },
] as const;

export default function SettingsIndexPage() {
  return (
    <SettingsShell
      title="Settings"
      description="Launch settings structure for team, billing, tax, shipping, email, and domains."
    >
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {sections.map((section) => (
          <Link
            key={section.href}
            href={section.href}
            className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)] transition-colors hover:bg-hover-soft"
          >
            <h2 className="text-base font-medium text-foreground">{section.title}</h2>
            <p className="mt-2 text-sm leading-6 text-muted">{section.description}</p>
          </Link>
        ))}
      </div>
    </SettingsShell>
  );
}
