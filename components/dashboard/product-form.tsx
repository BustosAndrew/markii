"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { MembershipTier } from "@/lib/api/memberships";
import {
  createProduct,
  deleteProduct,
  duplicateProduct,
  updateProduct,
} from "@/lib/api/products";
import { uploadProductImage } from "@/lib/api/uploads";
import { ApiClientError, type Category, type Product, type Site } from "@/lib/api/types";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FieldError, Input, Label, Select, Textarea } from "@/components/ui/field";
import { Toggle } from "@/components/ui/toggle";

function dollarsToCents(value: string) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function centsToDollars(cents: number) {
  return (cents / 100).toFixed(2);
}

type TierOption = Pick<MembershipTier, "id" | "name" | "siteId">;

export function ProductForm({
  mode,
  product,
  sites,
  categories,
  tiers,
}: {
  mode: "create" | "edit";
  product?: Product;
  sites: Site[];
  categories: Category[];
  /** Loaded in the page RSC — never fetch tiers from the browser. */
  tiers: TierOption[];
}) {
  const router = useRouter();
  const [siteId, setSiteId] = useState(String(product?.siteId ?? sites[0]?.id ?? ""));
  const [name, setName] = useState(product?.name ?? "");
  const [slug, setSlug] = useState(product?.slug ?? "");
  const [description, setDescription] = useState(product?.description ?? "");
  const [price, setPrice] = useState(
    product ? centsToDollars(product.priceCents) : "",
  );
  const [sku, setSku] = useState(product?.sku ?? "");
  const [stock, setStock] = useState(String(product?.stock ?? 0));
  const [categoryId, setCategoryId] = useState(
    product?.categoryId != null ? String(product.categoryId) : "",
  );
  const [images, setImages] = useState<string[]>(product?.images ?? []);
  const [imageUrl, setImageUrl] = useState("");
  const [enabled, setEnabled] = useState(product?.enabled ?? true);
  const [requiresTierId, setRequiresTierId] = useState(
    product?.requiresTierId != null ? String(product.requiresTierId) : "",
  );
  const [grantsTierId, setGrantsTierId] = useState(
    product?.grantsTierId != null ? String(product.grantsTierId) : "",
  );
  const [grantsDurationDays, setGrantsDurationDays] = useState(
    product?.grantsDurationDays != null ? String(product.grantsDurationDays) : "",
  );
  const [grantsRenewalInterval, setGrantsRenewalInterval] = useState<
    Product["grantsRenewalInterval"]
  >(product?.grantsRenewalInterval ?? "none");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const siteCategories = useMemo(
    () => categories.filter((c) => String(c.siteId) === siteId),
    [categories, siteId],
  );
  const siteTiers = useMemo(
    () => tiers.filter((tier) => String(tier.siteId) === siteId),
    [siteId, tiers],
  );
  const tierIds = useMemo(
    () => new Set(siteTiers.map((tier) => String(tier.id))),
    [siteTiers],
  );
  /** Drop stale selections when the storefront changes — derived, no effect. */
  const effectiveRequiresTierId = tierIds.has(requiresTierId) ? requiresTierId : "";
  const effectiveGrantsTierId = tierIds.has(grantsTierId) ? grantsTierId : "";
  const effectiveRenewalInterval = effectiveGrantsTierId
    ? grantsRenewalInterval
    : ("none" as const);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const priceCents = dollarsToCents(price);
    if (!siteId || !name.trim() || priceCents === null) {
      setError("Site, name, and a valid price are required.");
      return;
    }
    const parsedDuration = grantsDurationDays.trim()
      ? Number(grantsDurationDays.trim())
      : null;
    if (
      parsedDuration != null &&
      (!Number.isInteger(parsedDuration) || parsedDuration <= 0 || parsedDuration > 3650)
    ) {
      setError("Grant duration must be between 1 and 3650 days.");
      return;
    }
    if (effectiveRenewalInterval !== "none" && !effectiveGrantsTierId) {
      setError("A renewal interval requires a granting tier.");
      return;
    }

    setBusy(true);
    try {
      const body = {
        siteId: Number(siteId),
        name: name.trim(),
        slug: slug.trim() || undefined,
        description: description.trim() || null,
        priceCents,
        sku: sku.trim() || null,
        stock: Number(stock) || 0,
        categoryId: categoryId ? Number(categoryId) : null,
        images,
        enabled,
        requiresTierId: effectiveRequiresTierId
          ? Number(effectiveRequiresTierId)
          : null,
        grantsTierId: effectiveGrantsTierId ? Number(effectiveGrantsTierId) : null,
        grantsDurationDays:
          effectiveGrantsTierId && effectiveRenewalInterval === "none"
            ? parsedDuration
            : null,
        grantsRenewalInterval: effectiveGrantsTierId
          ? effectiveRenewalInterval
          : "none",
      };

      if (mode === "create") {
        const created = await createProduct(body);
        router.push(
          `/dashboard/products/${created.slug}?siteId=${created.siteId}`,
        );
      } else if (product) {
        const updated = await updateProduct(product.slug, body, {
          siteId: product.siteId,
        });
        if (updated.slug !== product.slug) {
          router.replace(
            `/dashboard/products/${updated.slug}?siteId=${updated.siteId}`,
          );
        } else {
          router.refresh();
        }
      }
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="max-w-2xl space-y-5">
      <div>
        <Label htmlFor="site">Site</Label>
        <Select
          id="site"
          value={siteId}
          onChange={(e) => {
            setSiteId(e.target.value);
            setCategoryId("");
          }}
          required
        >
          <option value="" disabled>
            Select a site
          </option>
          {sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div>
          <Label htmlFor="slug">Slug</Label>
          <Input
            id="slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="auto from name"
          />
        </div>
      </div>

      <div>
        <Label htmlFor="description">Description</Label>
        <Textarea
          id="description"
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <Label htmlFor="price">Price (USD)</Label>
          <Input
            id="price"
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="19.99"
            required
          />
        </div>
        <div>
          <Label htmlFor="sku">SKU</Label>
          <Input id="sku" value={sku} onChange={(e) => setSku(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="stock">Stock</Label>
          <Input
            id="stock"
            inputMode="numeric"
            value={stock}
            onChange={(e) => setStock(e.target.value)}
          />
        </div>
      </div>

      <div>
        <Label htmlFor="category">Category</Label>
        <Select
          id="category"
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
        >
          <option value="">Uncategorized</option>
          {siteCategories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>

      <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
        <div>
          <h2 className="text-base font-medium text-foreground">Membership access</h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            A product can require a tier to buy it, grant a tier after purchase, or do both.
          </p>
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="requires-tier">Requires tier</Label>
            <Select
              id="requires-tier"
              value={effectiveRequiresTierId}
              disabled={busy}
              onChange={(e) => setRequiresTierId(e.target.value)}
            >
              <option value="">No membership gate</option>
              {siteTiers.map((tier) => (
                <option key={tier.id} value={tier.id}>
                  {tier.name}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <Label htmlFor="grants-tier">Grants tier</Label>
            <Select
              id="grants-tier"
              value={effectiveGrantsTierId}
              disabled={busy}
              onChange={(e) => {
                const nextTierId = e.target.value;
                setGrantsTierId(nextTierId);
                if (!nextTierId) setGrantsRenewalInterval("none");
              }}
            >
              <option value="">Does not grant membership</option>
              {siteTiers.map((tier) => (
                <option key={tier.id} value={tier.id}>
                  {tier.name}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="grants-renewal">Renewal interval</Label>
            <Select
              id="grants-renewal"
              value={effectiveRenewalInterval}
              disabled={busy || !effectiveGrantsTierId}
              onChange={(e) =>
                setGrantsRenewalInterval(
                  e.target.value as Product["grantsRenewalInterval"],
                )
              }
            >
              <option value="none">One-time membership purchase</option>
              <option value="month">Monthly renewal</option>
              <option value="year">Yearly renewal</option>
            </Select>
            <p className="mt-1.5 text-xs leading-5 text-muted">
              Renewal interval requires a granting tier. Recurring purchases use the
              storefront subscription checkout.
            </p>
          </div>

          {effectiveRenewalInterval === "none" ? (
            <div>
              <Label htmlFor="grants-duration">Grant duration (days)</Label>
              <Input
                id="grants-duration"
                inputMode="numeric"
                value={grantsDurationDays}
                disabled={busy || !effectiveGrantsTierId}
                placeholder="Blank = no expiry"
                onChange={(e) => setGrantsDurationDays(e.target.value)}
              />
              <p className="mt-1.5 text-xs leading-5 text-muted">
                Leave blank for lifetime access.
              </p>
            </div>
          ) : (
            <div className="rounded-[var(--radius-control)] border border-border bg-surface-elevated px-3 py-3 text-sm text-muted">
              Recurring memberships renew through Stripe on the merchant&apos;s account, so
              access length follows the billing interval rather than a fixed day count.
            </div>
          )}
        </div>
      </section>

      <div>
        <Label>Images</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            placeholder="https://…/image.jpg"
          />
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              const url = imageUrl.trim();
              if (!url) return;
              setImages((prev) => [...prev, url]);
              setImageUrl("");
            }}
          >
            Add URL
          </Button>
          <label className="inline-flex cursor-pointer items-center justify-center rounded-[var(--radius-control)] border border-border bg-surface px-4 py-2.5 text-sm font-medium hover:bg-hover-soft">
            Upload
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                setBusy(true);
                setError(null);
                try {
                  const { url } = await uploadProductImage(file);
                  setImages((prev) => [...prev, url]);
                } catch (err) {
                  setError(
                    err instanceof ApiClientError
                      ? err.message
                      : "Upload failed.",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            />
          </label>
        </div>
        {images.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {images.map((url) => (
              <li
                key={url}
                className="flex items-center justify-between gap-3 rounded-[var(--radius-control)] border border-border px-3 py-2 text-sm"
              >
                <span className="truncate text-muted">{url}</span>
                <Button
                  type="button"
                  variant="ghost"
                  className="shrink-0"
                  onClick={() =>
                    setImages((prev) => prev.filter((u) => u !== url))
                  }
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="rounded-[var(--radius-card)] border border-border bg-surface px-5">
        <Toggle
          label="Enabled"
          description="Disabled products are hidden from agents."
          checked={enabled}
          onChange={setEnabled}
          disabled={busy}
        />
      </div>

      <FieldError>{error}</FieldError>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : mode === "create" ? "Create product" : "Save changes"}
        </Button>
        {mode === "edit" && product ? (
          <>
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const copy = await duplicateProduct(product.slug, undefined, {
                    siteId: product.siteId,
                  });
                  router.push(
                    `/dashboard/products/${copy.slug}?siteId=${copy.siteId}`,
                  );
                } catch (err) {
                  setError(
                    err instanceof ApiClientError
                      ? err.message
                      : "Duplicate failed.",
                  );
                  setBusy(false);
                }
              }}
            >
              Duplicate
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="text-error-text"
              disabled={busy}
              onClick={() => setDeleteOpen(true)}
            >
              Delete
            </Button>
          </>
        ) : null}
      </div>

      {product ? (
        <ConfirmDialog
          open={deleteOpen}
          title="Delete this product?"
          description="It will also be removed from suggested products and add-ons elsewhere."
          confirmLabel="Delete"
          danger
          busy={busy}
          onClose={() => setDeleteOpen(false)}
          onConfirm={async () => {
            setBusy(true);
            try {
              await deleteProduct(product.slug, { siteId: product.siteId });
              router.push("/dashboard/catalog");
              router.refresh();
            } catch (err) {
              setError(
                err instanceof ApiClientError ? err.message : "Delete failed.",
              );
              setBusy(false);
              setDeleteOpen(false);
            }
          }}
        />
      ) : null}
    </form>
  );
}
