import { cn } from "@/lib/utils";

const seriesColors = [
  "bg-brand",
  "bg-brand-light",
  "bg-brand-pressed",
  "bg-[var(--color-chart-neutral,#d1d5db)]",
] as const;

export function BarChart({
  data,
  className,
  valueKey = "count",
  labelKey = "label",
}: {
  data: Record<string, string | number>[];
  className?: string;
  valueKey?: string;
  labelKey?: string;
}) {
  const max = Math.max(1, ...data.map((d) => Number(d[valueKey]) || 0));

  if (data.length === 0) {
    return (
      <p className={cn("text-sm text-muted", className)}>No data in range.</p>
    );
  }

  return (
    <div className={cn("space-y-3", className)}>
      {data.map((row, i) => {
        const value = Number(row[valueKey]) || 0;
        const label = String(row[labelKey] ?? "");
        const pct = Math.round((value / max) * 100);
        return (
          <div key={`${label}-${i}`} className="grid grid-cols-[7rem_1fr_3rem] items-center gap-3 text-sm">
            <span className="truncate text-muted" title={label}>
              {label}
            </span>
            <div className="h-2.5 overflow-hidden rounded-full bg-hover">
              <div
                className={cn("h-full rounded-full", seriesColors[i % seriesColors.length])}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-right tabular-nums text-foreground">{value}</span>
          </div>
        );
      })}
    </div>
  );
}

export function DaySparkBars({
  data,
  className,
}: {
  data: { date: string; count: number }[];
  className?: string;
}) {
  const max = Math.max(1, ...data.map((d) => d.count));
  if (data.length === 0) {
    return (
      <p className={cn("text-sm text-muted", className)}>No traffic in range.</p>
    );
  }

  return (
    <div className={cn("flex h-40 items-end gap-1", className)} role="img" aria-label="Traffic by day">
      {data.map((d) => {
        const h = Math.max(4, Math.round((d.count / max) * 100));
        return (
          <div key={d.date} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1">
            <div
              className="w-full max-w-4 rounded-t bg-brand"
              style={{ height: `${h}%` }}
              title={`${d.date}: ${d.count}`}
            />
            <span className="hidden text-[10px] text-muted sm:block">
              {d.date.slice(5)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
