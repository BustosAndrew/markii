import Link from "next/link";
import { getOverview } from "@/lib/api/overview";
import { ApiClientError } from "@/lib/api/types";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { MoneyText } from "@/components/ui/money-text";
import { PageHeader } from "@/components/ui/page-header";
import { OverviewError } from "./overview-error";

export default async function DashboardOverviewPage() {
  let data: Awaited<ReturnType<typeof getOverview>> | null = null;
  let errorMessage: string | null = null;

  try {
    data = await getOverview({ cache: "no-store" });
  } catch (err) {
    if (err instanceof ApiClientError) {
      errorMessage = err.message;
    } else if (err instanceof Error) {
      errorMessage = err.message;
    } else {
      errorMessage = "Could not reach the overview API.";
    }
  }

  return (
    <div>
      <PageHeader
        title="Overview"
        description="Sites, agent traffic, and balances across your Markii stores."
        actions={
          <ButtonLink href="/dashboard/websites/new">New website</ButtonLink>
        }
      />

      {errorMessage ? <OverviewError message={errorMessage} /> : null}

      {!errorMessage && data && data.sites.total === 0 ? (
        <EmptyState
          title="No websites yet"
          description="Create a site to import a catalog and deploy an agent-readable storefront."
          action={
            <ButtonLink href="/dashboard/websites/new">
              Create website
            </ButtonLink>
          }
        />
      ) : null}

      {!errorMessage && data && data.sites.total > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="Sites"
            value={String(data.sites.total)}
            detail={`${data.sites.live} live · ${data.sites.draft} draft · ${data.sites.paused} paused`}
            href="/dashboard/websites"
          />
          <MetricCard
            label="Agent traffic"
            value={String(data.traffic.total)}
            detail={`${data.traffic.last7d} in the last 7 days`}
            href="/dashboard/analytics"
          />
          <MetricCard
            label="Total balance"
            value={<MoneyText cents={data.finances.totalBalanceCents} />}
            detail={
              <>
                <MoneyText cents={data.finances.x402BalanceCents} currency="USDC" />{" "}
                x402 ·{" "}
                <MoneyText cents={data.finances.fiatBalanceCents} /> fiat
              </>
            }
            href="/dashboard/finances"
          />
          <CreateSiteCard />
        </div>
      ) : null}
    </div>
  );
}

function MetricCard({
  label,
  value,
  detail,
  href,
}: {
  label: string;
  value: React.ReactNode;
  detail: React.ReactNode;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)] transition-colors hover:bg-hover-soft"
    >
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-3 text-3xl font-semibold tracking-tight text-foreground">
        {value}
      </p>
      <p className="mt-2 text-sm text-muted">{detail}</p>
    </Link>
  );
}

function CreateSiteCard() {
  return (
    <Link
      href="/dashboard/websites/new"
      className="flex flex-col justify-between rounded-[var(--radius-card)] border border-dashed border-border bg-surface-elevated p-5 transition-colors hover:border-brand/40 hover:bg-hover-soft"
    >
      <p className="text-sm text-muted">Get started</p>
      <div>
        <p className="text-lg font-semibold tracking-tight text-foreground">
          Create a website
        </p>
        <p className="mt-1 text-sm text-muted">
          Import a catalog and deploy for agents.
        </p>
      </div>
    </Link>
  );
}
