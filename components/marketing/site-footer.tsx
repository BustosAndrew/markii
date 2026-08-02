import Link from "next/link";
import { Logo } from "@/components/logo";

const footerLinks = [
  { href: "/overview", label: "Overview" },
  { href: "/pricing", label: "Pricing" },
  { href: "/contact", label: "Contact" },
  { href: "/sign-in", label: "Sign in" },
  { href: "/dashboard", label: "Dashboard" },
] as const;

export function MarketingFooter() {
  return (
    <footer className="border-t border-border-nav">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-10 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-xs">
          <div className="flex items-center gap-2 text-foreground">
            <Logo size={24} />
            <span className="font-medium">markii</span>
          </div>
          <p className="mt-3 text-sm leading-6 text-muted">
            Commerce for humans and AI agents — with no Markii fee until you
            cross your plan threshold.
          </p>
          <a
            href="mailto:support@markii.shop"
            className="mt-3 inline-block text-sm text-foreground transition-colors hover:text-brand"
          >
            support@markii.shop
          </a>
        </div>

        <nav aria-label="Footer">
          <ul className="flex flex-wrap gap-x-6 gap-y-3 text-sm text-muted sm:justify-end">
            {footerLinks.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="transition-colors hover:text-foreground"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </footer>
  );
}
