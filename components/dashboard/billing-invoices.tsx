import Link from "next/link";
import type { FeeAssessment, Invoice, InvoicesResponse } from "@/lib/api/billing";
import { formatMinor } from "@/lib/api/money";
import { Badge } from "@/components/ui/badge";

function invoiceStatus(status: string): {
  label: string;
  variant: "success" | "warning" | "neutral";
} {
  switch (status) {
    case "paid":
      return { label: "Paid", variant: "success" };
    case "open":
      return { label: "Due", variant: "warning" };
    case "void":
      return { label: "Voided — never collected", variant: "neutral" };
    case "uncollectible":
      return { label: "Uncollectible", variant: "warning" };
    case "draft":
      return { label: "Draft", variant: "neutral" };
    default:
      return { label: status.replace(/_/g, " "), variant: "neutral" };
  }
}

function InvoiceRow({ invoice }: { invoice: Invoice }) {
  const status = invoiceStatus(invoice.status);
  return (
    <tr className="border-t border-border">
      <td className="py-3 pr-4 text-sm text-foreground">
        <Link
          href={`/dashboard/settings/billing/invoices/${invoice.id}`}
          className="underline-offset-2 hover:underline"
        >
          {invoice.number ?? invoice.id}
        </Link>
      </td>
      <td className="py-3 pr-4">
        <Badge variant={status.variant}>{status.label}</Badge>
      </td>
      <td className="py-3 pr-4 text-sm tabular-nums text-foreground">
        {formatMinor(invoice.totalMinor, invoice.currency)}
      </td>
      <td className="py-3 text-sm text-muted">
        {new Date(invoice.createdAt).toLocaleDateString()}
      </td>
    </tr>
  );
}

function AssessmentRow({ row }: { row: FeeAssessment }) {
  return (
    <tr className="border-t border-border">
      <td className="py-3 pr-4 text-sm text-foreground">
        {new Date(row.periodStart).toLocaleDateString()} –{" "}
        {new Date(row.periodEnd).toLocaleDateString()}
      </td>
      <td className="py-3 pr-4 text-sm capitalize text-muted">
        {row.productClass ?? "unclassified"}
      </td>
      <td className="py-3 pr-4 text-sm tabular-nums text-foreground">
        {formatMinor(row.feeMinor, row.currency)}
      </td>
      <td className="py-3 text-sm text-muted">
        {row.invoiced
          ? row.stripeInvoiceItemId
            ? "Invoiced"
            : "Settled · nothing owed"
          : "Pending next scheduled invoice"}
      </td>
    </tr>
  );
}

export function BillingInvoices({ data }: { data: InvoicesResponse }) {
  return (
    <div className="space-y-8">
      <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
        <h2 className="text-base font-medium text-foreground">Invoices</h2>
        <p className="mt-1 text-sm leading-6 text-muted">
          Demands for payment from Stripe. PDFs open on Stripe&apos;s hosted pages.
        </p>
        {data.invoicesState ? (
          <p className="mt-4 text-sm text-muted">{data.invoicesState.message}</p>
        ) : null}
        {data.invoices.length === 0 && !data.invoicesState ? (
          <p className="mt-4 text-sm text-muted">No invoices yet.</p>
        ) : null}
        {data.invoices.length > 0 ? (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[28rem] text-left">
              <thead>
                <tr className="text-xs tracking-wide text-muted-soft uppercase">
                  <th className="pb-2 font-medium">Invoice</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2 font-medium">Total</th>
                  <th className="pb-2 font-medium">Date</th>
                </tr>
              </thead>
              <tbody>
                {data.invoices.map((invoice) => (
                  <InvoiceRow key={invoice.id} invoice={invoice} />
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
        <h2 className="text-base font-medium text-foreground">
          Threshold fee assessments
        </h2>
        <p className="mt-1 text-sm leading-6 text-muted">
          What each metering period measured. Assessments are measured automatically on a monthly
          schedule; they are not provisional and do not need a merchant to trigger them.
        </p>
        {data.assessmentsState ? (
          <p className="mt-4 text-sm text-muted">{data.assessmentsState.message}</p>
        ) : null}
        {data.assessments.length === 0 && !data.assessmentsState ? (
          <p className="mt-4 text-sm text-muted">No assessments yet.</p>
        ) : null}
        {data.assessments.length > 0 ? (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[32rem] text-left">
              <thead>
                <tr className="text-xs tracking-wide text-muted-soft uppercase">
                  <th className="pb-2 font-medium">Period</th>
                  <th className="pb-2 font-medium">Class</th>
                  <th className="pb-2 font-medium">Fee</th>
                  <th className="pb-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.assessments.map((row) => (
                  <AssessmentRow key={row.id} row={row} />
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </div>
  );
}
