import { redirect } from "next/navigation";

export default async function LegacyBillingInvoicePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/dashboard/billing/invoices/${encodeURIComponent(id)}`);
}
