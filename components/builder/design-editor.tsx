"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Laptop, Monitor, Redo2, Smartphone, Tablet, Undo2 } from "lucide-react";
import { undoInvocation, type ActionOutcome } from "@/lib/api/actions";
import {
  addBlock,
  createDesignPage,
  createPreviewSession,
  customizeRegion,
  customizeTemplate,
  deleteDesignPage,
  deleteSavedBlock,
  discardDesignDraft,
  duplicateNode,
  getBlockRegistry,
  getDesign,
  getDesignPage,
  getDesignRevision,
  insertNodes,
  insertPreset,
  listSavedBlocks,
  moveNode,
  moveNodes,
  publishDesign,
  removeNodes,
  restoreDesignPage,
  restoreDesignVersion,
  saveBlock,
  setDesignTheme,
  setCustomCss,
  setHeadCode,
  setDesignTokens,
  setNodeBindings,
  setNodeCustomClass,
  setNodeProps,
  setNodeStyles,
  setNodeVisibility,
  startDesign,
  stopBrandAgent,
  updateDesignPage,
  type AgentLock,
  type BlockDescription,
  type BlockRegistry,
  type Breakpoint,
  type DesignSummary,
  type NodeInput,
  type PageNode,
  type PageDocument,
  type RegionHandle,
  type SavedBlock,
  type TemplateHandle,
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
import { BREAKPOINT_LABEL, Inspector, MultiInspector, type PickerData } from "./inspector";
import { LayerTree, type SelectMode } from "./layer-tree";
import { AddPanel, PagesPanel, SharedLayoutsPanel, ThemePanel } from "./panels";
import { BREAKPOINT_ORDER, docOrder, find, insertionPoint, nodeLabel, nodeScopes, outermost, planDuplicate, planPaste, toInput, type Move } from "./tree";

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

/** `400 VALIDATION_ERROR` with `details.problems` — custom CSS and head code. */
function validationProblems(error: unknown): string[] | null {
  if (!(error instanceof ApiClientError) || error.code !== "VALIDATION_ERROR") return null;
  const details = error.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const problems = (details as { problems?: unknown }).problems;
  if (!Array.isArray(problems) || problems.length === 0) return null;
  if (!problems.every((item) => typeof item === "string")) return null;
  return problems;
}

const POLL_MS = 2_000;
/** Re-mint the preview well before its two hours run out. */
const PREVIEW_REFRESH_MS = 90 * 60 * 1000;

type Tab = "agent" | "layers" | "add" | "pages" | "theme";
const TABS: Tab[] = ["agent", "layers", "add", "pages", "theme"];

/**
 * The preview follows the breakpoint being edited (M7), at that breakpoint's
 * **narrowest** width: styles are mobile-first, so a size shows every rule
 * from the sizes below it and none from above — an edit at "All screens" is
 * never hidden by a desktop override the merchant cannot see.
 */
const FRAME: Record<Breakpoint, { width: string; minWidth?: string; icon: typeof Monitor; short: string }> = {
  base: { width: "390px", icon: Smartphone, short: "All" },
  sm: { width: "640px", icon: Tablet, short: "640+" },
  md: { width: "768px", icon: Laptop, short: "768+" },
  lg: { width: "100%", minWidth: "1024px", icon: Monitor, short: "1024+" },
};

/** The clipboard survives a reload and reaches other tabs and stores (per browser, never the server). */
const CLIPBOARD_KEY = "markii.builder.clipboard.v1";
type Clip = { nodes: NodeInput[]; label: string };
function readClip(): Clip | null {
  try {
    const raw = window.localStorage.getItem(CLIPBOARD_KEY);
    const v = raw ? (JSON.parse(raw) as Clip) : null;
    return v && Array.isArray(v.nodes) && v.nodes.length && typeof v.label === "string" ? v : null;
  } catch {
    return null;
  }
}
function writeClip(clip: Clip) {
  try {
    window.localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(clip));
  } catch {
    // Storage blocked or full: the clipboard still works for this tab.
  }
}

type SaveState = "idle" | "saving" | "saved" | "error";

type Step = { actionId: string; invocationId: string };

