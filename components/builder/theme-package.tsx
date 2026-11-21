"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  copyDesign,
  createThemeUpload,
  exportNextApp,
  exportTheme,
  getDesign,
  importThemeUpload,
  type DesignApplyResult,
  type ImageReport,
} from "@/lib/api/builder";
import { publicErrorMessage } from "@/lib/api/public-copy";
import { listSites } from "@/lib/api/sites";
import { ApiClientError } from "@/lib/api/types";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FieldError, Label, Select } from "@/components/ui/field";

function conflictReason(error: unknown): string | undefined {
  if (!(error instanceof ApiClientError) || error.code !== "CONFLICT") return undefined;
  if (!error.details || typeof error.details !== "object" || Array.isArray(error.details)) {
    return undefined;
  }
  const reason = (error.details as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : undefined;
}

function openDownload(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

function ImageWarnings({ images }: { images: ImageReport }) {
  if (images.external.length === 0 && images.unreadable.length === 0) return null;
  return (
    <ul className="space-y-1 rounded-[var(--radius-control)] border border-warning-border bg-warning-bg p-3 text-xs text-warning-text">
      {images.external.map((img) => (
        <li key={`ext-${img.where}-${img.url}`}>
          Left as a link (hosted elsewhere): {img.where}
        </li>
      ))}
      {images.unreadable.map((img) => (
        <li key={`unr-${img.where}-${img.url}`}>
          Could not read this store&rsquo;s file; left as a link: {img.where}
        </li>
      ))}
    </ul>
  );
}

function ApplyNotes({
  result,
  extra,
}: {
  result: DesignApplyResult;
  extra?: string | null;
}) {
  return (
    <div className="space-y-2 rounded-[var(--radius-control)] border border-border bg-surface-elevated p-3 text-sm text-foreground" role="status">
      <p>
        {result.documents} document{result.documents === 1 ? "" : "s"} in the draft.
        Nothing is live until you publish.
      </p>
      {result.savedBlocks.skipped.length > 0 ? (
        <p className="text-xs text-muted">
          Saved blocks not added:{" "}
          {result.savedBlocks.skipped
            .map((s) => `${s.name} (${s.reason === "limit" ? "library full" : "name already used"})`)
            .join(", ")}
        </p>
      ) : null}
      {extra ? <p className="text-xs text-muted">{extra}</p> : null}
    </div>
  );
}

/**
 * Copy a design between stores, export/import a theme file, and download the
 * storefront as a Next.js app (D53). Lives on the Theme tab — export is
 * `cms.read`, copy and import replace the draft and need `cms.write`.
 */
export function ThemePackagePanel({
  siteId,
  canEdit,
  disabled,
  onReplaced,
  onCopyScripts,
}: {
  siteId: number;
  canEdit: boolean;
  disabled: boolean;
  onReplaced: () => Promise<void>;
  onCopyScripts: (html: string) => Promise<boolean>;
}) {
  const [stores, setStores] = useState<{ id: number; name: string }[]>([]);
  const [storesError, setStoresError] = useState<string | null>(null);
  const [fromSiteId, setFromSiteId] = useState<string>("");
  const [copySource, setCopySource] = useState<"published" | "draft">("published");
  const [themeSource, setThemeSource] = useState<"draft" | "published">("draft");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<ReactNode>(null);
  /**
   * The source store's custom scripts, offered after a copy. The API exposes a
   * store's **draft** scripts only, so `draftDiffersFromLive` says when that is
   * not what its shoppers run — the merchant may have chosen "published".
   */
  const [pendingScripts, setPendingScripts] = useState<null | {
    html: string;
    fromName: string;
    draftDiffersFromLive: boolean;
    askedForPublished: boolean;
  }>(null);
  /**
   * The scripts under review before `setHeadCode` replaces this store's own.
   * `current` is read fresh when the review opens: saving replaces them whole.
   */
  const [scriptsReview, setScriptsReview] = useState<null | { current: string }>(null);
  const [discard, setDiscard] = useState<null | { kind: "copy" | "import"; run: () => Promise<void> }>(null);
  const [importPreview, setImportPreview] = useState<null | {
    uploadId: string;
    result: DesignApplyResult;
    images: ImageReport;
    discardUnpublished: boolean;
  }>(null);

  useEffect(() => {
    let cancelled = false;
    listSites({ limit: 100, sort: "name" }).then(
      (r) => {
        if (cancelled) return;
        setStoresError(null);
        setStores(r.items.filter((s) => s.id !== siteId).map((s) => ({ id: s.id, name: s.name })));
      },
      (err) => {
        if (cancelled) return;
        setStores([]);
        // Not "no other stores" — that would state a fact the failed read never established.
        setStoresError(publicErrorMessage(err, "Your other stores could not be loaded."));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [siteId]);

  async function withBusy(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(publicErrorMessage(err, "That did not work."));
    } finally {
      setBusy(null);
    }
  }

  async function doCopy(opts: { source: "published" | "draft"; discardUnpublished: boolean }) {
    const from = Number(fromSiteId);
    if (!Number.isFinite(from)) {
      setError("Pick a store to copy from.");
      return;
    }
    try {
      const out = await copyDesign({
        siteId,
        fromSiteId: from,
        source: opts.source,
        discardUnpublished: opts.discardUnpublished,
      });
      const result = out.result;
      if (!result) {
        setError("The copy did not return a result.");
        return;
      }
      await onReplaced();
      setCopySource(opts.source);
      setPendingScripts(null);
      setScriptsReview(null);
      if (result.sourceHasHeadCode) {
        try {
          const source = await getDesign(from);
          if (source.started && source.headHtml) {
            setPendingScripts({
              html: source.headHtml,
              fromName: stores.find((s) => s.id === from)?.name ?? "the other store",
              draftDiffersFromLive: source.headHtmlChanged,
              askedForPublished: opts.source === "published",
            });
          }
        } catch {
          // The copy already landed; scripts can still be pasted by hand.
        }
      }
      setNotice(
        <ApplyNotes
          result={result}
          extra={
            result.sourceHasHeadCode
              ? "Custom scripts were not copied — they never travel with a design."
              : null
          }
        />,
      );
    } catch (err) {
      const reason = conflictReason(err);
      if (reason === "unpublished_changes") {
        setDiscard({
          kind: "copy",
          run: () => doCopy({ source: opts.source, discardUnpublished: true }),
        });
        return;
      }
      if (reason === "nothing_published") {
        setCopySource("draft");
        setError("That store has not published a design yet. Copy its draft instead.");
        return;
      }
      setError(publicErrorMessage(err, "Could not copy that design."));
    }
  }

  async function doExportTheme() {
    await withBusy("theme-export", async () => {
      try {
        const exported = await exportTheme(siteId, themeSource);
        openDownload(exported.url);
        setNotice(
          <div className="space-y-2 text-sm text-foreground">
            <p>
              Theme file is downloading. The link lasts five minutes — do not save it.
              {exported.headCodeLeftOut
                ? " Custom scripts are not in the file; they stay on this store."
                : ""}
            </p>
            <ImageWarnings images={exported.images} />
          </div>,
        );
      } catch (err) {
        if (conflictReason(err) === "nothing_published") {
          setThemeSource("draft");
          setError("Nothing is published yet. Export the draft instead.");
          return;
        }
        throw err;
      }
    });
  }

  async function doExportNext() {
    await withBusy("next-export", async () => {
      const exported = await exportNextApp(siteId);
      openDownload(exported.url);
      setNotice(
        <div className="space-y-2 text-sm text-foreground">
          <p>
            Your store as a Next.js app you host yourself. It reads your catalogue and design live
            from Markii and checks out here. Shopper sign-in is yours to add — see the README
            inside. Members-only products need a storefront key.
          </p>
          {exported.storeLive ? null : (
            <p className="text-warning-text">
              This store is not live, so the exported app will show nothing until you publish and
              unpause it. The download is still valid.
            </p>
          )}
        </div>,
      );
    });
  }

  async function uploadThemeFile(file: File) {
    setImportPreview(null);
    await withBusy("theme-upload", async () => {
      const slot = await createThemeUpload(siteId);
      const put = await fetch(slot.uploadUrl, {
        method: slot.method,
        headers: slot.headers,
        body: file,
      });
      if (!put.ok) {
        setError("The theme file could not be uploaded. Try again.");
        return;
      }
      try {
        const preview = await importThemeUpload(siteId, slot.uploadId, { dryRun: true });
        if (!preview.result) {
          setError("The file could not be read as a theme package.");
          return;
        }
        setImportPreview({
          uploadId: slot.uploadId,
          result: preview.result,
          images: preview.images,
          discardUnpublished: false,
        });
      } catch (err) {
        if (conflictReason(err) === "unpublished_changes") {
          setImportPreview(null);
          setDiscard({
            kind: "import",
            run: async () => {
              const preview = await importThemeUpload(siteId, slot.uploadId, {
                dryRun: true,
                discardUnpublished: true,
              });
              if (!preview.result) {
                setError("The file could not be read as a theme package.");
                return;
              }
              setImportPreview({
                uploadId: slot.uploadId,
                result: preview.result,
                images: preview.images,
                discardUnpublished: true,
              });
            },
          });
          return;
        }
        throw err;
      }
    });
  }

  async function commitImport(discardUnpublished: boolean) {
    const pending = importPreview;
    if (!pending) return;
    await withBusy("theme-import", async () => {
      try {
        const imported = await importThemeUpload(siteId, pending.uploadId, { discardUnpublished });
        if (!imported.result) {
          setError("Import did not apply.");
          return;
        }
        setImportPreview(null);
        await onReplaced();
        setNotice(
          <div className="space-y-2">
            <ApplyNotes result={imported.result} extra="Custom scripts are never in a theme file." />
            <ImageWarnings images={imported.images} />
          </div>,
        );
      } catch (err) {
        if (conflictReason(err) === "unpublished_changes") {
          setDiscard({
            kind: "import",
            run: () => commitImport(true),
          });
          return;
        }
        throw err;
      }
    });
  }

  const locked = disabled || busy !== null;

  return (
    <div className="space-y-5 border-t border-border p-3">
      <section className="space-y-3" aria-label="Move a design">
        <h3 className="text-sm font-semibold text-foreground">Move a design</h3>
        <p className="text-xs text-muted">
          Copy from another of your stores, or export and import a theme file. Both replace this
          draft only — shoppers see nothing until you publish. Custom scripts never travel.
        </p>

        {canEdit ? (
          <div className="space-y-2">
            <Label htmlFor="th-copy-from">Copy from another store</Label>
            {storesError ? (
              <FieldError>{storesError}</FieldError>
            ) : stores.length === 0 ? (
              <p className="text-xs text-muted">No other stores in reach to copy from.</p>
            ) : (
              <>
                <Select
                  id="th-copy-from"
                  value={fromSiteId}
                  disabled={locked}
                  onChange={(e) => setFromSiteId(e.target.value)}
                >
                  <option value="">Choose a store</option>
                  {stores.map((s) => (
                    <option key={s.id} value={String(s.id)}>
                      {s.name}
                    </option>
                  ))}
                </Select>
                <Select
                  id="th-copy-source"
                  aria-label="Copy published or draft"
                  value={copySource}
                  disabled={locked}
                  onChange={(e) => setCopySource(e.target.value as "published" | "draft")}
                >
                  <option value="published">What shoppers see (published)</option>
                  <option value="draft">That store&rsquo;s draft</option>
                </Select>
                <Button
                  variant="secondary"
                  disabled={locked || fromSiteId === ""}
                  onClick={() => void withBusy("copy", () => doCopy({ source: copySource, discardUnpublished: false }))}
                >
                  {busy === "copy" ? "Copying…" : "Copy into this draft"}
                </Button>
              </>
            )}
            {pendingScripts && !scriptsReview ? (
              <Button
                variant="secondary"
                disabled={locked}
                onClick={() =>
                  void withBusy("scripts-review", async () => {
                    // Read this store's scripts now, not at copy time: saving replaces them whole.
                    const here = await getDesign(siteId);
                    setScriptsReview({ current: here.started ? here.headHtml : "" });
                  })
                }
              >
                {busy === "scripts-review" ? "Loading scripts…" : "Review scripts to copy…"}
              </Button>
            ) : null}
            {pendingScripts && scriptsReview ? (
              <div
                className="space-y-3 rounded-[var(--radius-control)] border border-border p-3"
                role="region"
                aria-label="Review custom scripts"
              >
                <p className="text-sm text-foreground">
                  Custom scripts from {pendingScripts.fromName}. They run on every storefront page
                  except the cart and account once you publish.
                </p>
                {pendingScripts.askedForPublished && pendingScripts.draftDiffersFromLive ? (
                  <p className="text-xs text-warning-text">
                    These are that store&rsquo;s draft scripts, which differ from what its shoppers
                    run now. Its live scripts cannot be copied from here.
                  </p>
                ) : pendingScripts.draftDiffersFromLive ? null : (
                  <p className="text-xs text-muted">These are the scripts that store runs live.</p>
                )}
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-elevated p-2 font-mono text-xs text-foreground">
                  {pendingScripts.html}
                </pre>
                {scriptsReview.current ? (
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-warning-text">
                      This replaces this store&rsquo;s own custom scripts, which are removed:
                    </p>
                    <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded border border-warning-border bg-warning-bg p-2 font-mono text-xs text-warning-text">
                      {scriptsReview.current}
                    </pre>
                  </div>
                ) : (
                  <p className="text-xs text-muted">This store has no custom scripts of its own.</p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={locked}
                    onClick={() =>
                      void withBusy("scripts", async () => {
                        const ok = await onCopyScripts(pendingScripts.html);
                        if (ok) {
                          setPendingScripts(null);
                          setScriptsReview(null);
                        }
                      })
                    }
                  >
                    {busy === "scripts"
                      ? "Copying scripts…"
                      : scriptsReview.current
                        ? "Replace this store’s scripts"
                        : "Copy scripts"}
                  </Button>
                  <Button variant="ghost" disabled={locked} onClick={() => setScriptsReview(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-muted">Copying or importing a design needs an owner, administrator or developer.</p>
        )}

        <div className="space-y-2">
          <Label htmlFor="th-theme-source">Export theme</Label>
          <Select
            id="th-theme-source"
            value={themeSource}
            disabled={locked}
            onChange={(e) => setThemeSource(e.target.value as "draft" | "published")}
          >
            <option value="draft">Draft</option>
            <option value="published">Published</option>
          </Select>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" disabled={locked} onClick={() => void doExportTheme()}>
              {busy === "theme-export" ? "Exporting…" : "Export theme"}
            </Button>
            {canEdit ? (
              <label className="inline-flex cursor-pointer items-center">
                <input
                  type="file"
                  accept="application/json,.json"
                  className="peer sr-only"
                  disabled={locked}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) void uploadThemeFile(file);
                  }}
                />
                {/* The focused element is the hidden input, so its focus ring is drawn on this span. */}
                <span className={`inline-flex items-center justify-center rounded-[var(--radius-control)] border border-border bg-surface px-4 py-2.5 text-sm font-medium text-foreground hover:bg-hover peer-focus-visible:ring-4 peer-focus-visible:ring-brand/10 peer-focus-visible:border-brand ${locked ? "pointer-events-none opacity-50" : ""}`}>
                  {busy === "theme-upload" ? "Reading file…" : "Import theme…"}
                </span>
              </label>
            ) : null}
          </div>
        </div>

        {importPreview ? (
          <div className="space-y-2 rounded-[var(--radius-control)] border border-border p-3">
            <p className="text-sm text-foreground">
              Import will replace this draft with {importPreview.result.documents} document
              {importPreview.result.documents === 1 ? "" : "s"}. Shoppers see nothing until you
              publish.
            </p>
            <ImageWarnings images={importPreview.images} />
            <Button disabled={locked} onClick={() => void commitImport(importPreview.discardUnpublished)}>
              {busy === "theme-import" ? "Importing…" : "Import into draft"}
            </Button>
          </div>
        ) : null}
      </section>

      <section className="space-y-3" aria-label="Next.js export">
        <h3 className="text-sm font-semibold text-foreground">Host it yourself</h3>
        <p className="text-xs text-muted">
          Download this storefront as a Next.js app. It reads your catalogue and design live from
          Markii and checks out on this store. Members-only products need a storefront key on the
          website&rsquo;s settings.
        </p>
        <Button variant="secondary" disabled={locked} onClick={() => void doExportNext()}>
          {busy === "next-export" ? "Preparing…" : "Export Next.js app"}
        </Button>
      </section>

      {notice}
      {error ? <FieldError>{error}</FieldError> : null}

      <ConfirmDialog
        open={discard !== null}
        danger
        busy={busy !== null}
        title="Replace unpublished changes?"
        description="Your unpublished changes on this store will be replaced. Shoppers still see the live design until you publish."
        confirmLabel="Replace draft"
        onClose={() => setDiscard(null)}
        onConfirm={() => {
          const next = discard;
          setDiscard(null);
          if (next) void withBusy(next.kind, next.run);
        }}
      />
    </div>
  );
}
