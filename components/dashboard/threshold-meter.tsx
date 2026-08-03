import type { UsageResponse } from "@/lib/api/billing";
import { ComingSoon } from "@/components/ui/coming-soon";
import { formatMinor } from "@/lib/api/money";
import { cn } from "@/lib/utils";

function money(amount: number | null, currency: string) {
  if (amount === null) {
    return "Not yet measured";
  }

  return formatMinor(amount, currency);
}

export function ThresholdMeter({
  usage,
  planned = false,
  error,
}: {
  usage: UsageResponse | null;
  planned?: boolean;
  error?: string | null;
}) {
  if (planned) {
    return (
      <ComingSoon
        title="Threshold meter coming soon"
        description="Billing and metering are planned. This page keeps the structure honest until API §17 is live."
        apiSection="API §17 · Billing, plans, metering, threshold fees"
      />
    );
  }

  if (error) {
    return (
      <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
        <h2 className="text-base font-medium text-foreground">Threshold meter</h2>
        <p className="mt-2 text-sm leading-6 text-muted">{error}</p>
      </section>
    );
  }

  if (!usage) {
    return (
      <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
        <h2 className="text-base font-medium text-foreground">Threshold meter</h2>
        <p className="mt-2 text-sm leading-6 text-muted">
          Configuration required before metering can be displayed.
        </p>
      </section>
    );
  }

  const measured = usage.trailing12NetSalesMinor !== null;
  const ratio = measured
    ? Math.min(
        100,
        Math.max(
          0,
          (((usage.trailing12NetSalesMinor ?? 0) / Math.max(usage.thresholdMinor, 1)) * 100),
        ),
      )
    : 0;

  return (
    <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-medium text-foreground">Threshold meter</h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            Trailing-12-month net sales against your plan threshold, with projections labeled separately.
          </p>
        </div>
        {/*
          `state` is null before a first production sale. That is the absence of
          a measurement, not a measurement of zero — rendering it as a green
          "Below threshold" would tell a merchant their sales are under the
          threshold when nothing has been measured at all.
        */}
        <span
          className={cn(
            "rounded-full px-2.5 py-1 text-xs font-medium",
            usage.state === "above"
              ? "bg-error-bg text-error-text"
              : usage.state === "approaching"
                ? "bg-warning-bg text-warning-text"
                : usage.state === "below"
                  ? "bg-success-bg text-success-text"
                  : "bg-surface-elevated text-muted",
          )}
        >
          {usage.state === "above"
            ? "Above threshold"
            : usage.state === "approaching"
              ? "Approaching threshold"
              : usage.state === "below"
                ? "Below threshold"
                : "Not yet measured"}
        </span>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div>
          <div className="flex items-end justify-between gap-3 text-sm">
            <div>
              <p className="text-muted">Trailing 12-month net sales</p>
              <p className="mt-1 text-2xl font-semibold tracking-tight text-foreground">
                {money(usage.trailing12NetSalesMinor, usage.currency)}
              </p>
            </div>
            <div className="text-right">
              <p className="text-muted">Threshold</p>
              <p className="mt-1 font-medium text-foreground">
                {money(usage.thresholdMinor, usage.currency)}
              </p>
            </div>
          </div>

          <div className="mt-4 h-3 rounded-full bg-hover">
            <div
              className={cn(
                "h-3 rounded-full",
                usage.state === "above"
                  ? "bg-brand"
                  : usage.state === "approaching"
                    ? "bg-warning-text"
                    : "bg-chart-1",
              )}
              style={{ width: `${ratio}%` }}
            />
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Metric
              label="This period net sales"
              value={money(usage.periodNetSalesMinor, usage.currency)}
            />
            <Metric
              label="Fee accrued this period"
              value={money(usage.feeAccruedMinor, usage.currency)}
            />
            <Metric
              label="Billable this period"
              value={money(usage.billableThisPeriodMinor, usage.currency)}
            />
            <Metric
              label="Projected period fee"
              value={money(usage.projectedPeriodFeeMinor, usage.currency)}
              note={usage.projectedPeriodFeeMinor !== null ? "Projected, not owed" : undefined}
            />
          </div>
        </div>

        <div className="rounded-[var(--radius-control)] border border-border bg-surface-elevated p-4">
          <p className="text-sm font-medium text-foreground">Current period</p>
          <p className="mt-1 text-sm text-muted">
            {usage.period.start} to {usage.period.end}
          </p>
          {usage.processorFeesNote ? (
            <p className="mt-4 text-sm leading-6 text-muted">{usage.processorFeesNote}</p>
          ) : null}

          {/*
            Every figure above looks like a bill. Whether anything is actually
            being charged is stated on the same card, never inferred from the
            numbers being present.
          */}
          <p
            className={cn(
              "mt-4 rounded-[var(--radius-control)] px-3 py-2 text-sm leading-6",
              usage.billingStatus.charging
                ? "bg-surface text-muted"
                : "bg-warning-bg text-warning-text",
            )}
          >
            {usage.billingStatus.reason}
          </p>

          {/*
            No FX provider is wired, so cross-currency sales are excluded rather
            than converted at an invented rate. Saying how many are missing is
            what stops the total reading as complete.
          */}
          {usage.unconvertedRecordCount > 0 ? (
            <p className="mt-3 text-sm leading-6 text-muted">
              {usage.unconvertedRecordCount} sale
              {usage.unconvertedRecordCount === 1 ? " is" : "s are"} in another currency and could
              not be converted, so they are not counted above.
            </p>
          ) : null}
          {usage.upgradeSuggestion ? (
            <div className="mt-4 rounded-[var(--radius-control)] border border-brand/20 bg-error-bg/30 p-4">
              <p className="text-sm font-medium text-foreground">
                Upgrade suggestion: {usage.upgradeSuggestion.planId}
              </p>
              <p className="mt-1 text-sm leading-6 text-muted">
                The suggested plan changes monthly price by{" "}
                {money(usage.upgradeSuggestion.monthlyDeltaMinor, usage.currency)} and could save{" "}
                {money(
                  usage.upgradeSuggestion.projectedAnnualSavingMinor,
                  usage.currency,
                )}{" "}
                over a year.
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function Metric({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="rounded-[var(--radius-control)] border border-border bg-surface-elevated p-4">
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-1 text-base font-medium text-foreground">{value}</p>
      {note ? <p className="mt-1 text-xs text-muted">{note}</p> : null}
    </div>
  );
}
