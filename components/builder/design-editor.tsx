"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Monitor, Redo2, Smartphone, Tablet, Undo2 } from "lucide-react";
import { undoInvocation, type ActionOutcome } from "@/lib/api/actions";
import {
  addBlock,
  createDesignPage,
  createPreviewSession,
  deleteDesignPage,
  discardDesignDraft,
  duplicateNode,
  getBlockRegistry,
  getDesign,
  getDesignPage,
  getDesignRevision,
  insertPreset,
  moveNode,
  publishDesign,
  removeNodes,
  restoreDesignPage,
  restoreDesignVersion,
  setDesignTheme,
  setDesignTokens,
  setNodeProps,
  setNodeStyles,
  startDesign,
  stopBrandAgent,
  updateDesignPage,
  type AgentLock,
  type BlockDescription,
  type BlockRegistry,
  type Breakpoint,
  type DesignSummary,
  type PageDocument,
} from "@/lib/api/builder";
import { listCategories } from "@/lib/api/categories";
import { listCollections } from "@/lib/api/commerce";
import { listProducts } from "@/lib/api/products";
import { publicErrorMessage } from "@/lib/api/public-copy";
import { ApiClientError } from "@/lib/api/types";
import { Button, ButtonLink } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { BrandChat } from "./brand-chat";
import { HistoryDialog, PublishDialog } from "./dialogs";
import { Inspector, type PickerData } from "./inspector";
import { LayerTree } from "./layer-tree";
import { AddPanel, PagesPanel, ThemePanel } from "./panels";
import { find, insertionPoint } from "./tree";

/**
 * The site editor (`docs/BUILDER.md` §11, D51 M2): the page's layers and
 * library on the left, **the real storefront rendering the draft** in the
 * middle, the inspector on the right.
 *
 * **It holds no copy of the design it edits.** Every change is a registry
 * action; afterwards the editor re-reads the page and reloads the preview. So
 * an edit made anywhere else — another tab, an MCP client, the brand agent —
 * appears the same way: the revision moves, the editor notices on its next
 * poll, and re-reads. There is one source of truth and it is the server.
 *
 * **While the brand agent works, this is read-only** (owner, 2026-10-31): the
 * server refuses every other writer with `AGENT_EDITING`, and the editor says
 * so up front rather than letting the merchant type into a field that will be
 * refused. Stop — in the chat or the banner — hands the pen back.
 *
 * The brand agent's chat is the Agent tab (M3). Its edits land on this
 * editor's undo stack like the merchant's own, so "undo what the agent just
 * did" is the same button.
 */

const POLL_MS = 2_000;
/** Re-mint the preview well before its two hours run out. */
const PREVIEW_REFRESH_MS = 90 * 60 * 1000;

type Tab = "agent" | "layers" | "add" | "pages" | "theme";
type Viewport = "desktop" | "tablet" | "phone";
const VIEWPORT_WIDTH: Record<Viewport, string> = { desktop: "100%", tablet: "768px", phone: "390px" };

type Step = { actionId: string; invocationId: string };

