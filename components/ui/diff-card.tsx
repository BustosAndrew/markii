import { cn } from "@/lib/utils";

export function DiffCard({
  title,
  description,
  beforeLabel = "Before",
  afterLabel = "After",
  before,
  after,
  className,
}: {
  title: string;
  description?: string;
  beforeLabel?: string;
  afterLabel?: string;
  before: React.ReactNode;
  after: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]",
        className,
      )}
    >
      <div className="mb-4">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        {description ? (
          <p className="mt-1 text-sm leading-6 text-muted">{description}</p>
        ) : null}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-[var(--radius-control)] border border-border bg-surface-elevated p-4">
          <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted">
            {beforeLabel}
          </p>
          <div className="mt-3 text-sm leading-6 text-muted">{before}</div>
        </div>
        <div className="rounded-[var(--radius-control)] border border-brand/20 bg-error-bg/30 p-4">
          <p className="text-xs font-medium uppercase tracking-[0.12em] text-brand">
            {afterLabel}
          </p>
          <div className="mt-3 text-sm leading-6 text-foreground">{after}</div>
        </div>
      </div>
    </section>
  );
}
