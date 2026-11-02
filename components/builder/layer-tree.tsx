"use client";

import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import type { BlockDescription, PageNode } from "@/lib/api/builder";
import { accepts, contains, find, nodeLabel } from "./tree";

/**
 * The layer tree (`docs/BUILDER.md` §11): the page's structure as a list,
 * where selection, reordering and nesting happen.
 *
 * **Every drag has a keyboard equivalent**, which BUILDER.md makes a launch
 * requirement rather than a follow-up: with a row focused, Alt+↑/↓ moves it
 * among its siblings, Alt+→ nests it into the block above, Alt+← moves it out
 * of its parent. Each move is announced in a live region. The keyboard path and
 * the agent's path are the same registry action, `builder.moveNode`.
 */
export function LayerTree({
  root,
  registry,
  selectedId,
  onSelect,
  onMove,
  disabled,
}: {
  root: PageNode;
  registry: Map<string, BlockDescription>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onMove: (nodeId: string, parentId: string, index: number) => Promise<boolean>;
  disabled: boolean;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [refocus, setRefocus] = useState<string | null>(null);

  // The tree re-renders from the refreshed page after a move; keep the keyboard on the moved layer.
  useEffect(() => {
    if (!refocus) return;
    document.querySelector<HTMLButtonElement>(`[data-layer="${refocus}"]`)?.focus();
    setRefocus(null);
  }, [root, refocus]);

  const move = async (nodeId: string, parentId: string, index: number, said: string) => {
    if (await onMove(nodeId, parentId, index)) {
      setAnnouncement(said);
      setRefocus(nodeId);
    }
  };

  const keyMove = (e: React.KeyboardEvent, node: PageNode) => {
    if (disabled || !e.altKey) return;
    const here = find(root, node.id);
    if (!here?.parent) return;
    const label = nodeLabel(node, registry);
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
      } else setAnnouncement(`${nodeLabel(above, registry)} cannot hold a ${label}.`);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      const parent = find(root, here.parent.id);
      if (parent?.parent && accepts(registry, parent.parent.type, node.type)) {
        void move(node.id, parent.parent.id, parent.index + 1, `${label} moved out of ${nodeLabel(here.parent, registry)}.`);
      } else setAnnouncement(`${label} cannot move out of here.`);
    }
  };

  const drop = (target: PageNode) => {
    const nodeId = dragging;
    setDragging(null);
    if (!nodeId || nodeId === target.id || disabled) return;
    const dragged = find(root, nodeId);
    if (!dragged || contains(dragged.node, target.id)) return;
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

  const Row = ({ node, depth }: { node: PageNode; depth: number }) => {
    const selected = node.id === selectedId;
    const here = find(root, node.id);
    const siblings = here?.parent?.children ?? [];
    return (
      <li role="treeitem" aria-selected={selected} aria-level={depth + 1} aria-expanded={node.children?.length ? true : undefined}>
        <div
          className={`group flex items-center gap-1 rounded px-1.5 py-1 text-sm ${selected ? "bg-brand/10 text-foreground" : "text-foreground hover:bg-hover"} ${dragging === node.id ? "opacity-50" : ""}`}
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
            className="min-w-0 flex-1 truncate text-left outline-none focus-visible:underline"
            onClick={() => onSelect(node.id)}
            onKeyDown={(e) => keyMove(e, node)}
            aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight"
          >
            {nodeLabel(node, registry)}
          </button>
          {selected && here?.parent && !disabled ? (
            <span className="flex shrink-0 gap-0.5">
              <button
                type="button"
                className="rounded p-0.5 hover:bg-hover disabled:opacity-30"
                aria-label="Move up"
                disabled={here.index === 0}
                onClick={() => void move(node.id, here.parent!.id, here.index - 1, `${nodeLabel(node, registry)} moved up.`)}
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
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
            {node.children.map((c) => (
              <Row key={c.id} node={c} depth={depth + 1} />
            ))}
          </ul>
        ) : null}
      </li>
    );
  };

  return (
    <div className="p-2">
      <p className="px-1.5 pb-2 text-xs text-muted">Drag to reorder, or focus a layer and use Alt + arrow keys.</p>
      <ul role="tree" aria-label="Page layers">
        <Row node={root} depth={0} />
      </ul>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
