"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { Logo } from "@/components/logo";
import { ButtonLink } from "@/components/ui/button";
import { getMe } from "@/lib/api/org";
import { ApiClientError } from "@/lib/api/types";
import { cn } from "@/lib/utils";

const navLinks = [
  { href: "/overview", label: "Overview" },
  { href: "/pricing", label: "Pricing" },
  { href: "/contact", label: "Contact" },
] as const;

/**
 * Whether the visitor already has a merchant session.
 *
 * Asked from the client on purpose. The session cookie is httpOnly (D30), so
 * the only way to answer is to ask the server — and doing that in the layout
 * would read `cookies()` and turn every marketing page dynamic, losing the
 * static prerender for what is mostly anonymous traffic. Signed-out is the
 * assumed answer until proven otherwise, so the common case never waits.
 */
function useSignedIn() {
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getMe()
      .then(() => {
        if (!cancelled) setSignedIn(true);
      })
      .catch((err) => {
        if (cancelled) return;
        /**
         * `403 MFA_REQUIRED` is a merchant who is signed in but has not cleared
         * the gate (D40) — still signed in, and `/dashboard` is still the right
         * destination, since the layout there routes them to `/mfa`. Only a
         * `401` means nobody is home.
         */
        setSignedIn(err instanceof ApiClientError && err.status === 403);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return signedIn;
}

export function MarketingHeader() {
  const pathname = usePathname();
  const signedIn = useSignedIn();

  return (
    <header className="sticky top-3 z-50 px-3 sm:top-5 sm:px-6">
      <nav className="mx-auto flex h-16 w-full max-w-5xl items-center gap-6 rounded-full border border-border bg-surface/90 pr-2 pl-4 shadow-[var(--shadow-md)] backdrop-blur-2xl backdrop-saturate-150 sm:h-[4.25rem] sm:pl-6">
        <Link href="/" className="flex shrink-0 items-center gap-2.5">
          <Logo size={36} />
          <span className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
            markii
          </span>
        </Link>

          <ul className="ml-auto hidden flex-1 items-center justify-center gap-6 text-sm text-muted sm:flex md:gap-8">
            {navLinks.map((link) => {
              const active =
                pathname === link.href || pathname.startsWith(`${link.href}/`);
              return (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className={cn(
                      "transition-colors hover:text-foreground",
                      active && "font-medium text-foreground",
                    )}
                  >
                    {link.label}
                  </Link>
                </li>
              );
            })}
          </ul>

          <ButtonLink
            href={signedIn ? "/dashboard" : "/sign-up"}
            className="ml-auto shrink-0 gap-1.5 rounded-full px-4 py-2.5 sm:ml-0 sm:px-5"
          >
            {signedIn ? "Dashboard" : "Start selling"}
            <ArrowRight className="size-4" />
          </ButtonLink>
      </nav>
    </header>
  );
}
