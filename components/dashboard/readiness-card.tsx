import Link from "next/link";
import type { ReadinessReport } from "@/lib/api/readiness";
import { sanitizePublicCopy } from "@/lib/api/public-copy";
import { ComingSoon } from "@/components/ui/coming-soon";
import { cn } from "@/lib/utils";

export function ReadinessCard({
  report,
  planned = false,
  error,
}: {
  report: ReadinessReport | null;
  planned?: boolean;
  error?: string | null;
}) {
  if (planned) {
    return (
      <ComingSoon
        title="Readiness score isn’t available yet"
        description="Catalog health scoring will appear here when this store is ready to measure it."
        action={
          <Link
            href="/dashboard/health"
            className="text-sm font-medium text-brand hover:text-brand-hover"
          >
            Open health page
          </Link>
        }
      />
    );
  }

  if (error) {
    return (
      <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
        <h2 className="text-base font-medium text-foreground">Readiness</h2>
        <p className="mt-2 text-sm leading-6 text-muted">
          {sanitizePublicCopy(error) || "Readiness is unavailable right now."}
        </p>
      </section>
    );
  }

  if (!report) {
    return (
      <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
        <h2 className="text-base font-medium text-foreground">Readiness</h2>
        <p className="mt-2 text-sm leading-6 text-muted">
          Configuration required before readiness signals can be displayed.
        </p>
      </section>
    );
  }

  return (
    <Link
      href="/dashboard/health"
      className="block rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)] transition-colors hover:bg-hover-soft"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-medium text-foreground">Readiness</h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            Overview of product data, inventory, policies, checkout, and protocol coverage.
          </p>
        </div>
        <div className="text-right">
          <p className="text-3xl font-semibold tracking-tight text-foreground">
            {report.score}
          </p>
          <p className="text-sm capitalize text-muted">{report.grade.replace("_", " ")}</p>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {report.components.map((component) => (
          <div key={component.key}>
            <div className="mb-1 flex items-center justify-between gap-3 text-sm">
              <span className="text-foreground">{component.label}</span>
              <span className="text-muted">{component.score}</span>
            </div>
            <div className="h-2 rounded-full bg-hover">
              <div
                className={cn(
                  "h-2 rounded-full",
                  report.grade === "critical"
                    ? "bg-brand"
                    : report.grade === "needs_work"
                      ? "bg-warning-text"
                      : "bg-success-text",
                )}
                style={{ width: `${Math.max(0, Math.min(component.score, 100))}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </Link>
  );
}
