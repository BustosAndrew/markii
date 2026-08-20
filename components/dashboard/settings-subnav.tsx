"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const settingsLinks = [
  { href: "/dashboard/settings/team", label: "Team" },
  { href: "/dashboard/settings/subscription", label: "Subscription" },
  { href: "/dashboard/settings/billing", label: "Billing" },
  { href: "/dashboard/settings/tax", label: "Tax" },
  { href: "/dashboard/settings/shipping", label: "Shipping" },
  { href: "/dashboard/settings/email", label: "Email" },
  { href: "/dashboard/settings/domains", label: "Domains" },
] as const;

function linkIsActive(pathname: string, href: string) {
  if (href === "/dashboard/settings/billing") {
    return pathname === href || pathname.startsWith(`${href}/`);
  }
  return pathname === href;
}

export function SettingsSubnav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Settings sections"
      className="mb-6 flex flex-wrap gap-2 rounded-[var(--radius-card)] border border-border bg-surface p-2"
    >
      {settingsLinks.map((link) => {
        const active = linkIsActive(pathname, link.href);

        return (
          <Link
            key={link.href}
            href={link.href}
            className={cn(
              "cursor-pointer rounded-[var(--radius-control)] px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-hover text-foreground hover:bg-hover"
                : "text-muted hover:bg-hover-soft hover:text-foreground",
            )}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
