import { permanentRedirect } from "next/navigation";
import { firstParam } from "@/lib/api/load";

export default async function FinancesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const next = new URLSearchParams();

  for (const key of ["q", "from", "to"]) {
    const value = firstParam(sp[key]);
    if (value) {
      next.set(key, value);
    }
  }

  const suffix = next.toString() ? `?${next.toString()}` : "";
  permanentRedirect(`/dashboard/orders/settlements${suffix}`);
}
