"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * Tabs for one store: overview, design, blog, forms, redirects. Design is the
 * editor; the rest are ordinary dashboard pages on this website.
 */
export function WebsiteNav({ slug }: { slug: string }) {
  const pathname = usePathname();
  const base = `/dashboard/websites/${slug}`;
  const items = [
    { href: base, label: "Overview", match: "exact" as const },
    { href: `${base}/design`, label: "Design", match: "prefix" as const },
    { href: `${base}/blog`, label: "Blog", match: "prefix" as const },
    { href: `${base}/forms`, label: "Forms", match: "prefix" as const },
    { href: `${base}/redirects`, label: "Redirects", match: "prefix" as const },
  ];

  return (
    <nav aria-label="This website" className="mb-6 flex flex-wrap gap-1 border-b border-border">
      {items.map((item) => {
        const active = item.match === "exact" ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium",
              active ? "border-brand text-foreground" : "border-transparent text-muted hover:text-foreground",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
