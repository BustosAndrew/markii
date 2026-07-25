"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  getTemplate,
  postPreview,
  type PreviewDraft,
  type PreviewDraftProduct,
  type PreviewResponse,
} from "@/lib/api/preview";
import { createCategory } from "@/lib/api/categories";
import { createProduct } from "@/lib/api/products";
import { createSite, deploySite } from "@/lib/api/sites";
import { ApiClientError, type Site } from "@/lib/api/types";
import { formatCents } from "@/lib/api/money";
import type { ImportedCategory, ImportedItem } from "@/lib/api/import";
import { Button } from "@/components/ui/button";
import { FieldError, Input, Label, Textarea } from "@/components/ui/field";
import { Toggle } from "@/components/ui/toggle";
import { PageHeader } from "@/components/ui/page-header";
import { ImportDialog } from "@/components/dashboard/import-dialog";
import { PreviewPanes } from "@/components/dashboard/preview-panes";

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

const emptyDraft: PreviewDraft = {
  site: { name: "", slug: "", indexed: true },
  categories: [],
  products: [],
};

type Step = 1 | 2 | 3 | 4;

export function CreateWebsiteWizard({ sites }: { sites: Site[] }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);
  const [draft, setDraft] = useState<PreviewDraft>(emptyDraft);
  const [customDomain, setCustomDomain] = useState("");
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewTab, setPreviewTab] = useState<
    "html" | "llms" | "agent" | "sitemap"
  >("html");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [productName, setProductName] = useState("");
  const [productPrice, setProductPrice] = useState("");
  const [productDesc, setProductDesc] = useState("");
  const [categoryName, setCategoryName] = useState("");

  const canContinueFromCatalog = draft.products.length > 0;
  const canContinueFromName = draft.site.name.trim().length > 0;

  const previewPayload = useMemo(() => {
    const name = draft.site.name.trim() || "Untitled store";
    return {
      ...draft,
      site: {
        name,
        slug: draft.site.slug?.trim() || slugify(name),
        indexed: draft.site.indexed ?? true,
      },
    } satisfies PreviewDraft;
  }, [draft]);

  useEffect(() => {
    if (step < 3) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setPreviewLoading(true);
      setPreviewError(null);
      try {
        const next = await postPreview(previewPayload, {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setPreview(next);
      } catch (err) {
        if (controller.signal.aborted) return;
        setPreview(null);
        setPreviewError(
          err instanceof ApiClientError
            ? err.message
            : "Preview unavailable until the API is up.",
        );
      } finally {
        if (!controller.signal.aborted) setPreviewLoading(false);
      }
    }, 500);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [previewPayload, step]);

  function applyImported(payload: {
    items: ImportedItem[];
    categories: ImportedCategory[];
  }) {
    const categories = payload.categories.map((c) => ({
      name: c.name,
      slug: slugify(c.name),
    }));
    const products: PreviewDraftProduct[] = payload.items.map((item) => ({
      name: item.name,
      slug: item.slug || slugify(item.name),
      priceCents: item.priceCents,
      description: item.description ?? undefined,
      categorySlug: item.categoryName
        ? slugify(item.categoryName)
        : undefined,
      stock: item.stock,
      images: item.images,
    }));
    setDraft((prev) => ({
      ...prev,
      categories: mergeBySlug(prev.categories, categories),
      products: [...prev.products, ...products],
    }));
  }

  async function autofillTemplate() {
    setBusy(true);
    setError(null);
    try {
      const template = await getTemplate();
      setDraft(template);
      setStep(2);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Template unavailable.",
      );
    } finally {
      setBusy(false);
    }
  }

  function addCategory() {
    const name = categoryName.trim();
    if (!name) return;
    setDraft((prev) => ({
      ...prev,
      categories: mergeBySlug(prev.categories, [
        { name, slug: slugify(name) },
      ]),
    }));
    setCategoryName("");
  }

  function addProduct() {
    const name = productName.trim();
    const priceCents = Math.round(Number(productPrice) * 100);
    if (!name || !Number.isFinite(priceCents)) {
      setError("Product name and a valid price are required.");
      return;
    }
    setError(null);
    setDraft((prev) => ({
      ...prev,
      products: [
        ...prev.products,
        {
          name,
          slug: slugify(name),
          priceCents,
          description: productDesc.trim() || undefined,
          categorySlug: prev.categories[0]?.slug,
          stock: 10,
          images: [],
        },
      ],
    }));
    setProductName("");
    setProductPrice("");
    setProductDesc("");
  }

  async function persist(mode: "draft" | "live") {
    setBusy(true);
    setError(null);
    try {
      const name = draft.site.name.trim();
      if (!name) throw new ApiClientError(400, "VALIDATION_ERROR", "Site name is required.");

      const site = await createSite({
        name,
        slug: draft.site.slug?.trim() || slugify(name),
        indexed: draft.site.indexed ?? true,
        agentDiscovery: true,
        purchasesEnabled: true,
        paymentProviders: { x402: true, stripe: false },
        customDomain: customDomain.trim() || null,
        status: "draft",
      });

      const categoryIdBySlug = new Map<string, number>();
      for (const cat of draft.categories) {
        const created = await createCategory({
          siteId: site.id,
          name: cat.name,
          slug: cat.slug || slugify(cat.name),
          enabled: true,
        });
        categoryIdBySlug.set(created.slug, created.id);
      }

      for (const product of draft.products) {
        await createProduct({
          siteId: site.id,
          name: product.name,
          slug: product.slug || slugify(product.name),
          description: product.description ?? null,
          priceCents: product.priceCents,
          stock: product.stock ?? 0,
          images: product.images ?? [],
          enabled: true,
          categoryId: product.categorySlug
            ? categoryIdBySlug.get(product.categorySlug) ?? null
            : null,
        });
      }

      if (mode === "live") {
        await deploySite(site.slug);
      }

      router.push(`/dashboard/websites/${site.slug}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Save failed.");
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Create website"
        description="Import or build a catalog, preview agent surfaces, then save or deploy."
        actions={
          <Button variant="secondary" disabled={busy} onClick={() => void autofillTemplate()}>
            Autofill from template
          </Button>
        }
      />

      <ol className="grid gap-3 sm:grid-cols-4">
        {[
          { n: 1, label: "Catalog", hint: "Import or add products" },
          { n: 2, label: "Site", hint: "Name and address" },
          { n: 3, label: "Preview", hint: "What agents will read" },
          { n: 4, label: "Deploy", hint: "Save or go live" },
        ].map((s) => {
          const state = step === s.n ? "current" : step > s.n ? "done" : "todo";
          return (
            <li
              key={s.n}
              aria-current={state === "current" ? "step" : undefined}
              className="flex items-start gap-2.5 border-t-2 pt-3 transition-colors"
              style={{
                borderColor:
                  state === "todo" ? "var(--border)" : "var(--brand)",
              }}
            >
              <span
                className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                  state === "current"
                    ? "bg-brand text-on-brand"
                    : state === "done"
                      ? "bg-brand/15 text-brand"
                      : "bg-hover text-muted"
                }`}
              >
                {state === "done" ? "✓" : s.n}
              </span>
              <span className="min-w-0">
                <span
                  className={`block text-sm font-medium ${
                    state === "todo" ? "text-muted" : "text-foreground"
                  }`}
                >
                  {s.label}
                </span>
                <span className="block text-xs text-muted">{s.hint}</span>
              </span>
            </li>
          );
        })}
      </ol>

      {step === 1 ? (
        <section className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-4 rounded-[var(--radius-card)] border border-border bg-surface p-5">
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setImportOpen(true)}
              >
                Import CSV / scrape
              </Button>
            </div>

            <div>
              <Label htmlFor="cat">Add category</Label>
              <div className="flex gap-2">
                <Input
                  id="cat"
                  value={categoryName}
                  onChange={(e) => setCategoryName(e.target.value)}
                  placeholder="Shirts"
                />
                <Button type="button" variant="secondary" onClick={addCategory}>
                  Add
                </Button>
              </div>
            </div>

            <div className="space-y-3">
              <Label>Add product</Label>
              <Input
                value={productName}
                onChange={(e) => setProductName(e.target.value)}
                placeholder="Name"
              />
              <Input
                value={productPrice}
                onChange={(e) => setProductPrice(e.target.value)}
                placeholder="Price e.g. 19.99"
                inputMode="decimal"
              />
              <Textarea
                value={productDesc}
                onChange={(e) => setProductDesc(e.target.value)}
                placeholder="Description"
                rows={3}
              />
              <Button type="button" variant="secondary" onClick={addProduct}>
                Add product
              </Button>
            </div>
          </div>

          <div className="flex flex-col rounded-[var(--radius-card)] border border-border bg-surface p-5">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-sm font-medium text-foreground">Draft catalog</h2>
              <p className="text-sm text-muted">
                {draft.categories.length}{" "}
                {draft.categories.length === 1 ? "category" : "categories"} ·{" "}
                {draft.products.length}{" "}
                {draft.products.length === 1 ? "product" : "products"}
              </p>
            </div>

            {draft.categories.length > 0 ? (
              <ul className="mt-3 flex flex-wrap gap-1.5">
                {draft.categories.map((c) => (
                  <li
                    key={c.slug ?? c.name}
                    className="rounded-full bg-hover-soft px-2.5 py-1 text-xs text-foreground"
                  >
                    {c.name}
                  </li>
                ))}
              </ul>
            ) : null}

            {draft.products.length === 0 ? (
              <div className="mt-4 flex flex-1 flex-col items-center justify-center rounded-[var(--radius-control)] border border-dashed border-border px-6 py-10 text-center">
                <p className="text-sm font-medium text-foreground">
                  Nothing in the catalog yet
                </p>
                <p className="mt-1 max-w-xs text-sm text-muted">
                  Import a CSV or scrape a storefront, add products by hand, or
                  start from a filled-in example.
                </p>
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  <Button type="button" onClick={() => setImportOpen(true)}>
                    Import CSV / scrape
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void autofillTemplate()}
                  >
                    Use a template
                  </Button>
                </div>
              </div>
            ) : (
              <ul className="mt-4 max-h-80 divide-y divide-border overflow-y-auto text-sm">
                {draft.products.map((p) => (
                  <li
                    key={`${p.slug}-${p.name}`}
                    className="flex items-start justify-between gap-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium text-foreground">
                        {p.name}
                      </p>
                      <p className="text-xs text-muted">
                        {formatCents(p.priceCents)}
                        {p.categorySlug ? ` · ${p.categorySlug}` : ""}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      className="shrink-0"
                      onClick={() =>
                        setDraft((prev) => ({
                          ...prev,
                          products: prev.products.filter(
                            (x) => !(x.name === p.name && x.slug === p.slug),
                          ),
                        }))
                      }
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      ) : null}

      {step === 2 ? (
        <section className="max-w-xl space-y-4 rounded-[var(--radius-card)] border border-border bg-surface p-5">
          <div>
            <Label htmlFor="site-name">Site name</Label>
            <Input
              id="site-name"
              value={draft.site.name}
              onChange={(e) => {
                const name = e.target.value;
                setDraft((prev) => ({
                  ...prev,
                  site: {
                    ...prev.site,
                    name,
                    slug: prev.site.slug?.trim()
                      ? prev.site.slug
                      : slugify(name),
                  },
                }));
              }}
              placeholder="Demo Store"
            />
          </div>
          <div>
            <Label htmlFor="site-slug">Slug</Label>
            <Input
              id="site-slug"
              value={draft.site.slug ?? ""}
              onChange={(e) =>
                setDraft((prev) => ({
                  ...prev,
                  site: { ...prev.site, slug: slugify(e.target.value) },
                }))
              }
              placeholder="demo-store"
            />
            <p className="mt-1.5 text-xs text-muted">
              Subdomain: {(draft.site.slug || "your-site")}.markii.app
            </p>
          </div>
          <div className="rounded-[var(--radius-card)] border border-border px-4">
            <Toggle
              label="Indexed"
              description="Include in sitemap and allow crawler indexing."
              checked={draft.site.indexed ?? true}
              onChange={(indexed) =>
                setDraft((prev) => ({
                  ...prev,
                  site: { ...prev.site, indexed },
                }))
              }
            />
          </div>
        </section>
      ) : null}

      {step === 3 ? (
        <section className="space-y-3">
          {previewLoading ? (
            <p className="text-sm text-muted">Refreshing preview…</p>
          ) : null}
          {previewError ? (
            <p className="text-sm text-muted">{previewError}</p>
          ) : null}
          <PreviewPanes
            preview={preview}
            active={previewTab}
            onTabChange={setPreviewTab}
          />
        </section>
      ) : null}

      {step === 4 ? (
        <section className="max-w-xl space-y-4 rounded-[var(--radius-card)] border border-border bg-surface p-5">
          <div>
            <Label htmlFor="domain">Custom domain (optional)</Label>
            <Input
              id="domain"
              value={customDomain}
              onChange={(e) => setCustomDomain(e.target.value)}
              placeholder="shop.example.com"
            />
          </div>
          <p className="text-sm text-muted">
            Save keeps the site as <span className="text-foreground">draft</span>.
            Deploy marks it <span className="text-foreground">live</span>.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void persist("draft")}
            >
              {busy ? "Saving…" : "Save for later"}
            </Button>
            <Button disabled={busy} onClick={() => void persist("live")}>
              {busy ? "Deploying…" : "Deploy site"}
            </Button>
          </div>
        </section>
      ) : null}

      <FieldError>{error}</FieldError>

      <div className="flex justify-between gap-2">
        <Button
          variant="secondary"
          disabled={busy || step === 1}
          onClick={() => setStep((s) => (s > 1 ? ((s - 1) as Step) : s))}
        >
          Back
        </Button>
        {step < 4 ? (
          <Button
            disabled={
              busy ||
              (step === 1 && !canContinueFromCatalog) ||
              (step === 2 && !canContinueFromName)
            }
            onClick={() => setStep((s) => (s < 4 ? ((s + 1) as Step) : s))}
          >
            Continue
          </Button>
        ) : null}
      </div>

      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        sites={sites}
        onParsedDraft={applyImported}
      />
    </div>
  );
}

function mergeBySlug<T extends { name: string; slug?: string }>(
  existing: T[],
  incoming: T[],
) {
  const map = new Map(
    existing.map((c) => [c.slug || slugify(c.name), c] as const),
  );
  for (const item of incoming) {
    map.set(item.slug || slugify(item.name), item);
  }
  return [...map.values()];
}
