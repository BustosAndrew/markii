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

export function SiteCard({ site }: { site: Site }) {
  return (
    <Link
      href={`/dashboard/websites/${site.slug}`}
      className="flex flex-col rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)] transition-colors hover:bg-hover-soft"
    >
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
  );
}
