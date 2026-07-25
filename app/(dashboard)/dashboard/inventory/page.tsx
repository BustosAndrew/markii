import Link from "next/link";
import { Suspense } from "react";
import { ImageIcon } from "lucide-react";
import { listProducts, listSites } from "@/lib/api/server";
import { firstParam, loadOrError, parseLimit, parsePage } from "@/lib/api/load";
import { formatCents } from "@/lib/api/money";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { ListFilters } from "@/components/ui/list-filters";
import { FetchError } from "@/components/dashboard/fetch-error";
import { InventoryActions } from "@/components/dashboard/inventory-actions";

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const q = firstParam(sp.q);
  const siteIdRaw = firstParam(sp.siteId);
  const siteId = siteIdRaw ? Number(siteIdRaw) : undefined;
  const enabledRaw = firstParam(sp.enabled);
  const inStockRaw = firstParam(sp.inStock);
  const categoryIdRaw = firstParam(sp.categoryId);
  const categoryId = categoryIdRaw ? Number(categoryIdRaw) : undefined;
  const page = parsePage(sp.page);
  const limit = parseLimit(sp.limit);

  const sitesResult = await loadOrError(() =>
    listSites({ limit: 100, sort: "name" }),
  );
  const sites = sitesResult.data?.items ?? [];

  const { data, error } = await loadOrError(() =>
    listProducts(
      {
        q,
        siteId: Number.isFinite(siteId) ? siteId : undefined,
        categoryId: Number.isFinite(categoryId) ? categoryId : undefined,
        enabled:
          enabledRaw === "true"
            ? true
            : enabledRaw === "false"
              ? false
              : undefined,
        inStock: inStockRaw === "true" ? true : undefined,
        page,
        limit,
        sort: "-createdAt",
      }),
  );

  return (
    <div>
      <PageHeader
        title="Inventory"
        description="Products across all sites."
        actions={<InventoryActions sites={sites} />}
      />

      <Suspense fallback={null}>
        <ListFilters
          searchPlaceholder="Search name, slug, or SKU…"
          filters={[
            {
              key: "siteId",
              label: "All sites",
              options: sites.map((s) => ({
                value: String(s.id),
                label: s.name,
              })),
            },
            {
              key: "enabled",
              label: "All availability",
              options: [
                { value: "true", label: "Enabled" },
                { value: "false", label: "Disabled" },
              ],
            },
            {
              key: "inStock",
              label: "Stock",
              options: [{ value: "true", label: "In stock" }],
            },
          ]}
        />
      </Suspense>

      {error ? <FetchError title="Inventory unavailable" message={error} /> : null}

      {!error && data && data.items.length === 0 ? (
        <EmptyState
          title="No products"
          description="Create a product or import a catalog when the API is ready."
          action={
            <ButtonLink href="/dashboard/products/new">New product</ButtonLink>
          }
        />
      ) : null}

      {!error && data && data.items.length > 0 ? (
        <>
          <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="bg-surface-elevated text-muted">
                <tr>
                  <th className="px-4 py-3 font-medium">Product</th>
                  <th className="px-4 py-3 font-medium">Site</th>
                  <th className="px-4 py-3 font-medium">Category</th>
                  <th className="px-4 py-3 font-medium">Price</th>
                  <th className="px-4 py-3 font-medium">Stock</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((product) => (
                  <tr
                    key={product.id}
                    className="border-t border-border hover:bg-table-hover"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {product.images[0] ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={product.images[0]}
                            alt=""
                            loading="lazy"
                            className="size-10 shrink-0 rounded-[var(--radius-control)] border border-border object-cover"
                          />
                        ) : (
                          <span
                            aria-hidden
                            className="flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-control)] border border-dashed border-border text-muted-soft"
                          >
                            <ImageIcon className="size-4" strokeWidth={1.75} />
                          </span>
                        )}
                        <div className="min-w-0">
                          <Link
                            href={`/dashboard/products/${product.slug}?siteId=${product.siteId}`}
                            className="font-medium text-foreground hover:text-brand"
                          >
                            {product.name}
                          </Link>
                          <p className="font-mono text-xs text-muted">
                            {product.sku || product.slug}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted">
                      {product.site?.name ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-muted">
                      {product.category?.name ?? "—"}
                    </td>
                    <td className="px-4 py-3 tabular-nums">
                      {formatCents(product.priceCents, product.currency)}
                    </td>
                    <td className="px-4 py-3">
                      {/* stock only matters when it's running out — say so */}
                      {product.stock === 0 ? (
                        <Badge variant="error">Out of stock</Badge>
                      ) : product.stock <= 15 ? (
                        <span className="tabular-nums text-warning-text">
                          {product.stock} left
                        </span>
                      ) : (
                        <span className="tabular-nums text-foreground">
                          {product.stock}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {/* only flag the exception — a badge on every row carries no signal */}
                      {product.enabled ? (
                        <span className="text-muted">Enabled</span>
                      ) : (
                        <Badge variant="neutral">Disabled</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Suspense fallback={null}>
            <Pagination page={data.page} limit={data.limit} total={data.total} />
          </Suspense>
        </>
      ) : null}
    </div>
  );
}
