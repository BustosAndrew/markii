import Link from "next/link";
import { notFound } from "next/navigation";
import { loadOrError } from "@/lib/api/load";
import { formatMinor } from "@/lib/api/money";
import { getDiscount, getMe, listSites } from "@/lib/api/server";
import { FetchError } from "@/components/dashboard/fetch-error";
import { DiscountForm } from "@/components/dashboard/discount-form";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";

export default async function DiscountDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const discountId = Number(id);
  if (!Number.isInteger(discountId) || discountId <= 0) notFound();

  const [discount, sites, me] = await Promise.all([
    loadOrError(() => getDiscount(discountId)),
    loadOrError(() => listSites({ limit: 100, sort: "name" })),
    loadOrError(() => getMe()),
  ]);

  if (!discount.data) {
    return (
      <div>
        <PageHeader
          title="Discount"
          actions={
            <Link href="/dashboard/discounts" className="text-sm text-muted hover:text-foreground">
              Back to discounts
            </Link>
          }
        />
        <FetchError message={discount.error ?? "This discount could not be loaded."} />
      </div>
    );
  }

  const d = discount.data;
  const currency = me.data?.org.currency ?? "USD";

  return (
    <div>
      <PageHeader
        title={d.title}
        description={
          d.code ? `Code ${d.code}` : "Automatic — no code needed"
        }
        actions={
          <Link href="/dashboard/discounts" className="text-sm text-muted hover:text-foreground">
            Back to discounts
          </Link>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Badge variant={d.status === "active" ? "success" : "neutral"}>{d.status}</Badge>
        <span className="text-sm text-muted">
          {d.usedCount} used
          {d.usageLimit != null ? ` / ${d.usageLimit}` : ""}
          {d.totalDiscountedMinor > 0
            ? ` · ${formatMinor(d.totalDiscountedMinor, currency)} discounted`
            : ""}
        </span>
      </div>

      <DiscountForm
        mode="edit"
        discount={d}
        sites={sites.data?.items ?? []}
        currency={currency}
      />
    </div>
  );
}
