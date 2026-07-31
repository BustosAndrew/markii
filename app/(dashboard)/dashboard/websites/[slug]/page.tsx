import Link from "next/link";
import { getSite, getSiteSummary } from "@/lib/api/server";
import { loadOrError } from "@/lib/api/load";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Sparkline } from "@/components/ui/charts";
import { MoneyText } from "@/components/ui/money-text";
import { PageHeader } from "@/components/ui/page-header";
import { FetchError } from "@/components/dashboard/fetch-error";
import { SiteControls } from "@/components/dashboard/site-controls";

export default async function WebsiteDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const siteResult = await loadOrError(() =>
    getSite(slug),
  );

  if (siteResult.error || !siteResult.data) {
    return (
      <div>
        <PageHeader title="Website" description={`/${slug}`} />
        <FetchError
          title="Website not found"
          message={siteResult.error ?? "Not found"}
        />
      </div>
    );
  }

  const site = siteResult.data;
  const summaryResult = await loadOrError(() =>
    getSiteSummary(site.slug),
  );
  const summary = summaryResult.data;

  return (
    <div className="space-y-8">
      <PageHeader
        title={site.name}
        description={site.storefrontUrl || `${site.slug}.markii.app`}
        actions={
          <>
            <Badge
              variant={
                site.status === "live"
                  ? "success"
                  : site.status === "paused"
                    ? "warning"
                    : "neutral"
              }
            >
              {site.status}
            </Badge>
            {site.storefrontUrl ? (
              <ButtonLink
                href={site.storefrontUrl}
                variant="secondary"
                target="_blank"
                rel="noopener noreferrer"
              >
                View live
              </ButtonLink>
            ) : null}
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <SummaryCard
          label="Agent traffic"
          value={summary ? summary.traffic.total.toLocaleString() : "—"}
          detail={
            summary ? `${summary.traffic.last7d} in the last 7 days` : "Unavailable"
          }
          href={`/dashboard/analytics/${site.slug}`}
          trend={
            summary && summary.traffic.byDay.length > 1 ? (
              <Sparkline data={summary.traffic.byDay} />
            ) : null
          }
        />
        <SummaryCard
          label="Purchases"
          value={summary ? String(summary.purchases.count) : "—"}
          detail={
            summary
              ? `${summary.purchases.last7d} in the last 7 days`
              : "Unavailable"
          }
          href={`/dashboard/orders/settlements/${site.slug}`}
        />
        <SummaryCard
          label="Balance"
          value={
            summary ? (
              <MoneyText cents={summary.balance.totalCents} />
            ) : (
              "—"
            )
          }
          detail={
            summary ? (
              <>
                <MoneyText cents={summary.balance.x402Cents} currency="USDC" />{" "}
                x402
              </>
            ) : (
              "Unavailable"
            )
          }
          href={`/dashboard/orders/settlements/${site.slug}`}
        />
      </div>

      <SiteControls site={site} />
    </div>
  );
}

function SummaryCard({
  label,
  value,
  detail,
  href,
  trend,
}: {
  label: string;
  value: React.ReactNode;
  detail: React.ReactNode;
  href: string;
  trend?: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="flex flex-col rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)] transition-colors hover:border-brand/30 hover:bg-hover-soft"
    >
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-3 text-2xl font-semibold tracking-tight text-foreground">
        {value}
      </p>
      {trend ? <div className="mt-3">{trend}</div> : null}
      {/* pinned to the bottom so detail lines align across cards with and without a trend */}
      <p className="mt-auto pt-2 text-sm text-muted">{detail}</p>
    </Link>
  );
}
