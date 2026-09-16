"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, Building2, LayoutGrid, UserPlus } from "lucide-react";
import { SidebarBrand, SidebarOrgCard } from "@/components/dashboard/sidebar";
import type { MeResponse } from "@/lib/api/org";
import { cn } from "@/lib/utils";

/**
 * The operator shell (G12) — a deliberately separate rail from the merchant
 * dashboard's, so nothing here can be mistaken for a merchant feature and no
 * merchant nav ever links into it. Three sections and a way back.
 */
const nav = [
  { href: "/admin", label: "Overview", icon: LayoutGrid },
  { href: "/admin/orgs", label: "Organizations", icon: Building2 },
  { href: "/admin/signups", label: "Sign-ups", icon: UserPlus },
];

function isActive(pathname: string, href: string) {
  if (href === "/admin") return pathname === "/admin";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AdminNav({ className }: { className?: string }) {
  const pathname = usePathname();
  return (
    <nav className={cn("flex flex-col gap-0.5", className)} aria-label="Platform admin">
      {nav.map((item) => {
        const active = isActive(pathname, item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative flex cursor-pointer items-center gap-2.5 rounded-[var(--radius-control)] px-3 py-2 text-sm transition-colors",
              active
                ? "bg-hover font-medium text-foreground"
                : "text-muted hover:bg-hover-soft hover:text-foreground",
            )}
          >
            {active ? (
              <span className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-brand" aria-hidden />
            ) : null}
            <Icon className="size-4 shrink-0" />
            {item.label}
          </Link>
        );
      })}
      <Link
        href="/dashboard"
        className="mt-3 flex items-center gap-2.5 rounded-[var(--radius-control)] px-3 py-2 text-sm text-muted hover:bg-hover-soft hover:text-foreground"
      >
        <ArrowLeft className="size-4 shrink-0" />
        Back to dashboard
      </Link>
    </nav>
  );
}

export function AdminShell({ me, children }: { me: MeResponse | null; children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground lg:flex-row">
      <aside className="flex shrink-0 flex-col border-b border-border bg-surface lg:sticky lg:top-0 lg:h-dvh lg:w-56 lg:border-r lg:border-b-0">
        <div className="flex h-16 items-center gap-2.5 border-b border-border-nav px-4">
          <SidebarBrand />
          <span className="rounded-full bg-brand px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-on-brand">
            Admin
          </span>
        </div>
        <AdminNav className="p-3 lg:flex-1 lg:overflow-y-auto" />
        <div className="hidden border-t border-border p-3 lg:block">
          <SidebarOrgCard me={me} />
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-6 sm:py-8">
        {children}
      </main>
    </div>
  );
}
