"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { updateCollection, type Collection } from "@/lib/api/commerce";
import { publicErrorMessage } from "@/lib/api/public-copy";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * Catalog collections list. Storefront pages exist now, so publish/hide is a
 * real switch — a hidden collection stays in this list only.
 */
export function CollectionsTable({
  items,
  canPublish,
}: {
  items: Collection[];
  canPublish: boolean;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function setPublished(collection: Collection, published: boolean) {
    setBusyId(collection.id);
    setError(null);
    try {
      const out = await updateCollection({ collectionId: collection.id, published });
      if (!out.ok) {
        setError("Visibility could not be updated.");
        return;
      }
      router.refresh();
    } catch (err) {
      setError(publicErrorMessage(err, "Visibility could not be updated."));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      {error ? <p className="mb-3 text-sm text-error-text">{error}</p> : null}
      <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface shadow-[var(--shadow-sm)]">
        <table className="w-full min-w-[40rem] text-left text-sm">
          <thead className="text-muted">
            <tr className="border-b border-border">
              <th className="px-4 py-3 font-medium">Collection</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">Products</th>
              <th className="px-4 py-3 font-medium">Visibility</th>
              {canPublish ? <th className="px-4 py-3 font-medium" /> : null}
            </tr>
          </thead>
          <tbody>
            {items.map((c) => {
              const onStorefront = c.publishedAt != null;
              return (
                <tr key={c.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-3">
                    <div className="font-medium text-foreground">{c.title}</div>
                    <div className="text-xs text-muted">{c.handle}</div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={c.type === "automated" ? "info" : "neutral"}>
                      {c.type === "automated" ? "Rule-based" : "Manual"}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 tabular-nums text-foreground">{c.productCount}</td>
                  <td className="px-4 py-3 text-muted">
                    {onStorefront ? "On the storefront" : "Hidden"}
                  </td>
                  {canPublish ? (
                    <td className="px-4 py-3 text-right">
                      <Button
                        variant="secondary"
                        disabled={busyId !== null}
                        onClick={() => void setPublished(c, !onStorefront)}
                      >
                        {busyId === c.id
                          ? "Saving…"
                          : onStorefront
                            ? "Hide"
                            : "Publish"}
                      </Button>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
