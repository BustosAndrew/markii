"use client";

import type { DesignDiff, DocumentDiff, NodeChange, NodeRef, ValueChange } from "@/lib/builder/design-diff";

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

function FieldList({ fields }: { fields: ValueChange[] }) {
  if (fields.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-xs text-muted">
      {fields.map((f) => (
        <li key={f.field}>
          <span className="font-medium text-foreground">{f.field}</span>: {shown(f.before)} → {shown(f.after)}
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
}: {
  nodes: NodeChange[];
  onSelect?: (nodeId: string) => void;
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
            <FieldList fields={n.changes} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function DocumentBlock({
  doc,
  onSelectNode,
}: {
  doc: DocumentDiff;
  onSelectNode?: (documentId: number, nodeId: string) => void;
}) {
  const select = onSelectNode ? (nodeId: string) => onSelectNode(doc.id, nodeId) : undefined;
  return (
    <div className="rounded-[var(--radius-control)] border border-border p-3">
      <p className="text-sm font-medium text-foreground">
        {doc.title}{" "}
        <span className="font-normal text-muted">
          ({doc.change === "added" ? "added" : doc.change === "removed" ? "removed" : "changed"})
        </span>
      </p>
      <FieldList fields={doc.fields} />
      <NodeList title="Added" nodes={doc.nodes.added} onSelect={select} />
      <NodeList title="Removed" nodes={doc.nodes.removed} onSelect={select} />
      <ChangedNodes nodes={doc.nodes.changed} onSelect={select} />
    </div>
  );
}

export function DesignDiffView({
  diff,
  onSelectNode,
}: {
  diff: DesignDiff;
  onSelectNode?: (documentId: number, nodeId: string) => void;
}) {
  if (diff.identical) {
    return <p className="text-sm text-muted">No changes since the last publish.</p>;
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
          <FieldList fields={diff.tokens} />
        </div>
      ) : null}
      {diff.customCss ? <p className="text-sm text-foreground">Theme CSS changed.</p> : null}
      {diff.headCode.changed ? <p className="text-sm text-foreground">Custom scripts changed.</p> : null}
      {diff.documents.map((doc) => (
        <DocumentBlock key={doc.id} doc={doc} onSelectNode={onSelectNode} />
      ))}
    </div>
  );
}
