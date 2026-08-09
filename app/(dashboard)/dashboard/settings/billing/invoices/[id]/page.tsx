import Link from "next/link";
import { notFound } from "next/navigation";
import { getBillingInvoice } from "@/lib/api/server";
import { formatMinor } from "@/lib/api/money";
import { isConfigurationRequired } from "@/lib/api/planned";
import { ApiClientError } from "@/lib/api/types";
import { SettingsShell } from "@/components/dashboard/settings-shell";
export default async function BillingInvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let invoice;
  try {
    invoice = await getBillingInvoice(id);
  } catch (err) {
    if (err instanceof ApiClientError && err.status === 404) notFound();
    if (isConfigurationRequired(err)) {
      return (
        <SettingsShell title="Invoice" description="Stripe billing is not configured.">
          <p className="text-sm text-muted">
            {err instanceof Error ? err.message : "Configuration required."}
          </p>
        </SettingsShell>
      );
    }
    throw err;
  }

  return (
    <SettingsShell
      title={invoice.number ?? "Invoice"}
      description={`Status: ${invoice.status}`}
    >
      <div className="mb-6">
        <Link
          href="/dashboard/settings/billing"
          className="text-sm text-muted underline-offset-2 hover:underline"
        >
          ← Back to billing
        </Link>
      </div>

      <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
        <dl className="grid gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted-soft uppercase">Total</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums text-foreground">
              {formatMinor(invoice.totalMinor, invoice.currency)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-soft uppercase">Amount due</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums text-foreground">
              {formatMinor(invoice.amountDueMinor, invoice.currency)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-soft uppercase">Created</dt>
            <dd className="mt-1 text-sm text-foreground">
              {new Date(invoice.createdAt).toLocaleString()}
            </dd>
          </div>
        </dl>

        <div className="mt-6 flex flex-wrap gap-2">
          {invoice.hostedInvoiceUrl ? (
            <a
              href={invoice.hostedInvoiceUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex cursor-pointer items-center justify-center rounded-[var(--radius-control)] bg-brand px-4 py-2.5 text-sm font-medium text-on-brand shadow-[var(--shadow-sm)]"
            >
              Open hosted invoice
            </a>
          ) : null}
          {invoice.invoicePdfUrl ? (
            <a
              href={invoice.invoicePdfUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex cursor-pointer items-center justify-center rounded-[var(--radius-control)] border border-border bg-surface px-4 py-2.5 text-sm font-medium text-foreground hover:bg-hover"
            >
              Download PDF
            </a>
          ) : null}
        </div>

        <table className="mt-8 w-full text-left text-sm">
          <thead>
            <tr className="text-xs tracking-wide text-muted-soft uppercase">
              <th className="pb-2 font-medium">Line</th>
              <th className="pb-2 font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {invoice.lines.map((line, i) => (
              <tr key={`${line.description}-${i}`} className="border-t border-border">
                <td className="py-3 pr-4">
                  <p className="text-foreground">{line.description}</p>
                  {line.feeAssessment ? (
                    <p className="mt-1 text-xs text-muted">
                      From threshold assessment{" "}
                      {formatMinor(
                        line.feeAssessment.feeMinor,
                        line.feeAssessment.currency,
                      )}{" "}
                      · {line.feeAssessment.productClass ?? "unclassified"}
                    </p>
                  ) : null}
                </td>
                <td className="py-3 tabular-nums text-foreground">
                  {formatMinor(line.amountMinor, invoice.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </SettingsShell>
  );
}
