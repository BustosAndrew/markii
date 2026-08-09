"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  createCollection,
  setCollectionProducts,
  type Collection,
} from "@/lib/api/commerce";
import { ApiClientError, type Site } from "@/lib/api/types";
import { Button } from "@/components/ui/button";
import { FieldError, Input, Label, Select, Textarea } from "@/components/ui/field";
import { Toggle } from "@/components/ui/toggle";

export function CollectionForm({ sites }: { sites: Site[] }) {
  const router = useRouter();
  const [siteId, setSiteId] = useState(String(sites[0]?.id ?? ""));
  const [title, setTitle] = useState("");
  const [handle, setHandle] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<Collection["type"]>("manual");
  const [published, setPublished] = useState(false);
  const [productIds, setProductIds] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!siteId || !title.trim()) {
      setError("Site and title are required.");
      return;
    }

    setBusy(true);
    try {
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

      const collection = created.result;

      if (type === "manual" && productIds.trim()) {
        const ids = productIds
          .split(/[,\s]+/)
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isInteger(n) && n > 0);

        if (ids.length > 0) {
          const outcome = await setCollectionProducts({
            collectionId: collection.id,
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

      {type === "manual" ? (
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
          description="Published collections appear on the storefront."
          checked={published}
          onChange={setPublished}
          disabled={busy}
        />
      </div>

      <FieldError>{error}</FieldError>

      <Button type="submit" disabled={busy}>
        {busy ? "Creating…" : "Create collection"}
      </Button>
    </form>
  );
}
