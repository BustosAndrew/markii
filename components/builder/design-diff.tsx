"use client";

import type { DesignDiff, DocumentDiff, NodeChange, NodeRef, ValueChange } from "@/lib/builder/design-diff";

export type DiffTierName = { id: number; name: string };

function shown(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function accessLabel(value: unknown, tiers: DiffTierName[]): string {
  if (value == null || value === "") return "Everyone";
  const id = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(id)) return shown(value);
  return tiers.find((t) => t.id === id)?.name ?? `Tier ${id}`;
}

function FieldList({ fields, tiers }: { fields: ValueChange[]; tiers: DiffTierName[] }) {
  if (fields.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-xs text-muted">
      {fields.map((f) => (
        <li key={f.field}>
          {f.field === "requiresTierId" ? (
            <>
              <span className="font-medium text-foreground">Access</span>: {accessLabel(f.before, tiers)} →{" "}
              {accessLabel(f.after, tiers)}
            </>
          ) : (
            <>
              <span className="font-medium text-foreground">{f.field}</span>: {shown(f.before)} → {shown(f.after)}
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

function NodeList({
  title,
  nodes,
  onSelect,
}: {
  title: string;
  nodes: NodeRef[];
  onSelect?: (nodeId: string) => void;
}) {
  if (nodes.length === 0) return null;
  return (
    <div className="mt-2">
      <p className="text-xs font-medium text-foreground">{title}</p>
      <ul className="mt-1 space-y-0.5">
        {nodes.map((n) => (
          <li key={n.id}>
            {onSelect ? (
              <button type="button" className="text-xs text-foreground hover:text-brand" onClick={() => onSelect(n.id)}>
                {n.label}
              </button>
            ) : (
              <span className="text-xs text-muted">{n.label}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ChangedNodes({
  nodes,
  onSelect,
  tiers,
}: {
  nodes: NodeChange[];
  onSelect?: (nodeId: string) => void;
  tiers: DiffTierName[];
}) {
  if (nodes.length === 0) return null;
  return (
    <div className="mt-2">
      <p className="text-xs font-medium text-foreground">Changed</p>
      <ul className="mt-1 space-y-1">
        {nodes.map((n) => (
          <li key={n.id}>
            {onSelect ? (
              <button type="button" className="text-xs font-medium text-foreground hover:text-brand" onClick={() => onSelect(n.id)}>
                {n.label}
              </button>
            ) : (
              <span className="text-xs font-medium text-foreground">{n.label}</span>
            )}
            <FieldList fields={n.changes} tiers={tiers} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function DocumentBlock({
  doc,
  onSelectNode,
  tiers,
}: {
  doc: DocumentDiff;
  onSelectNode?: (documentId: number, nodeId: string) => void;
  tiers: DiffTierName[];
}) {
  // Only what exists in the draft can be selected: a removed node, or anything in
  // a removed document, has nowhere to open. Both sides of every diff the editor
  // asks for end at the draft (live → draft, version → draft).
  const select =
    onSelectNode && doc.change !== "removed" ? (nodeId: string) => onSelectNode(doc.id, nodeId) : undefined;
  return (
    <div className="rounded-[var(--radius-control)] border border-border p-3">
      <p className="text-sm font-medium text-foreground">
        {doc.title}{" "}
        <span className="font-normal text-muted">
          ({doc.change === "added" ? "added" : doc.change === "removed" ? "removed" : "changed"})
        </span>
      </p>
      <FieldList fields={doc.fields} tiers={tiers} />
      <NodeList title="Added" nodes={doc.nodes.added} onSelect={select} />
      <NodeList title="Removed" nodes={doc.nodes.removed} />
      <ChangedNodes nodes={doc.nodes.changed} onSelect={select} tiers={tiers} />
    </div>
  );
}

export function DesignDiffView({
  diff,
  onSelectNode,
  identicalMessage = "No changes since the last publish.",
  tiers = [],
}: {
  diff: DesignDiff;
  onSelectNode?: (documentId: number, nodeId: string) => void;
  /** What to say when the two sides match — the default fits live → draft only. */
  identicalMessage?: string;
  /** Names for `requiresTierId` so the diff reads *Access: Everyone → Tea Club*. */
  tiers?: DiffTierName[];
}) {
  if (diff.identical) {
    return <p className="text-sm text-muted">{identicalMessage}</p>;
  }
  return (
    <div className="space-y-3">
      {diff.theme ? (
        <p className="text-sm text-foreground">
          Theme: {diff.theme.before} → {diff.theme.after}
        </p>
      ) : null}
      {diff.tokens.length > 0 ? (
        <div>
          <p className="text-sm font-medium text-foreground">Colours and fonts</p>
          <FieldList fields={diff.tokens} tiers={tiers} />
        </div>
      ) : null}
      {diff.customCss ? <p className="text-sm text-foreground">Theme CSS changed.</p> : null}
      {diff.headCode.changed ? <p className="text-sm text-foreground">Custom scripts changed.</p> : null}
      {diff.documents.map((doc) => (
        <DocumentBlock key={doc.id} doc={doc} onSelectNode={onSelectNode} tiers={tiers} />
      ))}
    </div>
  );
}
