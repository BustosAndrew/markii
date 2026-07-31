import { permanentRedirect } from "next/navigation";
import { firstParam } from "@/lib/api/load";

export default async function CategoriesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const next = new URLSearchParams();

  next.set("tab", "categories");

  for (const key of ["q", "siteId", "enabled", "page", "limit"]) {
    const value = firstParam(sp[key]);
    if (value) {
      next.set(key, value);
    }
  }

  permanentRedirect(`/dashboard/catalog?${next.toString()}`);
}
