import { permanentRedirect } from "next/navigation";
import { firstParam } from "@/lib/api/load";

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const next = new URLSearchParams();

  next.set("tab", "products");

  for (const key of ["q", "siteId", "enabled", "inStock", "categoryId", "page", "limit"]) {
    const value = firstParam(sp[key]);
    if (value) {
      next.set(key, value);
    }
  }

  permanentRedirect(`/dashboard/catalog?${next.toString()}`);
}
