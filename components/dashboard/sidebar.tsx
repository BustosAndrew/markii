"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  Boxes,
  FolderTree,
  Globe,
  LayoutGrid,
  Plug,
  Wallet,
} from "lucide-react";
import { Logo } from "@/components/logo";
import { cn } from "@/lib/utils";

const nav = [
  { href: "/dashboard", label: "Overview", icon: LayoutGrid },
  { href: "/dashboard/inventory", label: "Inventory", icon: Boxes },
  { href: "/dashboard/categories", label: "Categories", icon: FolderTree },
  { href: "/dashboard/websites", label: "Websites", icon: Globe },
  { href: "/dashboard/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/dashboard/finances", label: "Finances", icon: Wallet },
  { href: "/dashboard/integrations", label: "Integrations", icon: Plug },
] as const;

function isActive(pathname: string, href: string) {
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function DashboardSidebar() {
  const pathname = usePathname();

  return (
    <aside className="sticky top-0 flex h-screen w-56 shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex h-16 items-center gap-2.5 border-b border-border-nav px-4">
        <Link href="/" className="flex items-center gap-2.5">
          <Logo size={30} />
          <span className="text-base font-semibold tracking-tight text-foreground">
            markii
          </span>
        </Link>
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-3" aria-label="Dashboard">
        {nav.map((item) => {
          const active = isActive(pathname, item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "relative flex items-center gap-2.5 rounded-[var(--radius-control)] px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-hover font-medium text-foreground"
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
    </aside>
  );
}
