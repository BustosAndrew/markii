import Link from "next/link";
import type { OrgDomainRow, OrgDomains } from "@/lib/api/domains";
import { isPlannedError } from "@/lib/api/planned";
// In-process, so the session cookie is inherited rather than dropped — see lib/api/server.ts.
import { getOrgDomains } from "@/lib/api/server";
import { Badge } from "@/components/ui/badge";
import { ComingSoon } from "@/components/ui/coming-soon";
import { SettingsShell } from "@/components/dashboard/settings-shell";

/**
 * Settings → Domains (§2).
 *
 * An overview, deliberately not a control panel. Connecting and verifying a
 * domain belongs on the storefront it serves — the DNS records are per site and
 * a merchant acting on them needs the site in front of them — so every row here
 * links out rather than duplicating the flow.
 *
 * **Nothing on this page is a live DNS reading.** The endpoint reads none, on
 * purpose: a fan-out of one resolver round trip per store would make this the
 * slowest page in the dashboard and give every store its own way to time out.
 * So this page never claims a domain is reachable — it reports what the last
 * explicit check found, and says when that was.
 */
export default async function SettingsDomainsPage() {
  let data: OrgDomains | null = null;
  let planned = false;
  let error: string | null = null;

  try {
    data = await getOrgDomains();
  } catch (caught) {
    if (isPlannedError(caught)) {
      planned = true;
    } else if (caught instanceof Error) {
      error = caught.message;
    } else {
      error = "Domain settings could not be loaded.";
    }
  }

  if (!data) {
    // A planned section and a real failure are different facts; only one is ours to fix.
    return (
      <SettingsShell title="Domains" description={DESCRIPTION}>
        {planned ? (
          <ComingSoon
            title="Domain settings aren’t available yet"
            description="Custom domains for your storefronts will appear here."
          />
        ) : (
          <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
            <h2 className="text-base font-medium text-foreground">Domains</h2>
            <p className="mt-2 text-sm leading-6 text-muted">{error}</p>
          </section>
        )}
      </SettingsShell>
    );
  }

  return (
    <SettingsShell title="Domains" description={DESCRIPTION}>
      <div className="space-y-6">
        <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-medium text-foreground">How a domain connects</h2>
              <p className="mt-1 text-sm leading-6 text-muted">
                Publish a <span className="font-medium text-foreground">TXT</span> record proving you
                control the domain, and point it at{" "}
                <span className="font-mono text-xs text-foreground">{data.expectedTarget}</span>.
                Until the TXT record verifies, the domain does not serve your storefront — the store
                stays reachable at its Markii address the whole time.
              </p>
            </div>
            {data.counts.pending > 0 ? (
              <Badge variant="warning">
                {data.counts.pending} awaiting DNS
              </Badge>
            ) : null}
          </div>

          {/*
            Stated rather than implied. Every status below is what the last
            explicit check wrote — a domain whose DNS broke an hour ago still
            reads "verified" here, and only the storefront's own page will say
            otherwise.
          */}
          <p className="mt-4 text-sm leading-6 text-muted">
            These statuses are from the last check, not from DNS right now. Open a storefront to
            re-check it.
          </p>
        </section>

        {data.items.length === 0 ? (
          <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
            <p className="text-sm leading-6 text-muted">
              You have no storefronts yet. Create one and you can connect a domain to it.
            </p>
          </section>
        ) : (
          <section className="overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface shadow-[var(--shadow-sm)]">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-border text-muted">
                  <tr>
                    <th className="px-5 py-3 font-normal">Storefront</th>
                    <th className="px-5 py-3 font-normal">Domain</th>
                    <th className="px-5 py-3 font-normal">Status</th>
                    <th className="px-5 py-3 font-normal">Last checked</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((row) => (
                    <DomainRow key={row.siteId} row={row} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </SettingsShell>
  );
}

const DESCRIPTION =
  "Custom domains across your storefronts. A domain serves your store only after you prove you " +
  "own it.";

function DomainRow({ row }: { row: OrgDomainRow }) {
  return (
    <tr className="border-b border-border last:border-0 align-top">
      <td className="px-5 py-3">
        <Link
          href={`/dashboard/websites/${row.siteSlug}`}
          className="font-medium text-foreground hover:text-brand"
        >
          {row.siteName}
        </Link>
        <p className="mt-0.5 text-xs text-muted">{row.storefrontUrl}</p>
      </td>
      <td className="px-5 py-3">
        {row.domain ? (
          <span className="font-mono text-xs text-foreground">{row.domain}</span>
        ) : (
          <span className="text-muted">—</span>
        )}
        {/*
          The problem text is the actionable half of a pending claim — usually
          "no TXT record found yet" — so it is shown rather than hidden behind
          a click, but only where it is still relevant.
        */}
        {row.problem && row.status !== "verified" ? (
          <p className="mt-1 max-w-md text-xs leading-5 text-muted">{row.problem}</p>
        ) : null}
      </td>
      <td className="px-5 py-3">
        <StatusBadge row={row} />
      </td>
      <td className="px-5 py-3 text-muted">
        {row.checkedAt ? (
          new Date(row.checkedAt).toLocaleDateString()
        ) : row.status === "none" ? (
          <span>—</span>
        ) : (
          /*
            Never checked is not the same as checked and failing, and a merchant
            who has just added the records needs to know nobody has looked yet.
          */
          <span>Not checked yet</span>
        )}
      </td>
    </tr>
  );
}

/**
 * `pending` is deliberately **not** an error colour. The merchant has done the
 * work and DNS is propagating, which can take an hour — red would read as "you
 * got it wrong" for the case where they got it right and are waiting.
 */
function StatusBadge({ row }: { row: OrgDomainRow }) {
  if (row.status === "verified") return <Badge variant="success">Verified</Badge>;
  if (row.status === "pending") return <Badge variant="warning">Awaiting DNS</Badge>;
  return <Badge variant="neutral">No domain</Badge>;
}
