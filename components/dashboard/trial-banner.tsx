import Link from "next/link";
import type { AccountStanding } from "@/lib/api/billing";

/**
 * The free month, made visible before it bites.
 *
 * A merchant should never discover the trial by finding their storefront dark,
 * which is the single worst outcome this feature can produce. The reminder email
 * is one warning; this is the other, and it is the more reliable of the two —
 * the cron can be unscheduled or its send can bounce, but this renders on every
 * dashboard page load from state derived on the request.
 *
 * **Nothing is shown while subscribed or ungated.** A permanent band of chrome
 * telling a paying merchant they are paying is noise, and noise is what makes
 * people stop reading the banner that matters.
 */
export function TrialBanner({ standing }: { standing: AccountStanding }) {
  if (standing.state === "subscribed" || standing.state === "ungated") return null;

  if (standing.state === "expired") {
    return (
      <div
        role="status"
        className="mb-4 rounded-[var(--radius-card)] border border-error-border bg-error-bg px-4 py-3 text-sm leading-6 text-error-text"
      >
        <strong className="font-semibold">Your storefronts are offline.</strong> The free
        month ended on {new Date(standing.endedAt).toLocaleDateString()}, so your stores
        have stopped serving and cannot take orders. Your products, orders and customers
        are untouched.{" "}
        <Link href="/dashboard/settings/subscription" className="underline underline-offset-2">
          Choose a plan
        </Link>{" "}
        to bring everything back online.
      </div>
    );
  }

  /**
   * Escalates only in the last few days. A month-long banner at full volume is
   * ignored by week two; this stays quiet until it is actually close, which is
   * also when the reminder email goes out.
   */
  const urgent = standing.daysLeft <= 3;

  return (
    <div
      role="status"
      className={`mb-4 rounded-[var(--radius-card)] border px-4 py-3 text-sm leading-6 ${
        urgent
          ? "border-warning-border bg-warning-bg text-warning-text"
          : "border-border bg-surface-elevated text-muted"
      }`}
    >
      <strong className="font-semibold">
        {standing.daysLeft === 0
          ? "Your free month ends today."
          : standing.daysLeft === 1
            ? "Your free month ends tomorrow."
            : `Your free month ends in ${standing.daysLeft} days.`}
      </strong>{" "}
      {/* Stated plainly: the consequence is a stop, not a downgrade. */}
      When it ends your storefronts stop serving and stop accepting orders until you
      subscribe.{" "}
      <Link href="/dashboard/settings/subscription" className="underline underline-offset-2">
        Choose a plan
      </Link>
      .
    </div>
  );
}
