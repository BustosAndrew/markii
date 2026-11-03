import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { StatusDot } from "@/components/ui/status-dot";
import type { Site } from "@/lib/api/types";

const statusTone = {
  live: "live",
  draft: "draft",
  paused: "paused",
} as const;

const statusBadge = {
  live: "success",
  draft: "neutral",
  paused: "warning",
} as const;

export function SiteCard({
  site,
  href,
}: {
  site: Site;
  /** Override the card target — the brand agent sends merchants here to open a design. */
  href?: string;
}) {
  const detailHref = `/dashboard/websites/${site.slug}`;
  const designHref = `/dashboard/websites/${site.slug}/design`;
  const primaryHref = href ?? detailHref;
  const opensDesign = primaryHref === designHref;

  return (
    <article className="flex flex-col rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)] transition-colors hover:bg-hover-soft">
      <Link href={primaryHref} className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-foreground">
              {site.name}
            </h2>
            <p className="mt-1 truncate font-mono text-xs text-muted">
              {site.slug}.markii.app
            </p>
          </div>
          <Badge variant={statusBadge[site.status]}>{site.status}</Badge>
        </div>
        <div className="mt-6 flex flex-wrap gap-4 text-sm text-muted">
          <span>{site.productCount} products</span>
          <span>{site.categoryCount} categories</span>
        </div>
        <div className="mt-4">
          <StatusDot tone={statusTone[site.status]} label={site.status} />
        </div>
      </Link>
      {opensDesign ? (
        <p className="mt-4 text-sm text-muted">Opens the design editor</p>
      ) : (
        <Link
          href={designHref}
          className="mt-4 self-start text-sm font-medium text-foreground hover:text-brand"
        >
          Edit design
        </Link>
      )}
    </article>
  );
}
