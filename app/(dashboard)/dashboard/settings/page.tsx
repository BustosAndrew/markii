import Link from "next/link";
import { SettingsShell } from "@/components/dashboard/settings-shell";
import { loadOrError } from "@/lib/api/load";
import { canReadOrgAudit } from "@/lib/api/org";
import { getMe } from "@/lib/api/server";

const sections = [
  {
    href: "/dashboard/settings/team",
    title: "Team",
    description: "Staff, invites, roles, and API tokens.",
    audit: false,
  },
  {
    href: "/dashboard/settings/audit",
    title: "Audit",
    description: "Who changed what, including refused attempts. Owners and administrators only.",
    audit: true,
  },
  {
    href: "/dashboard/settings/subscription",
    title: "Subscription",
    description: "Plan, first-invoice payment, and the card on file.",
    audit: false,
  },
  {
    href: "/dashboard/settings/billing",
    title: "Billing",
    description: "Threshold meter, invoices, and fee assessments.",
    audit: false,
  },
  {
    href: "/dashboard/payments",
    title: "Payments",
    description: "Stripe and x402 rails — where storefront money is paid.",
    audit: false,
  },
  {
    href: "/dashboard/settings/tax",
    title: "Tax",
    description: "Tax rates and how prices include tax at checkout.",
    audit: false,
  },
  {
    href: "/dashboard/settings/shipping",
    title: "Shipping",
    description: "Shipping zones and rates for checkout.",
    audit: false,
  },
  {
    href: "/dashboard/settings/email",
    title: "Email",
    description:
      "Sending domains, deliverability, and suppressed addresses for customer email.",
    audit: false,
  },
  {
    href: "/dashboard/settings/domains",
    title: "Domains",
    description: "Custom domain setup for your storefronts.",
    audit: false,
  },
] as const;

export default async function SettingsIndexPage() {
  const me = await loadOrError(() => getMe());
  const showAudit = canReadOrgAudit(me.data?.role);

  return (
    <SettingsShell
      title="Settings"
      description="Account, billing, and store configuration."
    >
      <ul className="grid gap-3 sm:grid-cols-2">
        {sections
          .filter((section) => !section.audit || showAudit)
          .map((section) => (
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