export function DesignEditor({
  site,
  canEdit,
}: {
  site: { id: number; slug: string; name: string; storefrontUrl: string | null };
  canEdit: boolean;
}) {
  const [registry, setRegistry] = useState<BlockRegistry | null>(null);
  const [design, setDesign] = useState<DesignSummary | null>(null);
  const [pageId, setPageId] = useState<number | null>(null);
  const [page, setPage] = useState<PageDocument | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [breakpoint, setBreakpoint] = useState<Breakpoint>("base");
  const [viewport, setViewport] = useState<Viewport>("desktop");
  const [tab, setTab] = useState<Tab>("agent");
  const [preview, setPreview] = useState<{ url: string; origin: string; basePath: string } | null>(null);
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [lock, setLock] = useState<AgentLock>({ active: false, sessionId: null, expiresAt: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [undoStack, setUndoStack] = useState<Step[]>([]);
  const [redoStack, setRedoStack] = useState<Step[]>([]);
  const [dialog, setDialog] = useState<"publish" | "history" | null>(null);
  const [pickers, setPickers] = useState<PickerData>({ products: [], categories: [], collections: [] });
  /** This tab's chat is mid-turn. The lease says the same a poll later; this closes that gap. */
  const [agentBusy, setAgentBusy] = useState(false);
  const [stopSignal, setStopSignal] = useState(0);

  const frameRef = useRef<HTMLIFrameElement>(null);
  const revisionRef = useRef<number>(-1);
  const pathRef = useRef<string>("/");
  const nonceRef = useRef(0);

  const blocks = useMemo(() => new Map<string, BlockDescription>((registry?.blocks ?? []).map((b) => [b.type, b])), [registry]);
  const readOnly = !canEdit || lock.active || agentBusy;
  const started = design?.started === true ? design : null;

  // ---------- loading ----------

  const reloadFrame = useCallback(
    (path = pathRef.current) => {
      if (!preview) return;
      pathRef.current = path;
      nonceRef.current += 1;
      const target = `${preview.url}${path === "/" ? "" : path}`;
      setFrameSrc(`${target}${target.includes("?") ? "&" : "?"}__r=${nonceRef.current}`);
    },
    [preview],
  );

  const refresh = useCallback(async () => {
    const d = await getDesign(site.id);
    setDesign(d);
    if (!d.started) return;
    revisionRef.current = d.revision;
    setLock(d.agentLock);
    const id = pageId ?? d.pages.find((p) => p.handle === "home")?.id ?? d.pages[0]?.id ?? null;
    if (id !== pageId) setPageId(id);
    if (id !== null) setPage(await getDesignPage(site.id, id));
  }, [site.id, pageId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const reg = await getBlockRegistry();
        let d = await getDesign(site.id);
        if (!d.started && canEdit) {
          await startDesign(site.id);
          d = await getDesign(site.id);
        }
        if (cancelled) return;
        setRegistry(reg);
        setDesign(d);
        if (d.started) {
          revisionRef.current = d.revision;
          setLock(d.agentLock);
          const home = d.pages.find((p) => p.handle === "home") ?? d.pages[0];
          setPageId(home?.id ?? null);
          if (home) setPage(await getDesignPage(site.id, home.id));
          const minted = await createPreviewSession(site.id);
          const u = new URL(minted.url);
          if (!cancelled) setPreview({ url: minted.url, origin: u.origin, basePath: u.pathname });
        }
      } catch (e) {
        if (!cancelled) setLoadError(publicErrorMessage(e, "The editor could not load this site's design."));
      }
    })();
    // The pickers are a convenience: a failure leaves free-text fields, not a broken editor.
    Promise.all([
      listProducts({ siteId: site.id, limit: 100 }).catch(() => null),
      listCategories({ siteId: site.id, limit: 100 }).catch(() => null),
      listCollections({ siteId: site.id, limit: 100 }).catch(() => null),
    ]).then(([p, c, k]) => {
      if (cancelled) return;
      setPickers({
        products: (p?.items ?? []).filter((x) => x.enabled).map((x) => ({ slug: x.slug, name: x.name, images: x.images })),
        categories: (c?.items ?? []).map((x) => ({ slug: x.slug, name: x.name })),
        collections: (k?.items ?? []).map((x) => ({ handle: x.handle, title: x.title })),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [site.id, canEdit]);

  // First frame once the preview exists, and a fresh session before the old one lapses.
  useEffect(() => {
    if (!preview) return;
    reloadFrame("/");
    const t = setTimeout(async () => {
      try {
        const minted = await createPreviewSession(site.id);
        const u = new URL(minted.url);
        setPreview({ url: minted.url, origin: u.origin, basePath: u.pathname });
      } catch {
        setError("The preview session could not be renewed. Reload the page to continue.");
      }
    }, PREVIEW_REFRESH_MS);
    return () => clearTimeout(t);
    // reloadFrame is stable per preview.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview]);

  // Any change anywhere — this tab, another, MCP, the agent — moves the revision.
  useEffect(() => {
    if (!started) return;
    const t = setInterval(async () => {
      try {
        const r = await getDesignRevision(site.id);
        setLock(r.agentLock);
        if (r.revision !== revisionRef.current) {
          revisionRef.current = r.revision;
          await refresh();
          reloadFrame();
        }
      } catch {
        // A missed poll is retried on the next tick.
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [started, site.id, refresh, reloadFrame]);

  // ---------- the preview frame ----------

  useEffect(() => {
    if (!preview) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== preview.origin) return;
      const d = e.data as { type?: string; nodeId?: string; path?: string };
      if (d?.type === "markii:select" && typeof d.nodeId === "string") {
        setSelectedId(d.nodeId);
        // Selecting in the preview while chatting tells the agent what "this" is; stay on the chat.
        setTab((t) => (t === "agent" ? t : "layers"));
      }
      if (d?.type === "markii:location" && typeof d.path === "string" && d.path.startsWith(preview.basePath)) {
        pathRef.current = d.path.slice(preview.basePath.length).replace(/[?&]__r=\d+/, "").replace(/\?$/, "") || "/";
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [preview]);

  const highlight = useCallback(
    (scroll: boolean) => {
      if (!preview) return;
      frameRef.current?.contentWindow?.postMessage({ type: "markii:highlight", nodeId: selectedId, scroll }, preview.origin);
    },
    [preview, selectedId],
  );
  useEffect(() => highlight(true), [highlight]);

  // ---------- writing ----------

  const run = useCallback(
    async <T,>(fn: () => Promise<ActionOutcome<T>>, actionId: string, opts: { record?: boolean } = {}): Promise<ActionOutcome<T> | null> => {
      setBusy(true);
      setError(null);
      try {
        const out = await fn();
        if (out.undoable && opts.record !== false) {
          setUndoStack((s) => [...s.slice(-49), { actionId, invocationId: out.invocationId }]);
          setRedoStack([]);
        }
        await refresh();
        reloadFrame();
        return out;
      } catch (e) {
        if (e instanceof ApiClientError && e.code === "AGENT_EDITING") {
          setLock((l) => ({ ...l, active: true }));
          setError("The brand agent is editing this design. Your change was not saved.");
        } else {
          setError(publicErrorMessage(e, "That change could not be saved."));
        }
        return null;
      } finally {
        setBusy(false);
      }
    },
    [refresh, reloadFrame],
  );

  const undo = useCallback(async () => {
    const step = undoStack[undoStack.length - 1];
    if (!step) return;
    setBusy(true);
    setError(null);
    try {
      const out = await undoInvocation(step.actionId, step.invocationId);
      setUndoStack((s) => s.slice(0, -1));
      setRedoStack((s) => [...s, { actionId: out.undoneWith, invocationId: out.invocationId }]);
      await refresh();
      reloadFrame();
    } catch (e) {
      setError(publicErrorMessage(e, "That could not be undone."));
    } finally {
      setBusy(false);
    }
  }, [undoStack, refresh, reloadFrame]);

  const redo = useCallback(async () => {
    const step = redoStack[redoStack.length - 1];
    if (!step) return;
    setBusy(true);
    setError(null);
    try {
      const out = await undoInvocation(step.actionId, step.invocationId);
      setRedoStack((s) => s.slice(0, -1));
      setUndoStack((s) => [...s, { actionId: out.undoneWith, invocationId: out.invocationId }]);
      await refresh();
      reloadFrame();
    } catch (e) {
      setError(publicErrorMessage(e, "That could not be redone."));
    } finally {
      setBusy(false);
    }
  }, [redoStack, refresh, reloadFrame]);

  // ---------- the brand agent ----------

  const selectedRef = useRef(selectedId);
  const pageRef = useRef(pageId);
  const breakpointRef = useRef(breakpoint);
  useEffect(() => {
    selectedRef.current = selectedId;
    pageRef.current = pageId;
    breakpointRef.current = breakpoint;
  });
  /** Read when a message is sent, so it says where the merchant is at that moment. */
  const agentContext = useCallback(
    () => ({
      siteId: site.id,
      ...(pageRef.current ? { pageId: pageRef.current } : {}),
      selectedNodeId: selectedRef.current,
      breakpoint: breakpointRef.current,
      path: pathRef.current,
    }),
    [site.id],
  );

  const onAgentTool = useCallback(
    (toolName: string, output: unknown) => {
      if (!toolName.startsWith("builder_")) return;
      const o = output as { status?: string; invocationId?: string; changes?: unknown[] } | null;
      if (o?.status !== "applied" || !o.invocationId) return;
      // An edit that changed nothing has nothing to undo; stacking it would make Undo answer 409.
      if (!o.changes?.length) return;
      // The agent's edit is undoable from here like any other, once it hands the pen back.
      setUndoStack((st) => [...st.slice(-49), { actionId: toolName.replace("_", "."), invocationId: o.invocationId! }]);
      setRedoStack([]);
      void refresh().then(() => reloadFrame(), () => {});
    },
    [refresh, reloadFrame],
  );

  const stopAgent = useCallback(async () => {
    try {
      await stopBrandAgent(site.id);
      setLock({ active: false, sessionId: null, expiresAt: null });
    } catch (e) {
      setError(publicErrorMessage(e, "The agent could not be stopped. Try again."));
    }
  }, [site.id]);

  const onAgentBusy = useCallback(
    (b: boolean) => {
      setAgentBusy(b);
      // The turn just ended: pick up its last edits and the released lease without waiting for a poll.
      if (!b) void refresh().then(() => reloadFrame(), () => {});
    },
    [refresh, reloadFrame],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (readOnly || busy) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        void (e.shiftKey ? redo() : undo());
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [undo, redo, readOnly, busy]);

  // ---------- render ----------

  if (loadError) return <ErrorState title="Editor unavailable" message={loadError} />;
  if (!registry || !design) return <p className="p-6 text-sm text-muted">Loading the editor…</p>;
  if (!started) {
    return (
      <p className="p-6 text-sm text-muted">
        This site has no design yet, and your role cannot start one. Ask an owner, administrator or developer.
      </p>
    );
  }

  const tree = page?.tree ?? null;
  const selected = tree ? find(tree, selectedId)?.node ?? null : null;
  const sid = site.id;
  const pid = page?.id ?? 0;

  const add = async (type: string, preset?: string) => {
    if (!tree) return;
    const at = insertionPoint(tree, selectedId, preset ? "section" : type, blocks);
    if (!at) return setError(`A ${blocks.get(type)?.label ?? type} cannot go there. Select a section first.`);
    const out = preset
      ? await run(() => insertPreset({ siteId: sid, pageId: pid, ...at, preset }), "builder.insertPreset")
      : await run(() => addBlock({ siteId: sid, pageId: pid, ...at, type }), "builder.addBlock");
    const nodeId = (out?.result as { nodeId?: string } | undefined)?.nodeId;
    if (nodeId) setSelectedId(nodeId);
  };

  return (
    <div className="flex h-[calc(100dvh-8rem)] min-h-[600px] flex-col overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface">
      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">{site.name}</p>
          <p className="text-xs text-muted">
            {started.hasUnpublishedChanges ? "Unpublished changes" : started.publishedVersion ? `Live: version ${started.publishedVersion}` : "Not published yet"}
          </p>
        </div>
        <div className="flex items-center gap-0.5 rounded-[var(--radius-control)] border border-border p-0.5" role="group" aria-label="Preview width">
          {(
            [
              ["desktop", Monitor, "Desktop"],
              ["tablet", Tablet, "Tablet"],
              ["phone", Smartphone, "Phone"],
            ] as const
          ).map(([v, Icon, label]) => (
            <button
              key={v}
              type="button"
              aria-label={label}
              aria-pressed={viewport === v}
              onClick={() => setViewport(v)}
              className={`rounded p-1.5 ${viewport === v ? "bg-brand/10 text-foreground" : "text-muted hover:bg-hover"}`}
            >
              <Icon className="h-4 w-4" />
            </button>
          ))}
        </div>
        <Button variant="ghost" aria-label="Undo" disabled={readOnly || busy || undoStack.length === 0} onClick={() => void undo()}>
          <Undo2 className="h-4 w-4" />
        </Button>
        <Button variant="ghost" aria-label="Redo" disabled={readOnly || busy || redoStack.length === 0} onClick={() => void redo()}>
          <Redo2 className="h-4 w-4" />
        </Button>
        <Button variant="secondary" onClick={() => setDialog("history")}>
          History
        </Button>
        {site.storefrontUrl ? (
          <ButtonLink variant="secondary" href={site.storefrontUrl} target="_blank" rel="noopener noreferrer">
            View live
          </ButtonLink>
        ) : null}
        <Button disabled={readOnly || busy} onClick={() => setDialog("publish")}>
          Publish
        </Button>
      </div>

      {lock.active || agentBusy ? (
        <div className="flex items-center justify-between gap-3 border-b border-warning-border bg-warning-bg px-3 py-2 text-sm text-warning-text" role="status">
          <span>The brand agent is editing this design — the preview updates as it works. Stop it to make your own changes.</span>
          {canEdit ? (
            <Button
              variant="secondary"
              className="shrink-0 px-2.5 py-1 text-xs"
              onClick={() => {
                setStopSignal((n) => n + 1);
                void stopAgent();
              }}
            >
              Stop agent
            </Button>
          ) : null}
        </div>
      ) : null}
      {!canEdit ? (
        <div className="border-b border-border bg-hover px-3 py-2 text-sm text-muted" role="status">
          You can view this design but not change it. Editing needs an owner, administrator or developer role.
        </div>
      ) : null}
      {error ? (
        <div className="flex items-center justify-between gap-3 border-b border-border bg-error-bg px-3 py-2 text-sm text-error-text" role="alert">
          <span>{error}</span>
          <button type="button" className="underline" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      <div
        className={`grid min-h-0 flex-1 ${tab === "agent" ? "grid-cols-[360px_minmax(0,1fr)_300px]" : "grid-cols-[280px_minmax(0,1fr)_320px]"}`}
      >
        {/* Left */}
        <aside className="flex min-h-0 flex-col border-r border-border" aria-label="Editor tools">
          <div className="flex border-b border-border" role="tablist">
            {(["agent", "layers", "add", "pages", "theme"] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`flex-1 px-2 py-2 text-xs font-medium capitalize ${tab === t ? "border-b-2 border-brand text-foreground" : "text-muted hover:text-foreground"}`}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto" role="tabpanel">
            {/* Kept mounted so a reply keeps streaming while the merchant looks at another tab. */}
            <div hidden={tab !== "agent"}>
              <BrandChat
                siteId={sid}
                canEdit={canEdit}
                context={agentContext}
                onToolResult={onAgentTool}
                onStop={stopAgent}
                onBusyChange={onAgentBusy}
                stopSignal={stopSignal}
              />
            </div>
            {tab === "layers" && tree ? (
              <LayerTree
                root={tree}
                registry={blocks}
                selectedId={selectedId}
                onSelect={setSelectedId}
                disabled={readOnly || busy}
                onMove={async (nodeId, parentId, index) =>
                  Boolean(await run(() => moveNode({ siteId: sid, pageId: pid, nodeId, parentId, index }), "builder.moveNode"))
                }
              />
            ) : null}
            {tab === "add" ? (
              <AddPanel registry={registry} disabled={readOnly || busy || !tree} onAddBlock={(t) => void add(t)} onAddPreset={(p) => void add("section", p)} />
            ) : null}
            {tab === "pages" ? (
              <PagesPanel
                pages={started.pages}
                currentId={pageId}
                currentSeo={page?.seo ?? {}}
                disabled={readOnly || busy}
                onOpen={(id) => {
                  setPageId(id);
                  setSelectedId(null);
                  const p = started.pages.find((x) => x.id === id);
                  void getDesignPage(sid, id).then(setPage);
                  reloadFrame(p?.path ?? "/");
                }}
                onCreate={async (handle, title) => {
                  const out = await run(() => createDesignPage(sid, handle, title), "builder.createPage");
                  const newId = (out?.result as { pageId?: number } | undefined)?.pageId;
                  if (newId) {
                    setPageId(newId);
                    setPage(await getDesignPage(sid, newId));
                    reloadFrame(`/pages/${handle}`);
                  }
                  return Boolean(out);
                }}
                onRename={(id, patch) => void run(() => updateDesignPage({ siteId: sid, pageId: id, ...patch }), "builder.updatePage")}
                onDelete={(id) => void run(() => deleteDesignPage(sid, id), "builder.deletePage")}
                onRestore={(id) => void run(() => restoreDesignPage(sid, id), "builder.restorePage")}
              />
            ) : null}
            {tab === "theme" ? (
              <ThemePanel
                themeId={started.themeId}
                tokens={started.tokens}
                contrast={started.contrast}
                registry={registry}
                disabled={readOnly || busy}
                onTheme={(id) => void run(() => setDesignTheme(sid, id), "builder.setTheme")}
                onTokens={(patch) => void run(() => setDesignTokens(sid, patch), "builder.setThemeTokens")}
              />
            ) : null}
          </div>
        </aside>

        {/* Preview */}
        <section className="flex min-h-0 justify-center overflow-auto bg-hover p-3" aria-label="Live preview">
          {frameSrc ? (
            <iframe
              ref={frameRef}
              title={`Preview of ${site.name}`}
              src={frameSrc}
              onLoad={() => highlight(false)}
              // Its own origin; allow-same-origin gives it *that* origin, never the dashboard's.
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              className="h-full rounded border border-border bg-white shadow-[var(--shadow-sm)]"
              style={{ width: VIEWPORT_WIDTH[viewport], maxWidth: "100%" }}
            />
          ) : (
            <p className="self-center text-sm text-muted">Preparing the preview…</p>
          )}
        </section>

        {/* Inspector */}
        <aside className="min-h-0 overflow-y-auto border-l border-border" aria-label="Inspector">
          <Inspector
            node={selected}
            block={selected ? blocks.get(selected.type) : undefined}
            breakpoint={breakpoint}
            onBreakpoint={setBreakpoint}
            disabled={readOnly || busy}
            data={pickers}
            onProps={(props, unset) =>
              selected && void run(() => setNodeProps({ siteId: sid, pageId: pid, nodeId: selected.id, props, unset }), "builder.setProps")
            }
            onStyles={(styles) =>
              selected && void run(() => setNodeStyles({ siteId: sid, pageId: pid, nodeId: selected.id, breakpoint, styles }), "builder.setStyles")
            }
            onIntent={(intent) =>
              selected && void run(() => setNodeProps({ siteId: sid, pageId: pid, nodeId: selected.id, props: {}, intent }), "builder.setProps")
            }
            onDuplicate={async () => {
              if (!selected) return;
              const out = await run(() => duplicateNode({ siteId: sid, pageId: pid, nodeId: selected.id }), "builder.duplicateNode");
              const nodeId = (out?.result as { nodeId?: string } | undefined)?.nodeId;
              if (nodeId) setSelectedId(nodeId);
            }}
            onRemove={async () => {
              if (!selected) return;
              if (await run(() => removeNodes({ siteId: sid, pageId: pid, nodeIds: [selected.id] }), "builder.removeNodes")) setSelectedId(null);
            }}
          />
        </aside>
      </div>

      <PublishDialog
        open={dialog === "publish"}
        site={sid}
        hasUnpublishedChanges={started.hasUnpublishedChanges}
        onClose={() => setDialog(null)}
        onPublish={async (note) => Boolean(await run(() => publishDesign(sid, note || undefined), "builder.publish", { record: false }))}
        onDiscard={async () => {
          const ok = Boolean(await run(() => discardDesignDraft(sid), "builder.discardDraft", { record: false }));
          if (ok) {
            setUndoStack([]);
            setRedoStack([]);
          }
          return ok;
        }}
      />
      <HistoryDialog
        open={dialog === "history"}
        site={sid}
        onClose={() => setDialog(null)}
        onRestore={async (version) => {
          const ok = Boolean(await run(() => restoreDesignVersion(sid, version), "builder.restoreVersion", { record: false }));
          if (ok) {
            setUndoStack([]);
            setRedoStack([]);
          }
          return ok;
        }}
      />
    </div>
  );
}
