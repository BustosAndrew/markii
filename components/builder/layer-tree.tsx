"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import type { BlockDescription, PageNode } from "@/lib/api/builder";
import { accepts, contains, docOrder, find, nodeLabel, outermost, planBulkMove, planGroupStep, type Move } from "./tree";

export type SelectMode = "replace" | "toggle" | "range";

/**
 * The layer tree (`docs/BUILDER.md` §11): the page's structure as a list,
 * where selection, reordering and nesting happen.
 *
 * **Every drag has a keyboard equivalent**, which BUILDER.md makes a launch
 * requirement rather than a follow-up. The tree is **one tab stop** (a roving
 * tabindex, as a WAI-ARIA tree should be): ↑/↓ move between layers and select,
 * Home/End jump, Shift+↑/↓ extend the selection, Ctrl/⌘+Space or Ctrl/⌘+click
 * toggle one layer, Shift+click selects a range. Alt+↑/↓ moves the selection
 * among its siblings — several layers move together when they share a parent —
 * Alt+→ nests one into the block above, Alt+← moves it out. Every move is
 * announced. The keyboard path and the agent's path are the same registry
 * actions, `builder.moveNode` and `builder.moveNodes`.
 */
export function LayerTree({
  root,
  registry,
  selection,
  onSelect,
  onMove,
  onMoveMany,
  announce,
  disabled,
}: {
  root: PageNode;
  registry: Map<string, BlockDescription>;
  /** Selected node ids; the last is the primary one the inspector shows. */
  selection: string[];
  onSelect: (id: string, mode: SelectMode) => void;
  onMove: (nodeId: string, parentId: string, index: number) => Promise<boolean>;
  onMoveMany: (moves: Move[]) => Promise<boolean>;
  announce: (message: string) => void;
  disabled: boolean;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  /** The layer to focus once the refreshed tree arrives after a move — a note to the effect, never a render. */
  const refocus = useRef<string | null>(null);
  const primary = selection[selection.length - 1] ?? null;
  const order = docOrder(root);
  const focusable = primary && order.includes(primary) ? primary : root.id;

  // The tree re-renders from the refreshed page after a move; keep the keyboard on the moved layer.
  useEffect(() => {
    if (!refocus.current) return;
    document.querySelector<HTMLButtonElement>(`[data-layer="${refocus.current}"]`)?.focus();
    refocus.current = null;
  }, [root]);

  const focusRow = (id: string) => {
    document.querySelector<HTMLButtonElement>(`[data-layer="${id}"]`)?.focus();
  };

  /**
   * Set the note *before* the move: the editor re-reads the page inside the
   * move, so the new tree can arrive before the await returns. Whatever is
   * still noted afterwards — a move that changed nothing — is focused here.
   */
  const settle = (ok: boolean, said: string, focusId: string) => {
    if (ok) announce(said);
    if (refocus.current === focusId) {
      refocus.current = null;
      if (ok) focusRow(focusId);
    }
  };

  const move = async (nodeId: string, parentId: string, index: number, said: string) => {
    refocus.current = nodeId;
    settle(await onMove(nodeId, parentId, index), said, nodeId);
  };

  const moveMany = async (moves: Move[] | null, said: string, focusId: string) => {
    if (!moves) return announce("Those layers cannot move there.");
    refocus.current = focusId;
    settle(await onMoveMany(moves), said, focusId);
  };

  const group = outermost(root, selection);

  const onKey = (e: React.KeyboardEvent, node: PageNode) => {
    const i = order.indexOf(node.id);
    const mod = e.ctrlKey || e.metaKey;
    // Navigation, never blocked by read-only: looking around is always allowed.
    if (!e.altKey) {
      let next: string | null = null;
      if (e.key === "ArrowDown") next = order[Math.min(order.length - 1, i + 1)];
      else if (e.key === "ArrowUp") next = order[Math.max(0, i - 1)];
      else if (e.key === "Home") next = order[0];
      else if (e.key === "End") next = order[order.length - 1];
      if (next) {
        e.preventDefault();
        onSelect(next, e.shiftKey && next !== root.id ? "range" : "replace");
        focusRow(next);
        return;
      }
      if (e.key === " " && mod && node.type !== "root") {
        e.preventDefault();
        onSelect(node.id, "toggle");
      }
      return;
    }
    if (disabled) return;
    const here = find(root, node.id);
    if (!here?.parent) return;
    const label = nodeLabel(node, registry);

    // Several layers selected, and this one among them: they move as a group.
    if (group.length > 1 && group.includes(node.id)) {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const dir = e.key === "ArrowUp" ? -1 : 1;
        const plan = planGroupStep(root, group, dir);
        if (!plan) return announce(group.some((id) => find(root, id)?.parent?.id !== here.parent!.id)
          ? "Selected layers in different places move together only by dragging."
          : `The selection cannot move further ${dir === -1 ? "up" : "down"}.`);
        void moveMany(plan, `${group.length} layers moved ${dir === -1 ? "up" : "down"}.`, node.id);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        announce("Nest or un-nest one layer at a time. Select a single layer first.");
      }
      return;
    }

    const siblings = here.parent.children ?? [];
    if (e.key === "ArrowUp" && here.index > 0) {
      e.preventDefault();
      void move(node.id, here.parent.id, here.index - 1, `${label} moved up.`);
    } else if (e.key === "ArrowDown" && here.index < siblings.length - 1) {
      e.preventDefault();
      void move(node.id, here.parent.id, here.index + 1, `${label} moved down.`);
    } else if (e.key === "ArrowRight" && here.index > 0) {
      e.preventDefault();
      const above = siblings[here.index - 1];
      if (accepts(registry, above.type, node.type)) {
        void move(node.id, above.id, (above.children ?? []).length, `${label} moved into ${nodeLabel(above, registry)}.`);
      } else announce(`${nodeLabel(above, registry)} cannot hold a ${label}.`);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      const parent = find(root, here.parent.id);
      if (parent?.parent && accepts(registry, parent.parent.type, node.type)) {
        void move(node.id, parent.parent.id, parent.index + 1, `${label} moved out of ${nodeLabel(here.parent, registry)}.`);
      } else announce(`${label} cannot move out of here.`);
    }
  };

  const drop = (target: PageNode) => {
    const nodeId = dragging;
    setDragging(null);
    if (!nodeId || nodeId === target.id || disabled) return;
    const dragged = find(root, nodeId);
    if (!dragged) return;

    // Dragging one of several selected layers drags them all.
    const many = group.length > 1 && group.includes(nodeId) ? group : null;
    if (many) {
      const nodes = many.map((id) => find(root, id)!.node);
      if (nodes.some((n) => n.id === target.id || contains(n, target.id))) return;
      const fits = (parentType: string) => nodes.every((n) => accepts(registry, parentType, n.type));
      if (target.type !== "root" && fits(target.type)) {
        return void moveMany(planBulkMove(root, many, target.id, (target.children ?? []).length), `${many.length} layers moved into ${nodeLabel(target, registry)}.`, nodeId);
      }
      if (target.type === "root") {
        return void moveMany(planBulkMove(root, many, root.id, (root.children ?? []).length), `${many.length} layers moved to the end of the page.`, nodeId);
      }
      const at = find(root, target.id);
      if (at?.parent && fits(at.parent.type)) {
        return void moveMany(planBulkMove(root, many, at.parent.id, at.index + 1), `${many.length} layers moved after ${nodeLabel(target, registry)}.`, nodeId);
      }
      return announce("Those layers cannot go there.");
    }

    if (contains(dragged.node, target.id)) return;
    const label = nodeLabel(dragged.node, registry);
    // Into the target when it can hold the block; otherwise right after it.
    if (target.type !== "root" && accepts(registry, target.type, dragged.node.type)) {
      void move(nodeId, target.id, (target.children ?? []).length, `${label} moved into ${nodeLabel(target, registry)}.`);
      return;
    }
    const at = find(root, target.id);
    if (target.type === "root") {
      void move(nodeId, root.id, (root.children ?? []).length, `${label} moved to the end of the page.`);
    } else if (at?.parent && accepts(registry, at.parent.type, dragged.node.type)) {
      const sameParent = dragged.parent?.id === at.parent.id && dragged.index < at.index;
      void move(nodeId, at.parent.id, sameParent ? at.index : at.index + 1, `${label} moved after ${nodeLabel(target, registry)}.`);
    }
  };

  /**
   * A plain function, **not** a component: a component declared inside this
   * one is a new type on every render, so React would remount every row and
   * the focused button would vanish — selecting a row by click (which
   * re-renders) dropped keyboard focus to the page, and the next arrow key went
   * nowhere.
   */
  const row = (node: PageNode, depth: number): React.ReactElement => {
    const selected = selection.includes(node.id);
    const isPrimary = node.id === primary;
    const here = find(root, node.id);
    const siblings = here?.parent?.children ?? [];
    return (
      <li key={node.id} role="treeitem" aria-selected={selected} aria-level={depth + 1} aria-expanded={node.children?.length ? true : undefined}>
        <div
          className={`group flex items-center gap-1 rounded px-1.5 py-1 text-sm ${selected ? "bg-brand/10 text-foreground" : "text-foreground hover:bg-hover"} ${isPrimary && selection.length > 1 ? "ring-1 ring-brand/40" : ""} ${dragging === node.id ? "opacity-50" : ""}`}
          style={{ paddingLeft: `${depth * 14 + 6}px` }}
          draggable={!disabled && node.type !== "root"}
          onDragStart={(e) => {
            setDragging(node.id);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragEnd={() => setDragging(null)}
          onDragOver={(e) => {
            if (dragging) e.preventDefault();
          }}
          onDrop={(e) => {
            e.preventDefault();
            drop(node);
          }}
        >
          {node.type !== "root" ? <GripVertical aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted" /> : null}
          <button
            type="button"
            data-layer={node.id}
            tabIndex={node.id === focusable ? 0 : -1}
            className="min-w-0 flex-1 truncate text-left outline-none focus-visible:underline"
            onClick={(e) =>
              onSelect(node.id, node.type !== "root" && (e.ctrlKey || e.metaKey) ? "toggle" : node.type !== "root" && e.shiftKey ? "range" : "replace")
            }
            onKeyDown={(e) => onKey(e, node)}
            aria-keyshortcuts="ArrowUp ArrowDown Shift+ArrowUp Shift+ArrowDown Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight"
          >
            {nodeLabel(node, registry)}
          </button>
          {isPrimary && selection.length === 1 && here?.parent && !disabled ? (
            <span className="flex shrink-0 gap-0.5">
              <button
                type="button"
                tabIndex={-1}
                className="rounded p-0.5 hover:bg-hover disabled:opacity-30"
                aria-label="Move up"
                disabled={here.index === 0}
                onClick={() => void move(node.id, here.parent!.id, here.index - 1, `${nodeLabel(node, registry)} moved up.`)}
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                tabIndex={-1}
                className="rounded p-0.5 hover:bg-hover disabled:opacity-30"
                aria-label="Move down"
                disabled={here.index >= siblings.length - 1}
                onClick={() => void move(node.id, here.parent!.id, here.index + 1, `${nodeLabel(node, registry)} moved down.`)}
              >
                <ArrowDown className="h-3.5 w-3.5" />
              </button>
            </span>
          ) : null}
        </div>
        {node.children?.length ? (
          <ul role="group">
            {node.children.map((c) => row(c, depth + 1))}
          </ul>
        ) : null}
      </li>
    );
  };

  return (
    <div className="p-2">
      <details className="px-1.5 pb-2 text-xs text-muted">
        <summary className="cursor-pointer">Drag to reorder, or use the keyboard</summary>
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          <li>↑ ↓ move between layers · Shift+↑ ↓ select several · Ctrl/⌘+click adds one</li>
          <li>Alt+↑ ↓ moves the selection · Alt+→ nests into the block above · Alt+← moves out</li>
          <li>Ctrl/⌘+C copy · Ctrl/⌘+X cut · Ctrl/⌘+V paste · Ctrl/⌘+D duplicate · Delete removes · Esc clears</li>
        </ul>
      </details>
      <ul role="tree" aria-label="Page layers" aria-multiselectable="true">
        {row(root, 0)}
      </ul>
    </div>
  );
}
