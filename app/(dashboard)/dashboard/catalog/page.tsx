import Link from "next/link";
import { Suspense } from "react";
import { ImageIcon } from "lucide-react";
import {
  listCategories,
  listCollections,
  listInventoryLevels,
  listProducts,
  listSites,
} from "@/lib/api/server";
import { firstParam, loadOrError, parseLimit, parsePage } from "@/lib/api/load";
import { formatCents } from "@/lib/api/money";
import type { Category } from "@/lib/api/types";
import { InventoryActions } from "@/components/dashboard/inventory-actions";
import { RouteTabs } from "@/components/dashboard/route-tabs";
import { FetchError } from "@/components/dashboard/fetch-error";
import { StockLevelsPanel } from "@/components/dashboard/stock-levels-panel";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ListFilters } from "@/components/ui/list-filters";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";

type CatalogTab = "products" | "categories" | "collections";

function nest(items: Category[]): { category: Category; depth: number }[] {
  const present = new Set(items.map((category) => category.id));
  const childrenOf = new Map<number | null, Category[]>();

  for (const category of items) {
    const key =
      category.parentId != null && present.has(category.parentId) ? category.parentId : null;
    childrenOf.set(key, [...(childrenOf.get(key) ?? []), category]);
  }

  const ordered: { category: Category; depth: number }[] = [];
  const walk = (parentId: number | null, depth: number) => {
    for (const category of childrenOf.get(parentId) ?? []) {
      ordered.push({ category, depth });
      walk(category.id, depth + 1);
    }
  };

  walk(null, 0);
  return ordered;
}

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const tabParam = firstParam(sp.tab);
  const tab: CatalogTab =
    tabParam === "categories" || tabParam === "collections" ? tabParam : "products";

  const q = firstParam(sp.q);
  const siteIdRaw = firstParam(sp.siteId);
  const siteId = siteIdRaw ? Number(siteIdRaw) : undefined;
  const enabledRaw = firstParam(sp.enabled);
  const inStockRaw = firstParam(sp.inStock);
  const categoryIdRaw = firstParam(sp.categoryId);
  const categoryId = categoryIdRaw ? Number(categoryIdRaw) : undefined;
  const lowStockRaw = firstParam(sp.lowStock);
  const lowStock = lowStockRaw ? Number(lowStockRaw) : 5;
  const page = parsePage(sp.page);
  const limit = parseLimit(sp.limit);

  const sitesResult = await loadOrError(() => listSites({ limit: 100, sort: "name" }));
  const sites = sitesResult.data?.items ?? [];

  const productsResult =
    tab === "products"
      ? await loadOrError(() =>
          listProducts({
            q,
            siteId: Number.isFinite(siteId) ? siteId : undefined,
            categoryId: Number.isFinite(categoryId) ? categoryId : undefined,
            enabled:
              enabledRaw === "true" ? true : enabledRaw === "false" ? false : undefined,
            inStock: inStockRaw === "true" ? true : undefined,
            page,
            limit,
            sort: "-createdAt",
          }),
        )
      : { data: null, error: null as string | null };

  const categoriesResult =
    tab === "categories"
      ? await loadOrError(() =>
          listCategories({
            q,
            siteId: Number.isFinite(siteId) ? siteId : undefined,
            enabled:
              enabledRaw === "true" ? true : enabledRaw === "false" ? false : undefined,
            page,
            limit,
          }),
        )
      : { data: null, error: null as string | null };

  const collectionsResult =
    tab === "collections"
      ? await loadOrError(() =>
          listCollections({
            q,
            siteId: Number.isFinite(siteId) ? siteId : undefined,
            page,
            limit,
          }),
        )
      : { data: null, error: null as string | null };

  const stockLevelsResult =
    tab === "products"
      ? await loadOrError(() =>
          listInventoryLevels({
            siteId: Number.isFinite(siteId) ? siteId : undefined,
            lowStock: Number.isFinite(lowStock) ? lowStock : 5,
            limit: 25,
          }),
        )
      : { data: null, error: null as string | null };

  return (
    <div>
      <PageHeader
        title="Catalog"
        description="Products, categories, and collections in one workspace."
        actions={
          tab === "products" ? (
            <InventoryActions sites={sites} />
          ) : tab === "categories" ? (
            <ButtonLink href="/dashboard/categories/new">New category</ButtonLink>
          ) : tab === "collections" ? (
            <ButtonLink href="/dashboard/collections/new">Create collection</ButtonLink>
          ) : undefined
        }
      />

      <div className="mb-6">
        <RouteTabs
          ariaLabel="Catalog sections"
          value={tab}
          tabs={[
            { value: "products", label: "Products" },
            { value: "categories", label: "Categories" },
            { value: "collections", label: "Collections" },
          ]}
        />
      </div>

      {tab === "products" ? (
        <>
          <Suspense fallback={null}>
            <ListFilters
              searchPlaceholder="Search name, slug, or SKU…"
              filters={[
                {
                  key: "siteId",
                  label: "All sites",
                  options: sites.map((site) => ({
                    value: String(site.id),
                    label: site.name,
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

          {productsResult.error ? (
            <FetchError title="Products unavailable" message={productsResult.error} />
          ) : null}

          {!productsResult.error && productsResult.data && productsResult.data.items.length === 0 ? (
            <EmptyState
              title="No products"
              description="Create a product or import a catalog when the live inventory API has data for this view."
              action={<ButtonLink href="/dashboard/products/new">New product</ButtonLink>}
            />
          ) : null}

          {!productsResult.error && productsResult.data && productsResult.data.items.length > 0 ? (
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
                    {productsResult.data.items.map((product) => (
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
                          {product.stock === 0 ? (
                            <Badge variant="error">Out of stock</Badge>
                          ) : product.stock <= 15 ? (
                            <span className="tabular-nums text-warning-text">
                              {product.stock} left
                            </span>
                          ) : (
                            <span className="tabular-nums text-foreground">{product.stock}</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
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
                <Pagination
                  page={productsResult.data.page}
                  limit={productsResult.data.limit}
                  total={productsResult.data.total}
                />
              </Suspense>

              <StockLevelsPanel
                items={stockLevelsResult.data?.items ?? null}
                lowStock={Number.isFinite(lowStock) ? lowStock : 5}
                error={stockLevelsResult.error}
              />
            </>
          ) : null}
        </>
      ) : null}

      {tab === "categories" ? (
        <>
          <Suspense fallback={null}>
            <ListFilters
              searchPlaceholder="Search categories…"
              filters={[
                {
                  key: "siteId",
                  label: "All sites",
                  options: sites.map((site) => ({
                    value: String(site.id),
                    label: site.name,
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
              ]}
            />
          </Suspense>

          {categoriesResult.error ? (
            <FetchError title="Categories unavailable" message={categoriesResult.error} />
          ) : null}

          {!categoriesResult.error &&
          categoriesResult.data &&
          categoriesResult.data.items.length === 0 ? (
            <EmptyState
              title="No categories"
              description="Create a category to organize products."
              action={<ButtonLink href="/dashboard/categories/new">New category</ButtonLink>}
            />
          ) : null}

          {!categoriesResult.error &&
          categoriesResult.data &&
          categoriesResult.data.items.length > 0 ? (
            <>
              <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead className="bg-surface-elevated text-muted">
                    <tr>
                      <th className="px-4 py-3 font-medium">Category</th>
                      <th className="px-4 py-3 font-medium">Site</th>
                      <th className="px-4 py-3 font-medium">Parent</th>
                      <th className="px-4 py-3 font-medium">Products</th>
                      <th className="px-4 py-3 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {nest(categoriesResult.data.items).map(({ category, depth }) => (
                      <tr
                        key={category.id}
                        className="border-t border-border hover:bg-table-hover"
                      >
                        <td className="px-4 py-3">
                          <div
                            className="flex items-baseline gap-2"
                            style={{ paddingLeft: depth * 20 }}
                          >
                            {depth > 0 ? (
                              <span aria-hidden className="text-muted-soft">
                                ↳
                              </span>
                            ) : null}
                            <div className="min-w-0">
                              <Link
                                href={`/dashboard/categories/${category.slug}?siteId=${category.siteId}`}
                                className="font-medium text-foreground hover:text-brand"
                              >
                                {category.name}
                              </Link>
                              <p className="font-mono text-xs text-muted">{category.slug}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-muted">
                          {category.site?.name ?? "—"}
                        </td>
                        <td className="px-4 py-3 text-muted">
                          {category.parent?.name ?? "—"}
                        </td>
                        <td className="px-4 py-3 tabular-nums">
                          {category.productCount > 0 ? (
                            <Link
                              href={`/dashboard/catalog?tab=products&categoryId=${category.id}`}
                              className="text-foreground hover:text-brand"
                            >
                              {category.productCount}
                            </Link>
                          ) : (
                            <span className="text-muted">0</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {category.enabled ? (
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
                <Pagination
                  page={categoriesResult.data.page}
                  limit={categoriesResult.data.limit}
                  total={categoriesResult.data.total}
                />
              </Suspense>
            </>
          ) : null}
        </>
      ) : null}

      {tab === "collections" ? (
        !collectionsResult.data ? (
          <FetchError message={collectionsResult.error ?? "Collections could not be loaded."} />
        ) : collectionsResult.data.items.length === 0 ? (
          <EmptyState
            title="No collections yet"
            description="Collections are merchandising, distinct from categories: a product sits in one category but can appear in many collections."
            action={
              <ButtonLink href="/dashboard/collections/new">Create collection</ButtonLink>
            }
          />
        ) : (
          <>
            <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface shadow-[var(--shadow-sm)]">
              <table className="w-full min-w-[40rem] text-left text-sm">
                <thead className="text-muted">
                  <tr className="border-b border-border">
                    <th className="px-4 py-3 font-medium">Collection</th>
                    <th className="px-4 py-3 font-medium">Type</th>
                    <th className="px-4 py-3 font-medium">Products</th>
                    <th className="px-4 py-3 font-medium">Visibility</th>
                  </tr>
                </thead>
                <tbody>
                  {collectionsResult.data.items.map((c) => (
                    <tr key={c.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-3">
                        <div className="font-medium text-foreground">{c.title}</div>
                        <div className="text-xs text-muted">{c.handle}</div>
                      </td>
                      <td className="px-4 py-3">
                        {/*
                          An automated collection resolves its members at read
                          time and is never materialised, so its count moves as
                          the catalog does — worth distinguishing from a manual
                          list someone curated.
                        */}
                        <Badge variant={c.type === "automated" ? "info" : "neutral"}>
                          {c.type === "automated" ? "Rule-based" : "Manual"}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 tabular-nums text-foreground">
                        {c.productCount}
                      </td>
                      <td className="px-4 py-3 text-muted">
                        {c.publishedAt ? "Published" : "Hidden"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Pagination
              page={collectionsResult.data.page}
              limit={collectionsResult.data.limit}
              total={collectionsResult.data.total}
            />
          </>
        )
      ) : null}
    </div>
  );
}
