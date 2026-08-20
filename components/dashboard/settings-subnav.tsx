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
      className="-mx-1 mb-6 flex gap-1 overflow-x-auto border-b border-border px-1"
    >
      {settingsLinks.map((link) => {
        const active = linkIsActive(pathname, link.href);

        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "shrink-0 border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors",
              active
                ? "border-brand text-foreground"
                : "border-transparent text-muted hover:border-border hover:text-foreground",
            )}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
