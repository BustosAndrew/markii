"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  createCollection,
  setCollectionProducts,
  updateCollection,
  type Collection,
} from "@/lib/api/commerce";
import { ApiClientError, type Site } from "@/lib/api/types";
import { Button } from "@/components/ui/button";
import { FieldError, Input, Label, Select, Textarea } from "@/components/ui/field";
import { Toggle } from "@/components/ui/toggle";

export function CollectionForm({ sites, collection }: { sites: Site[]; collection?: Collection }) {
  const router = useRouter();
  const editing = Boolean(collection);
  const [siteId, setSiteId] = useState(
    String(collection?.storeId ?? (collection as Collection & { siteId?: number })?.siteId ?? sites[0]?.id ?? ""),
  );
  const [title, setTitle] = useState(collection?.title ?? "");
  const [handle, setHandle] = useState(collection?.handle ?? "");
  const [description, setDescription] = useState(collection?.description ?? "");
  const [type, setType] = useState<Collection["type"]>(collection?.type ?? "manual");
  const [published, setPublished] = useState(collection?.publishedAt != null);
  const [productIds, setProductIds] = useState("");
  const [redirectOldLink, setRedirectOldLink] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const handleChanged = editing && collection && handle.trim() !== collection.handle;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!siteId || !title.trim()) {
      setError("Site and title are required.");
      return;
    }

    setBusy(true);
    try {
      if (editing && collection) {
        const out = await updateCollection({
          collectionId: collection.id,
          title: title.trim(),
          handle: handle.trim() || undefined,
          description: description.trim() || null,
          published,
          redirectOldLink: handleChanged ? redirectOldLink : undefined,
        });
        if (!out.ok) {
          setError("Collection could not be saved.");
          return;
        }
        router.push("/dashboard/catalog?tab=collections");
        router.refresh();
        return;
      }
      const created = await createCollection({
        siteId: Number(siteId),
        title: title.trim(),
        handle: handle.trim() || undefined,
        description: description.trim() || null,
        type,
        published,
      });

      if (!created.ok || !created.result) {
        setError("Collection could not be created.");
        return;
      }

      const createdCollection = created.result;

      if (type === "manual" && productIds.trim()) {
        const ids = productIds
          .split(/[,\s]+/)
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isInteger(n) && n > 0);

        if (ids.length > 0) {
          const outcome = await setCollectionProducts({
            collectionId: createdCollection.id,
            productIds: ids,
          });
          if (!outcome.ok) {
            setError(
              "Collection was created but product membership could not be set.",
            );
            return;
          }
        }
      }

      router.push("/dashboard/catalog?tab=collections");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Create failed.");
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
          onChange={(e) => setSiteId(e.target.value)}
          required
          disabled={editing}
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
          <Label htmlFor="title">Title</Label>
          <Input
            id="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
          />
        </div>
        <div>
          <Label htmlFor="handle">Handle</Label>
          <Input
            id="handle"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="auto from title"
            className="font-mono"
          />
          {handleChanged ? (
            <label className="mt-2 flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={redirectOldLink}
                onChange={(e) => setRedirectOldLink(e.target.checked)}
              />
              Send the old link here
            </label>
          ) : null}
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
        <Label htmlFor="type">Type</Label>
        <Select
          id="type"
          value={type}
          onChange={(e) => setType(e.target.value as Collection["type"])}
          disabled={editing}
        >
          <option value="manual">Manual — you choose products</option>
          <option value="automated">Automated — rule-based</option>
        </Select>
        {type === "automated" ? (
          <p className="mt-1 text-xs text-muted">
            Rule configuration is not on this screen yet. Create as automated and
            configure rules via the API.
          </p>
        ) : null}
      </div>

      {type === "manual" && !editing ? (
        <div>
          <Label htmlFor="product-ids">Product IDs (optional)</Label>
          <Input
            id="product-ids"
            value={productIds}
            onChange={(e) => setProductIds(e.target.value)}
            placeholder="1, 2, 3"
            className="font-mono"
          />
          <p className="mt-1 text-xs text-muted">
            Comma-separated product IDs to add after creation.
          </p>
        </div>
      ) : null}

      <div className="rounded-[var(--radius-card)] border border-border bg-surface px-5">
        <Toggle
          label="Published"
          description="Published collections appear on /collections and in the storefront header. Hidden ones stay in this list only."
          checked={published}
          onChange={setPublished}
          disabled={busy}
        />
      </div>

      <FieldError>{error}</FieldError>

      <Button type="submit" disabled={busy}>
        {busy ? "Saving…" : editing ? "Save" : "Create collection"}
      </Button>
    </form>
  );
}
