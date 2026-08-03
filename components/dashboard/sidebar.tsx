"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  Globe,
  KeyRound,
  LayoutList,
  LayoutGrid,
  Percent,
  Plug,
  Settings,
  ShieldCheck,
  ShoppingBag,
  Users,
} from "lucide-react";
import { Logo } from "@/components/logo";
import { cn } from "@/lib/utils";

export const nav = [
  { href: "/dashboard", label: "Overview", icon: LayoutGrid },
  { href: "/dashboard/catalog", label: "Catalog", icon: ShoppingBag },
  { href: "/dashboard/orders", label: "Orders", icon: LayoutList },
  { href: "/dashboard/customers", label: "Customers", icon: Users },
  { href: "/dashboard/discounts", label: "Discounts", icon: Percent },
  { href: "/dashboard/memberships", label: "Memberships", icon: KeyRound },
  { href: "/dashboard/websites", label: "Websites", icon: Globe },
  { href: "/dashboard/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
  { href: "/dashboard/health", label: "Health", icon: ShieldCheck },
  { href: "/dashboard/integrations", label: "Integrations", icon: Plug },
] as const;

export function isActive(pathname: string, href: string) {
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Returns the nav label for the current route — used as the mobile bar title. */
export function useCurrentSection() {
  const pathname = usePathname();
  const match = [...nav]
    .sort((a, b) => b.href.length - a.href.length)
    .find((item) => isActive(pathname, item.href));
  return match?.label ?? "Dashboard";
}

export function SidebarBrand({ className }: { className?: string }) {
  return (
    <Link href="/" className={cn("flex items-center gap-2.5", className)}>
      <Logo size={30} />
      <span className="text-base font-semibold tracking-tight text-foreground">
        markii
      </span>
    </Link>
  );
}

/**
 * The nav list itself. Shared by the desktop rail and the mobile drawer so a new
 * route only ever has to be added to `nav` above.
 */
export function SidebarNav({
  onNavigate,
  className,
}: {
  onNavigate?: () => void;
  className?: string;
}) {
  const pathname = usePathname();

  return (
    <nav
      className={cn("flex flex-col gap-0.5", className)}
      aria-label="Dashboard"
    >
      {nav.map((item) => {
        const active = isActive(pathname, item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            onClick={onNavigate}
            className={cn(
              "relative flex cursor-pointer items-center gap-2.5 rounded-[var(--radius-control)] px-3 py-2 text-sm transition-colors",
              // Touch targets stay at the 44px minimum on coarse pointers.
              "max-lg:min-h-11 max-lg:py-2.5 max-lg:text-[0.9375rem]",
              active
                ? "bg-hover font-medium text-foreground hover:bg-hover"
                : "text-muted hover:bg-hover-soft hover:text-foreground",
            )}
          >
            {active ? (
              <span
                className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-brand"
                aria-hidden
              />
            ) : null}
            <Icon className="size-4 shrink-0" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function SidebarOrgCard() {
  return (
    <div className="rounded-[var(--radius-card)] border border-dashed border-border bg-surface-elevated p-3">
      <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted">
        Organization
      </p>
      <p className="mt-2 text-sm font-medium text-foreground">Single workspace</p>
      <p className="mt-1 text-sm leading-6 text-muted">
        Org switching is coming soon with Phase A auth.
      </p>
    </div>
  );
}

/** Desktop rail. Hidden below `lg` — the mobile shell renders `MobileNav` instead. */
export function DashboardSidebar() {
  return (
    <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col border-r border-border bg-surface lg:flex">
      <div className="flex h-16 items-center gap-2.5 border-b border-border-nav px-4">
        <SidebarBrand />
      </div>
      <SidebarNav className="flex-1 overflow-y-auto p-3" />
      <div className="border-t border-border p-3">
        <SidebarOrgCard />
      </div>
    </aside>
  );
}
