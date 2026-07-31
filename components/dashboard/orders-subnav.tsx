"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const orderLinks = [
  { href: "/dashboard/orders", label: "Orders" },
  { href: "/dashboard/orders/settlements", label: "Settlements" },
] as const;

export function OrdersSubnav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Orders sections"
      className="mb-6 flex flex-wrap gap-2 rounded-[var(--radius-card)] border border-border bg-surface p-2"
    >
      {orderLinks.map((link) => {
        const active =
          link.href === "/dashboard/orders"
            ? pathname === link.href
            : pathname === link.href || pathname.startsWith(`${link.href}/`);

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
