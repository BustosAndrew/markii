import { permanentRedirect } from "next/navigation";
import { firstParam } from "@/lib/api/load";

export default async function FinancesDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const next = new URLSearchParams();

  for (const key of ["q", "from", "to", "status", "page", "limit"]) {
    const value = firstParam(sp[key]);
    if (value) {
      next.set(key, value);
    }
  }

  const suffix = next.toString() ? `?${next.toString()}` : "";
  permanentRedirect(`/dashboard/orders/settlements/${slug}${suffix}`);
}
