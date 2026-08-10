"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import {
  BarChart3,
  CreditCard,
  Globe,
  KeyRound,
  LayoutList,
  LayoutGrid,
  LogOut,
  Percent,
  Plug,
  Settings,
  ShieldCheck,
  ShoppingBag,
  Users,
} from "lucide-react";
import { Logo } from "@/components/logo";
import { signOut } from "@/lib/api/auth";
import { switchOrg, type MeResponse } from "@/lib/api/org";
import { publicErrorMessage } from "@/lib/api/public-copy";
import { ApiClientError } from "@/lib/api/types";
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
  { href: "/dashboard/payments", label: "Payments", icon: CreditCard },
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

/**
 * Active organization, with a switcher when the user belongs to more than one.
 *
 * Agencies build stores for clients, so one person legitimately belongs to
 * several orgs. **Switching only rewrites a preference cookie** — it grants
 * nothing by itself, because every request re-resolves membership server-side.
 * That is also why the cookie is not `httpOnly`: it is a preference, not a
 * credential.
 *
 * `router.refresh()` after a switch is not cosmetic — every screen above is
 * scoped to the active org, so leaving them rendered would show one org's
 * catalog under another's name.
 */
export function SidebarOrgCard({ me }: { me: MeResponse | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!me) {
    return (
      <div className="rounded-[var(--radius-card)] border border-dashed border-border bg-surface-elevated p-3">
        <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted">
          Organization
        </p>
        <p className="mt-2 text-sm leading-6 text-muted">Not signed in.</p>
        <Link
          href="/sign-in"
          className="mt-3 inline-flex text-sm font-medium text-brand hover:text-brand-hover"
        >
          Sign in
        </Link>
      </div>
    );
  }

  const others = me.organizations.filter((o) => !o.active);
  const accountLabel = me.user.email ?? me.user.name ?? "Signed in";

  return (
    <div className="rounded-[var(--radius-card)] border border-border bg-surface-elevated p-3">
      <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted">
        Organization
      </p>
      <p className="mt-2 truncate text-sm font-medium text-foreground" title={me.org.name}>
        {me.org.name}
      </p>
      <p className="mt-0.5 text-xs capitalize text-muted">{me.role.replace(/_/g, " ")}</p>
      <p className="mt-1 truncate text-xs text-muted" title={accountLabel}>
        {accountLabel}
      </p>

      {others.length > 0 ? (
        <select
          aria-label="Switch organization"
          className="mt-2 w-full cursor-pointer rounded-[var(--radius-control)] border border-border bg-surface px-2 py-1.5 text-sm text-foreground disabled:cursor-not-allowed"
          value={me.org.id}
          disabled={busy || signingOut}
          onChange={async (e) => {
            const orgId = e.target.value;
            if (orgId === me.org.id) return;
            setBusy(true);
            setError(null);
            try {
              await switchOrg({ orgId });
              router.refresh();
            } catch (err) {
              setError(err instanceof ApiClientError ? err.message : "Could not switch.");
            } finally {
              setBusy(false);
            }
          }}
        >
          {me.organizations.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      ) : null}

      <button
        type="button"
        disabled={signingOut || busy}
        onClick={async () => {
          setSigningOut(true);
          setError(null);
          try {
            await signOut();
            // Full navigation clears any client cache tied to the old session.
            window.location.href = "/sign-in";
          } catch (err) {
            setError(publicErrorMessage(err, "Could not sign out."));
            setSigningOut(false);
          }
        }}
        className="mt-3 flex w-full cursor-pointer items-center justify-center gap-2 rounded-[var(--radius-control)] border border-border bg-surface px-2 py-2 text-sm font-medium text-foreground transition-colors hover:bg-hover-soft disabled:cursor-not-allowed disabled:opacity-60 max-lg:min-h-11"
      >
        <LogOut className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
        {signingOut ? "Signing out…" : "Sign out"}
      </button>

      {error ? <p className="mt-2 text-xs text-error-text">{error}</p> : null}
    </div>
  );
}

/** Desktop rail. Hidden below `lg` — the mobile shell renders `MobileNav` instead. */
export function DashboardSidebar({ me }: { me: MeResponse | null }) {
  return (
    <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col border-r border-border bg-surface lg:flex">
      <div className="flex h-16 items-center gap-2.5 border-b border-border-nav px-4">
        <SidebarBrand />
      </div>
      <SidebarNav className="flex-1 overflow-y-auto p-3" />
      <div className="border-t border-border p-3">
        <SidebarOrgCard me={me} />
      </div>
    </aside>
  );
}