export function DesignEditor({
  site,
  canEdit,
  canWriteScripts = false,
}: {
  site: { id: number; slug: string; name: string; storefrontUrl: string | null };
  canEdit: boolean;
  /** `cms.scripts` — may edit the storefront's custom scripts (M6). */
  canWriteScripts?: boolean;
}) {
  const [registry, setRegistry] = useState<BlockRegistry | null>(null);
  const [design, setDesign] = useState<DesignSummary | null>(null);
  const [pageId, setPageId] = useState<number | null>(null);
  const [page, setPage] = useState<PageDocument | null>(null);
  /** Selected node ids; the last is the primary one the inspector and the agent see (M7). */
  const [selection, setSelection] = useState<string[]>([]);
  const selectedId = selection[selection.length - 1] ?? null;
  const setSelectedId = useCallback((id: string | null) => setSelection(id ? [id] : []), []);
  const [breakpoint, setBreakpoint] = useState<Breakpoint>("base");
  // Read once, lazily: nothing renders the clipboard before the editor has loaded, so the server's null cannot mismatch.
  const [clip, setClip] = useState<Clip | null>(() => (typeof window === "undefined" ? null : readClip()));
  const [saved, setSaved] = useState<SavedBlock[] | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  /** One live region for the whole editor; `n` makes a repeated message announce again. */
  const [announcement, setAnnouncement] = useState({ text: "", n: 0 });
  const announce = useCallback((text: string) => setAnnouncement((a) => ({ text, n: a.n + 1 })), []);
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
  /**
   * The open document, written the moment it changes — not after a render.
   * Reads that resolve later (the revision poll, a write's refresh) check it,
   * so a request started for the home page cannot land after the merchant
   * opened a template and put the home tree back under the template's id.
   */
  const pageRef = useRef<number | null>(null);
  // Current values for callbacks that outlive a render: the agent's context getter and the preview's messages.
  const selectedRef = useRef(selectedId);
  const breakpointRef = useRef(breakpoint);
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
    const id = pageRef.current ?? d.pages.find((p) => p.handle === "home")?.id ?? d.pages[0]?.id ?? null;
    if (pageRef.current === null && id !== null) {
      pageRef.current = id;
      setPageId(id);
    }
    if (id === null) return;
    const doc = await getDesignPage(site.id, id);
    // Another document was opened while this was in flight: its own read wins.
    if (pageRef.current === id) setPage(doc);
  }, [site.id]);

  /**
   * Open one document of the draft — a page, template or region (M4). `path`
   * moves the preview there; null keeps it where it is (a region shows on
   * whatever page the merchant is looking at).
   */
  const openDocument = useCallback(
    async (id: number, path: string | null, selectNodeId: string | null = null) => {
      pageRef.current = id;
      setPageId(id);
      setSelectedId(selectNodeId);
      const doc = await getDesignPage(site.id, id);
      if (pageRef.current === id) setPage(doc);
      if (path !== null) reloadFrame(path);
    },
    [site.id, reloadFrame, setSelectedId],
  );

  const loadSaved = useCallback(async () => {
    try {
      setSaved((await listSavedBlocks(site.id)).items);
    } catch {
      setSaved([]);
    }
  }, [site.id]);

  useEffect(() => {
    let cancelled = false;
    listSavedBlocks(site.id).then(
      (r) => !cancelled && setSaved(r.items),
      () => !cancelled && setSaved([]),
    );
    return () => {
      cancelled = true;
    };
  }, [site.id]);

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
          pageRef.current = home?.id ?? null;
          setPageId(home?.id ?? null);
          if (home) {
            const doc = await getDesignPage(site.id, home.id);
            if (pageRef.current === home.id) setPage(doc);
          }
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

  // The preview reports clicks with the document they landed in: a header block while the home page is open.
  const openRef = useRef(openDocument);
  useEffect(() => {
    selectedRef.current = selectedId;
    breakpointRef.current = breakpoint;
    openRef.current = openDocument;
  });

  useEffect(() => {
    if (!preview) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== preview.origin) return;
      const d = e.data as { type?: string; nodeId?: string; docId?: string; path?: string };
      if (d?.type === "markii:select" && typeof d.nodeId === "string") {
        const docId = d.docId && /^\d+$/.test(d.docId) ? Number(d.docId) : null;
        if (docId !== null && docId !== pageRef.current) void openRef.current(docId, null, d.nodeId).catch(() => {});
        else setSelectedId(d.nodeId);
        // Selecting in the preview while chatting tells the agent what "this" is; stay on the chat.
        setTab((t) => (t === "agent" ? t : "layers"));
      }
      if (d?.type === "markii:location" && typeof d.path === "string" && d.path.startsWith(preview.basePath)) {
        pathRef.current = d.path.slice(preview.basePath.length).replace(/[?&]__r=\d+/, "").replace(/\?$/, "") || "/";
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [preview, setSelectedId]);

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
    async <T,>(
      fn: () => Promise<ActionOutcome<T>>,
      actionId: string,
      opts: { record?: boolean; onError?: (error: unknown) => void } = {},
    ): Promise<ActionOutcome<T> | null> => {
      setBusy(true);
      setError(null);
      setSaveState("saving");
      try {
        const out = await fn();
        setSaveState("saved");
        if (out.undoable && opts.record !== false) {
          setUndoStack((s) => [...s.slice(-49), { actionId, invocationId: out.invocationId }]);
          setRedoStack([]);
        }
        await refresh();
        reloadFrame();
        return out;
      } catch (e) {
        setSaveState("error");
        opts.onError?.(e);
        if (e instanceof ApiClientError && e.code === "AGENT_EDITING") {
          setLock((l) => ({ ...l, active: true }));
          setError("The brand agent is editing this design. Your change was not saved.");
        } else {
          const problems = validationProblems(e);
          setError(problems ? problems.join(" ") : publicErrorMessage(e, "That change could not be saved."));
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
      setSaveState("saved");
      announce("Undone.");
    } catch (e) {
      setError(publicErrorMessage(e, "That could not be undone."));
    } finally {
      setBusy(false);
    }
  }, [undoStack, refresh, reloadFrame, announce]);

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
      setSaveState("saved");
      announce("Redone.");
    } catch (e) {
      setError(publicErrorMessage(e, "That could not be redone."));
    } finally {
      setBusy(false);
    }
  }, [redoStack, refresh, reloadFrame, announce]);

  // ---------- the brand agent ----------

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
      const o = output as { status?: string; invocationId?: string; changes?: unknown[]; result?: { pageId?: number; created?: boolean } } | null;
      if (o?.status !== "applied" || !o.invocationId) return;
      // An edit that changed nothing has nothing to undo; stacking it would make Undo answer 409.
      if (!o.changes?.length) return;
      // The agent's edit is undoable from here like any other, once it hands the pen back.
      setUndoStack((st) => [...st.slice(-49), { actionId: toolName.replace("_", "."), invocationId: o.invocationId! }]);
      setRedoStack([]);
      // The agent started on a template or region: follow it there, so its next edits are the ones on screen.
      const opened = o.result?.created && o.result.pageId ? o.result.pageId : null;
      if (opened !== null) {
        void getDesign(site.id)
          .then((d) => {
            if (!d.started) return;
            setDesign(d);
            // A template moves the preview to a sample product or collection; a region shows where we are.
            const template = d.templates.find((x) => x.id === opened);
            return openDocument(opened, template ? template.previewPath : null);
          })
          .catch(() => {});
        return;
      }
      void refresh().then(() => reloadFrame(), () => {});
    },
    [refresh, reloadFrame, openDocument, site.id],
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

  // ---------- selections, clipboard, bulk edits (M7) ----------

  const tree = page?.tree ?? null;
  const sid = site.id;
  const pid = page?.id ?? 0;
  const label = useCallback((n: PageNode) => (registry ? nodeLabel(n, new Map(registry.blocks.map((b) => [b.type, b]))) : n.type), [registry]);

  const select = useCallback(
    (id: string, mode: SelectMode) => {
      setSelection((cur) => {
        if (mode === "toggle") return cur.includes(id) ? cur.filter((x) => x !== id) : [...cur.filter((x) => x !== tree?.id), id];
        if (mode === "range" && tree && cur.length) {
          const order = docOrder(tree).filter((x) => x !== tree.id);
          const a = order.indexOf(cur[cur.length - 1]);
          const b = order.indexOf(id);
          if (a < 0 || b < 0) return [id];
          const [lo, hi] = a < b ? [a, b] : [b, a];
          return [...order.slice(lo, hi + 1).filter((x) => x !== id), id];
        }
        return [id];
      });
    },
    [tree],
  );

  const copySelection = useCallback(
    (cut: boolean) => {
      if (!tree) return;
      const ids = outermost(tree, selection);
      if (!ids.length) return announce("Select a block to copy.");
      const nodes = ids.map((id) => find(tree, id)!.node);
      const next: Clip = { nodes: nodes.map(toInput), label: nodes.map(label).join(", ").slice(0, 120) };
      setClip(next);
      writeClip(next);
      if (!cut) return announce(ids.length === 1 ? `Copied ${label(nodes[0])}.` : `Copied ${ids.length} blocks.`);
      void run(() => removeNodes({ siteId: sid, pageId: pid, nodeIds: ids }), "builder.removeNodes").then((out) => {
        if (!out) return;
        setSelectedId(null);
        announce(ids.length === 1 ? `Cut ${label(nodes[0])}.` : `Cut ${ids.length} blocks.`);
      });
    },
    [tree, selection, label, announce, run, sid, pid, setSelectedId],
  );

  const pasteNodes = useCallback(
    async (nodes: NodeInput[], what: string) => {
      if (!tree || !registry) return;
      const blocks = new Map(registry.blocks.map((b) => [b.type, b]));
      const placements = planPaste(tree, selectedId, nodes, blocks);
      if (!placements) return setError(`${what} cannot go there. Select a section first.`);
      const out = await run(() => insertNodes({ siteId: sid, pageId: pid, placements }), "builder.insertNodes");
      const ids = out?.result?.inserted.map((i) => i.nodeId) ?? [];
      if (!ids.length) return;
      setSelection(ids);
      announce(`${what} added.`);
    },
    [tree, registry, selectedId, run, sid, pid, announce],
  );

  const paste = useCallback(() => {
    const current = readClip() ?? clip;
    if (!current) return announce("The clipboard is empty. Copy a block first.");
    void pasteNodes(current.nodes, current.nodes.length === 1 ? "Pasted block" : `${current.nodes.length} pasted blocks`);
  }, [clip, pasteNodes, announce]);

  const duplicateSelection = useCallback(async () => {
    if (!tree) return;
    const placements = planDuplicate(tree, selection);
    if (!placements.length) return;
    const out = await run(() => insertNodes({ siteId: sid, pageId: pid, placements }), "builder.insertNodes");
    const ids = out?.result?.inserted.map((i) => i.nodeId).reverse() ?? [];
    if (!ids.length) return;
    setSelection(ids);
    announce(ids.length === 1 ? "Duplicated." : `Duplicated ${ids.length} blocks.`);
  }, [tree, selection, run, sid, pid, announce]);

  const removeSelection = useCallback(async () => {
    if (!tree) return;
    const ids = outermost(tree, selection);
    if (!ids.length) return;
    const what = ids.length === 1 ? label(find(tree, ids[0])!.node) : `${ids.length} blocks`;
    if (await run(() => removeNodes({ siteId: sid, pageId: pid, nodeIds: ids }), "builder.removeNodes")) {
      setSelectedId(null);
      announce(`Deleted ${what}. Undo with Ctrl+Z.`);
    }
  }, [tree, selection, label, run, sid, pid, setSelectedId, announce]);

  const moveMany = useCallback(
    async (moves: Move[]) => Boolean(await run(() => moveNodes({ siteId: sid, pageId: pid, moves }), "builder.moveNodes")),
    [run, sid, pid],
  );

  const saveSelectedBlock = useCallback(
    async (name: string): Promise<true | string> => {
      if (!tree || !selectedId) return "Select a block to save.";
      const hit = find(tree, selectedId);
      if (!hit?.parent) return "The page itself cannot be saved as a block.";
      // The library is not the design: saving is not a step on the undo stack.
      let refusal = "That block could not be saved.";
      const out = await run(() => saveBlock({ siteId: sid, name, node: toInput(hit.node) }), "builder.saveBlock", {
        record: false,
        onError: (error) => {
          refusal = publicErrorMessage(error, refusal);
        },
      });
      if (!out) return refusal;
      await loadSaved();
      announce(`Saved "${name}" to your saved blocks.`);
      return true;
    },
    [tree, selectedId, run, sid, loadSaved, announce],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      // Copying a block is not an edit, so it works while read-only — but never steal a copy of selected text.
      if (mod && key === "c" && !e.shiftKey) {
        if (window.getSelection()?.toString()) return;
        if (!selection.length) return;
        e.preventDefault();
        copySelection(false);
        return;
      }
      if (key === "escape" && selection.length && !document.querySelector("[role=dialog]")) {
        setSelectedId(null);
        announce("Selection cleared.");
        return;
      }
      if (readOnly || busy) return;
      if (mod && key === "z") {
        e.preventDefault();
        void (e.shiftKey ? redo() : undo());
      } else if (mod && key === "y") {
        e.preventDefault();
        void redo();
      } else if (mod && key === "x" && selection.length) {
        if (window.getSelection()?.toString()) return;
        e.preventDefault();
        copySelection(true);
      } else if (mod && key === "v") {
        e.preventDefault();
        paste();
      } else if (mod && key === "d" && selection.length) {
        e.preventDefault();
        void duplicateSelection();
      } else if ((key === "delete" || key === "backspace") && selection.length && !mod) {
        e.preventDefault();
        void removeSelection();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [undo, redo, readOnly, busy, selection, copySelection, paste, duplicateSelection, removeSelection, setSelectedId, announce]);

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

  const selected = tree ? find(tree, selectedId)?.node ?? null : null;
  const multi = tree ? outermost(tree, selection) : [];

  const add = async (type: string, preset?: string) => {
    if (!tree) return;
    const at = insertionPoint(tree, selectedId, preset ? "section" : type, blocks);
    if (!at) return setError(`A ${blocks.get(type)?.label ?? type} cannot go there. Select a section first.`);
    const out = preset
      ? await run(() => insertPreset({ siteId: sid, pageId: pid, ...at, preset }), "builder.insertPreset")
      : await run(() => addBlock({ siteId: sid, pageId: pid, ...at, type }), "builder.addBlock");
    const nodeId = (out?.result as { nodeId?: string } | undefined)?.nodeId;
    if (nodeId) {
      setSelectedId(nodeId);
      announce(`${preset ? registry.presets.find((x) => x.id === preset)?.label ?? "Section" : blocks.get(type)?.label ?? type} added.`);
    }
  };

  const saveText =
    saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved to draft" : saveState === "error" ? "Last change not saved" : null;

  return (
    <div className="flex h-[calc(100dvh-8rem)] min-h-[600px] flex-col overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface">
      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">{site.name}</p>
          <p className="text-xs text-muted">
            {saveText ? <span className={saveState === "error" ? "text-error-text" : undefined}>{saveText} · </span> : null}
            {started.hasUnpublishedChanges ? "Unpublished changes" : started.publishedVersion ? `Live: version ${started.publishedVersion}` : "Not published yet"}
          </p>
        </div>
        <div className="flex items-center gap-0.5 rounded-[var(--radius-control)] border border-border p-0.5" role="group" aria-label="Screen size: what the preview shows and which styles you edit">
          {BREAKPOINT_ORDER.map((bp) => {
            const Icon = FRAME[bp].icon;
            return (
              <button
                key={bp}
                type="button"
                aria-label={`${BREAKPOINT_LABEL[bp]} — preview at ${FRAME[bp].minWidth ?? FRAME[bp].width} wide`}
                title={BREAKPOINT_LABEL[bp]}
                aria-pressed={breakpoint === bp}
                onClick={() => setBreakpoint(bp)}
                className={`flex items-center gap-1 rounded px-1.5 py-1 text-xs ${breakpoint === bp ? "bg-brand/10 text-foreground" : "text-muted hover:bg-hover"}`}
              >
                <Icon aria-hidden className="h-4 w-4" />
                <span aria-hidden>{FRAME[bp].short}</span>
              </button>
            );
          })}
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
          <div
            className="flex border-b border-border"
            role="tablist"
            aria-label="Editor tools"
            onKeyDown={(e) => {
              const i = TABS.indexOf(tab);
              const next =
                e.key === "ArrowRight" ? TABS[(i + 1) % TABS.length]
                : e.key === "ArrowLeft" ? TABS[(i - 1 + TABS.length) % TABS.length]
                : e.key === "Home" ? TABS[0]
                : e.key === "End" ? TABS[TABS.length - 1]
                : null;
              if (!next) return;
              e.preventDefault();
              setTab(next);
              document.getElementById(`editor-tab-${next}`)?.focus();
            }}
          >
            {TABS.map((t) => (
              <button
                key={t}
                id={`editor-tab-${t}`}
                type="button"
                role="tab"
                aria-selected={tab === t}
                aria-controls="editor-tabpanel"
                tabIndex={tab === t ? 0 : -1}
                onClick={() => setTab(t)}
                className={`flex-1 px-2 py-2 text-xs font-medium capitalize ${tab === t ? "border-b-2 border-brand text-foreground" : "text-muted hover:text-foreground"}`}
              >
                {t}
              </button>
            ))}
          </div>
          <div id="editor-tabpanel" className="min-h-0 flex-1 overflow-y-auto" role="tabpanel" aria-labelledby={`editor-tab-${tab}`}>
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
                selection={selection}
                onSelect={select}
                announce={announce}
                disabled={readOnly || busy}
                onMove={async (nodeId, parentId, index) =>
                  Boolean(await run(() => moveNode({ siteId: sid, pageId: pid, nodeId, parentId, index }), "builder.moveNode"))
                }
                onMoveMany={moveMany}
              />
            ) : null}
            {tab === "add" ? (
              <AddPanel
                registry={registry}
                disabled={readOnly || busy || !tree}
                onAddBlock={(t) => void add(t)}
                onAddPreset={(p) => void add("section", p)}
                clipboard={clip ? { count: clip.nodes.length, label: clip.label } : null}
                onPaste={paste}
                saved={saved}
                onInsertSaved={(b) => void pasteNodes([b.node], `Saved block "${b.name}"`)}
                onDeleteSaved={async (b) => {
                  if (!(await run(() => deleteSavedBlock(sid, b.id), "builder.deleteSavedBlock", { record: false }))) return;
                  await loadSaved();
                  announce(`Deleted saved block "${b.name}". Pages that use it keep their copy.`);
                }}
              />
            ) : null}
            {tab === "pages" ? (
              <>
              <PagesPanel
                pages={started.pages}
                currentId={pageId}
                currentSeo={page?.seo ?? {}}
                disabled={readOnly || busy}
                onOpen={(id) => void openDocument(id, started.pages.find((x) => x.id === id)?.path ?? "/")}
                onCreate={async (handle, title) => {
                  const out = await run(() => createDesignPage(sid, handle, title), "builder.createPage");
                  const newId = (out?.result as { pageId?: number } | undefined)?.pageId;
                  if (newId) await openDocument(newId, `/pages/${handle}`);
                  return Boolean(out);
                }}
                onRename={(id, patch) => void run(() => updateDesignPage({ siteId: sid, pageId: id, ...patch }), "builder.updatePage")}
                onDelete={(id) => void run(() => deleteDesignPage(sid, id), "builder.deletePage")}
                onRestore={(id) => void run(() => restoreDesignPage(sid, id), "builder.restorePage")}
              />
              <SharedLayoutsPanel
                templates={started.templates}
                regions={started.regions}
                currentId={pageId}
                disabled={readOnly || busy}
                onOpen={(d) => void openDocument(d.id, started.templates.some((t) => t.handle === d.handle) ? d.previewPath : null)}
                onCustomize={async (kind, handle) => {
                  const out =
                    kind === "template"
                      ? await run(() => customizeTemplate(sid, handle as TemplateHandle), "builder.customizeTemplate")
                      : await run(() => customizeRegion(sid, handle as RegionHandle), "builder.customizeRegion");
                  const id = out?.result?.pageId;
                  if (!id) return;
                  const preview = kind === "template" ? started.templates.find((t) => t.handle === handle)?.previewPath ?? null : null;
                  await openDocument(id, preview);
                }}
                onReset={async (id) => {
                  if (!(await run(() => deleteDesignPage(sid, id), "builder.deletePage"))) return;
                  // The reset document is gone from the draft; go back to the home page.
                  const home = started.pages.find((p) => p.handle === "home");
                  if (id === pageId && home) await openDocument(home.id, null);
                }}
                onRestore={async (id) => {
                  if (!(await run(() => restoreDesignPage(sid, id), "builder.restorePage"))) return;
                  // Back in the draft: open it, as Customize does.
                  const template = started.templates.find((t) => t.id === id);
                  await openDocument(id, template ? template.previewPath : null);
                }}
              />
              </>
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
                customCss={started.customCss}
                canWriteCode={canEdit}
                onCustomCss={async (css) => {
                  let problems: string[] = [];
                  const out = await run(() => setCustomCss(sid, css), "builder.setCustomCss", {
                    onError: (error) => {
                      problems = validationProblems(error) ?? [];
                    },
                  });
                  return out ? [] : problems;
                }}
                headHtml={started.headHtml}
                canWriteScripts={canEdit && canWriteScripts}
                onHeadCode={async (html) => {
                  const out = await run(() => setHeadCode(sid, html), "builder.setHeadCode");
                  return out ? (out.result?.removed ?? []) : null;
                }}
              />
            ) : null}
          </div>
        </aside>

        {/* Preview */}
        <section className="flex min-h-0 overflow-auto bg-hover p-3" aria-label="Live preview">
          {frameSrc ? (
            <iframe
              ref={frameRef}
              title={`Preview of ${site.name}`}
              src={frameSrc}
              onLoad={() => highlight(false)}
              // Its own origin; allow-same-origin gives it *that* origin, never the dashboard's.
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              className="mx-auto h-full shrink-0 rounded border border-border bg-white shadow-[var(--shadow-sm)]"
              style={{ width: FRAME[breakpoint].width, minWidth: FRAME[breakpoint].minWidth }}
            />
          ) : (
            <p className="self-center text-sm text-muted">Preparing the preview…</p>
          )}
        </section>

        {/* Inspector */}
        <aside className="min-h-0 overflow-y-auto border-l border-border" aria-label="Inspector">
          {multi.length > 1 && tree ? (
            <MultiInspector
              labels={multi.map((id) => label(find(tree, id)!.node))}
              disabled={readOnly || busy}
              onDuplicate={() => void duplicateSelection()}
              onCopy={() => copySelection(false)}
              onRemove={() => void removeSelection()}
              onClear={() => setSelectedId(null)}
            />
          ) : (
          <Inspector
            node={selected}
            block={selected ? blocks.get(selected.type) : undefined}
            breakpoint={breakpoint}
            onBreakpoint={setBreakpoint}
            disabled={readOnly || busy}
            data={pickers}
            paths={registry.data}
            scopes={nodeScopes(page ? { kind: page.kind, handle: page.handle } : null, tree, selected?.id ?? null)}
            onBindings={(bindings) =>
              selected && void run(() => setNodeBindings({ siteId: sid, pageId: pid, nodeId: selected.id, bindings }), "builder.setBinding")
            }
            onVisibility={(when) =>
              selected && void run(() => setNodeVisibility({ siteId: sid, pageId: pid, nodeId: selected.id, when }), "builder.setVisibility")
            }
            onProps={(props, unset) =>
              selected && void run(() => setNodeProps({ siteId: sid, pageId: pid, nodeId: selected.id, props, unset }), "builder.setProps")
            }
            onStyles={(styles) =>
              selected && void run(() => setNodeStyles({ siteId: sid, pageId: pid, nodeId: selected.id, breakpoint, styles }), "builder.setStyles")
            }
            onCustomClass={(customClass) =>
              selected && void run(() => setNodeCustomClass({ siteId: sid, pageId: pid, nodeId: selected.id, customClass }), "builder.setCustomClass")
            }
            onIntent={(intent) =>
              selected && void run(() => setNodeProps({ siteId: sid, pageId: pid, nodeId: selected.id, props: {}, intent }), "builder.setProps")
            }
            onDuplicate={async () => {
              if (!selected) return;
              const out = await run(() => duplicateNode({ siteId: sid, pageId: pid, nodeId: selected.id }), "builder.duplicateNode");
              const nodeId = (out?.result as { nodeId?: string } | undefined)?.nodeId;
              if (nodeId) {
                setSelectedId(nodeId);
                announce("Duplicated.");
              }
            }}
            onRemove={() => void removeSelection()}
            onCopy={() => copySelection(false)}
            onSaveBlock={saveSelectedBlock}
          />
          )}
        </aside>
      </div>

      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement.text}
        {announcement.n % 2 ? "\u00a0" : ""}
      </p>

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
