"use client";

/**
 * Dates from the API arrive as UTC ISO strings. Format them in the viewer's
 * own timezone (browser default) — California sees PDT/PST, New York EST/EDT,
 * etc. — rather than printing `…Z` or assuming the server's zone.
 *
 * Note: `dateStyle` / `timeStyle` cannot be combined with `timeZoneName` in
 * Intl — that throws "Invalid option". Use discrete field options instead.
 */

function asDate(value: string | Date): Date | null {
  const d = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(d.getTime()) ? null : d;
}

const dateTimeOpts: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
};

const dateOpts: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZoneName: "short",
};

export function LocalDateTime({
  value,
  fallback = "—",
}: {
  value: string | Date | null | undefined;
  fallback?: string;
}) {
  if (value == null) return <>{fallback}</>;
  const d = asDate(value);
  if (!d) return <>{fallback}</>;
  return <>{d.toLocaleString(undefined, dateTimeOpts)}</>;
}

export function LocalDate({
  value,
  fallback = "—",
}: {
  value: string | Date | null | undefined;
  fallback?: string;
}) {
  if (value == null) return <>{fallback}</>;
  const d = asDate(value);
  if (!d) return <>{fallback}</>;
  return <>{d.toLocaleString(undefined, dateOpts)}</>;
}

/** Inclusive-looking range in the viewer's local timezone. */
export function LocalDateRange({
  start,
  end,
  withTime = false,
}: {
  start: string | Date;
  end: string | Date;
  /** Include clock time when the bounds are not just calendar midnights. */
  withTime?: boolean;
}) {
  const a = asDate(start);
  const b = asDate(end);
  if (!a || !b) {
    return (
      <>
        {String(start)} to {String(end)}
      </>
    );
  }

  const opts = withTime ? dateTimeOpts : dateOpts;
  return (
    <>
      {a.toLocaleString(undefined, opts)}
      {" – "}
      {b.toLocaleString(undefined, opts)}
    </>
  );
}
