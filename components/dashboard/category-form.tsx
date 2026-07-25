"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  createCategory,
  deleteCategory,
  duplicateCategory,
  updateCategory,
} from "@/lib/api/categories";
import { ApiClientError, type Category, type Site } from "@/lib/api/types";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FieldError, Input, Label, Select, Textarea } from "@/components/ui/field";
import { Toggle } from "@/components/ui/toggle";

export function CategoryForm({
  mode,
  category,
  sites,
  categories,
}: {
  mode: "create" | "edit";
  category?: Category;
  sites: Site[];
  categories: Category[];
}) {
  const router = useRouter();
  const [siteId, setSiteId] = useState(
    String(category?.siteId ?? sites[0]?.id ?? ""),
  );
  const [name, setName] = useState(category?.name ?? "");
  const [slug, setSlug] = useState(category?.slug ?? "");
  const [description, setDescription] = useState(category?.description ?? "");
  const [parentId, setParentId] = useState(
    category?.parentId != null ? String(category.parentId) : "",
  );
  const [imageUrl, setImageUrl] = useState(category?.imageUrl ?? "");
  const [enabled, setEnabled] = useState(category?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const parentOptions = useMemo(
    () =>
      categories.filter(
        (c) =>
          String(c.siteId) === siteId &&
          (!category || c.id !== category.id),
      ),
    [categories, siteId, category],
  );

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!siteId || !name.trim()) {
      setError("Site and name are required.");
      return;
    }
    setBusy(true);
    try {
      const body = {
        siteId: Number(siteId),
        name: name.trim(),
        slug: slug.trim() || undefined,
        description: description.trim() || null,
        parentId: parentId ? Number(parentId) : null,
        imageUrl: imageUrl.trim() || null,
        enabled,
      };
      if (mode === "create") {
        const created = await createCategory(body);
        router.push(
          `/dashboard/categories/${created.slug}?siteId=${created.siteId}`,
        );
      } else if (category) {
        const updated = await updateCategory(category.slug, body, {
          siteId: category.siteId,
        });
        if (updated.slug !== category.slug) {
          router.replace(
            `/dashboard/categories/${updated.slug}?siteId=${updated.siteId}`,
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
            setParentId("");
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
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div>
        <Label htmlFor="parent">Parent category</Label>
        <Select
          id="parent"
          value={parentId}
          onChange={(e) => setParentId(e.target.value)}
        >
          <option value="">Top-level</option>
          {parentOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>

      <div>
        <Label htmlFor="image">Image URL</Label>
        <Input
          id="image"
          value={imageUrl}
          onChange={(e) => setImageUrl(e.target.value)}
          placeholder="https://…"
        />
      </div>

      <div className="rounded-[var(--radius-card)] border border-border bg-surface px-5">
        <Toggle
          label="Enabled"
          description="Disabled categories are hidden from storefronts."
          checked={enabled}
          onChange={setEnabled}
          disabled={busy}
        />
      </div>

      <FieldError>{error}</FieldError>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>
          {busy
            ? "Saving…"
            : mode === "create"
              ? "Create category"
              : "Save changes"}
        </Button>
        {mode === "edit" && category ? (
          <>
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const copy = await duplicateCategory(category.slug, undefined, {
                    siteId: category.siteId,
                  });
                  router.push(
                    `/dashboard/categories/${copy.slug}?siteId=${copy.siteId}`,
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

      {category ? (
        <ConfirmDialog
          open={deleteOpen}
          title="Delete this category?"
          description="Products become uncategorized. Child categories are promoted to top-level."
          confirmLabel="Delete"
          danger
          busy={busy}
          onClose={() => setDeleteOpen(false)}
          onConfirm={async () => {
            setBusy(true);
            try {
              await deleteCategory(category.slug, { siteId: category.siteId });
              router.push("/dashboard/categories");
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
