import { cn } from "@/lib/utils";

/**
 * Every chart here plots a single measure, so all marks share one hue — bar length
 * already encodes magnitude, and a second colour channel would only restate it.
 */
const MARK = "bg-brand";

function compact(n: number) {
  return n >= 10000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : n.toLocaleString();
}

/** Ranked magnitude by category — horizontal bars, value at the tip. */
export function BarChart({
  data,
  className,
  valueKey = "count",
  labelKey = "label",
  emptyLabel = "No data in range.",
}: {
  data: Record<string, string | number>[];
  className?: string;
  valueKey?: string;
  labelKey?: string;
  emptyLabel?: string;
}) {
  if (data.length === 0) {
    return <p className={cn("text-sm text-muted", className)}>{emptyLabel}</p>;
  }
  const max = Math.max(1, ...data.map((d) => Number(d[valueKey]) || 0));
  const total = data.reduce((sum, d) => sum + (Number(d[valueKey]) || 0), 0);

  return (
    <div className={cn("space-y-2.5", className)}>
      {data.map((row, i) => {
        const value = Number(row[valueKey]) || 0;
        const label = String(row[labelKey] ?? "");
        const share = total > 0 ? Math.round((value / total) * 100) : 0;
        return (
          <div
            key={`${label}-${i}`}
            className="grid grid-cols-[7rem_1fr_4.5rem] items-center gap-3 text-sm"
            title={`${label}: ${value.toLocaleString()} (${share}%)`}
          >
            <span className="truncate text-foreground" title={label}>
              {label}
            </span>
            <div className="h-2 rounded-full bg-hover">
              <div
                className={cn("h-full rounded-r-[4px] rounded-l-full", MARK)}
                style={{ width: `${Math.max(2, (value / max) * 100)}%` }}
              />
            </div>
            <span className="text-right tabular-nums text-foreground">
              {value.toLocaleString()}
              <span className="ml-1.5 text-xs text-muted">{share}%</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Traffic over time. The plot band and the date axis are separate rows so the
 * axis labels can never be clipped by the plot's fixed height.
 */
export function DaySparkBars({
  data,
  className,
  height = "h-40",
}: {
  data: { date: string; count: number }[];
  className?: string;
  height?: string;
}) {
  if (data.length === 0) {
    return <p className={cn("text-sm text-muted", className)}>No traffic in range.</p>;
  }
  const max = Math.max(1, ...data.map((d) => d.count));
  const peakIndex = data.reduce((best, d, i) => (d.count > data[best].count ? i : best), 0);
  const fmt = (iso: string) => iso.slice(5).replace("-", "/");
  const last = data.length - 1;
  // label the ends, plus the peak when it is far enough from both to not collide
  const showTick = (i: number) =>
    i === 0 || i === last || (i === peakIndex && i > 1 && i < last - 1);

  return (
    <figure className={cn("space-y-0", className)}>
      <div className="mb-1 flex items-baseline justify-between text-xs text-muted">
        <span className="tabular-nums">peak {max.toLocaleString()}</span>
        <span>
          {fmt(data[0].date)} – {fmt(data[data.length - 1].date)}
        </span>
      </div>

      {/* plot band: definite height, so each bar's % height resolves against it */}
      <div
        className={cn("flex items-end gap-[2px] border-b border-border", height)}
        role="img"
        aria-label={`Agent traffic by day, peak ${max} hits`}
      >
        {data.map((d, i) => (
          <div
            key={d.date}
            className="group relative flex h-full flex-1 items-end justify-center"
            title={`${d.date}: ${d.count.toLocaleString()} hits`}
          >
            <div
              className={cn(
                "w-full max-w-6 rounded-t-[4px] transition-opacity",
                i === peakIndex ? MARK : cn(MARK, "opacity-70 group-hover:opacity-100"),
              )}
              style={{ height: `${Math.max(2, (d.count / max) * 100)}%` }}
            />
            <span className="pointer-events-none absolute -top-6 z-10 hidden whitespace-nowrap rounded-[var(--radius-control)] border border-border bg-surface px-2 py-1 text-xs tabular-nums text-foreground shadow-[var(--shadow-md)] group-hover:block">
              {d.count.toLocaleString()}
            </span>
          </div>
        ))}
      </div>

      {/* axis band, outside the plot's fixed height */}
      <div className="mt-1.5 flex gap-[2px] text-[10px] tabular-nums text-muted">
        {data.map((d, i) => (
          <span key={d.date} className="min-w-0 flex-1 text-center">
            {showTick(i) ? fmt(d.date) : "\u00a0"}
          </span>
        ))}
      </div>
    </figure>
  );
}

/** Compact inline trend for stat tiles — no axis, no labels. */
export function Sparkline({
  data,
  className,
}: {
  data: { date: string; count: number }[];
  className?: string;
}) {
  if (data.length < 2) return null;
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div
      className={cn("flex h-8 items-end gap-px", className)}
      role="img"
      aria-label={`Trend, peak ${max}`}
    >
      {data.map((d) => (
        <div
          key={d.date}
          className={cn("min-w-0 flex-1 rounded-t-[2px]", MARK)}
          style={{
            height: `${Math.max(6, (d.count / max) * 100)}%`,
            opacity: 0.25 + 0.75 * (d.count / max),
          }}
        />
      ))}
    </div>
  );
}

export { compact };
