"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

export function Pagination({
  page,
  limit,
  total,
  className,
}: {
  page: number;
  limit: number;
  total: number;
  className?: string;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const totalPages = Math.max(1, Math.ceil(total / limit));
  if (totalPages <= 1) return null;

  function hrefFor(p: number) {
    const next = new URLSearchParams(searchParams.toString());
    next.set("page", String(p));
    return `${pathname}?${next.toString()}`;
  }

  return (
    <div
      className={cn(
        "mt-6 flex items-center justify-between gap-4 text-sm text-muted",
        className,
      )}
    >
      <p>
        Page {page} of {totalPages} · {total} total
      </p>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link
            href={hrefFor(page - 1)}
            className="cursor-pointer rounded-[var(--radius-control)] border border-border bg-surface px-3 py-1.5 text-foreground hover:bg-hover"
          >
            Previous
          </Link>
        ) : null}
        {page < totalPages ? (
          <Link
            href={hrefFor(page + 1)}
            className="cursor-pointer rounded-[var(--radius-control)] border border-border bg-surface px-3 py-1.5 text-foreground hover:bg-hover"
          >
            Next
          </Link>
        ) : null}
      </div>
    </div>
  );
}
