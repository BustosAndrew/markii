"use client";

import { useState } from "react";
import type { BlockDescription, BlockRegistry, Breakpoint, Condition, FieldSpec, PageNode, StyleProps } from "@/lib/api/builder";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/field";
import { Toggle } from "@/components/ui/toggle";

/**
 * The right-hand inspector (`docs/BUILDER.md` §11), **generated from the
 * block's `editorPanel`** — no per-block form exists anywhere. A new block type
 * gets an inspector the day it is registered.
 *
 * Every save is one registry action. Text saves when the field loses focus
 * (or on Enter), so typing a heading writes one audit row, not forty.
 */

export type PickerData = {
  products: { slug: string; name: string; images: string[] }[];
  categories: { slug: string; name: string }[];
  collections: { handle: string; title: string }[];
};

type Commit = (props: Record<string, unknown>, unset?: string[]) => void;

const SPACE = ["0", "xs", "sm", "md", "lg", "xl", "2xl", "3xl"];
const COLORS = ["bg", "surface", "fg", "muted", "border", "accent", "accentText"];

const STYLE_FIELDS: { key: keyof StyleProps; label: string; options: string[] }[] = [
  { key: "paddingY", label: "Padding top & bottom", options: SPACE },
  { key: "paddingX", label: "Padding sides", options: SPACE },
  { key: "marginTop", label: "Space above", options: SPACE },
  { key: "marginBottom", label: "Space below", options: SPACE },
  { key: "gap", label: "Gap between items", options: SPACE },
  { key: "align", label: "Alignment", options: ["start", "center", "end"] },
  { key: "width", label: "Width", options: ["content", "wide", "full"] },
  { key: "background", label: "Background", options: ["none", ...COLORS] },
  { key: "color", label: "Text colour", options: COLORS },
  { key: "fontSize", label: "Text size", options: ["sm", "md", "lg", "xl", "2xl", "3xl", "4xl"] },
  { key: "font", label: "Font", options: ["body", "display"] },
  { key: "radius", label: "Corners", options: ["none", "theme", "full"] },
  { key: "columns", label: "Columns", options: ["1", "2", "3", "4", "5", "6"] },
];

function TextField({ spec, value, onCommit, disabled, multiline }: { spec: FieldSpec; value: unknown; onCommit: (v: string) => void; disabled: boolean; multiline?: boolean }) {
  // Fresh state per saved value: callers key this field on the value, so a save remounts it.
  const [draft, setDraft] = useState(String(value ?? ""));
  const max = "maxLength" in spec ? spec.maxLength : undefined;
  const commit = () => {
    if (draft !== String(value ?? "")) onCommit(draft);
  };
  const id = `f-${spec.name}`;
  return (
    <div>
      <Label htmlFor={id}>{spec.label}</Label>
      {multiline ? (
        <Textarea id={id} rows={5} value={draft} maxLength={max} disabled={disabled} onChange={(e) => setDraft(e.target.value)} onBlur={commit} />
      ) : (
        <Input
          id={id}
          value={draft}
          maxLength={max}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      )}
    </div>
  );
}

function ItemsField({ spec, value, onCommit, disabled }: { spec: Extract<FieldSpec, { kind: "items" }>; value: unknown; onCommit: (v: unknown[]) => void; disabled: boolean }) {
  const items = Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
  // Keyed on the saved value by the caller, so a save starts this list afresh.
  const [draft, setDraft] = useState(items);
  const save = (next: Record<string, unknown>[]) => onCommit(next);
  return (
    <fieldset className="space-y-3">
      <legend className="mb-1.5 text-sm font-medium text-foreground">{spec.label}</legend>
      {draft.map((item, i) => (
        <div key={i} className="space-y-2 rounded-[var(--radius-control)] border border-border p-3">
          {spec.fields.map((f) => {
            const id = `f-${spec.name}-${i}-${f.name}`;
            const v = String(item[f.name] ?? "");
            const update = (text: string) => setDraft(draft.map((x, j) => (j === i ? { ...x, [f.name]: text } : x)));
            return (
              <div key={f.name}>
                <Label htmlFor={id}>{f.label}</Label>
                {f.kind === "markdown" ? (
                  <Textarea id={id} rows={3} value={v} disabled={disabled} onChange={(e) => update(e.target.value)} onBlur={() => save(draft)} />
                ) : (
                  <Input id={id} value={v} disabled={disabled} onChange={(e) => update(e.target.value)} onBlur={() => save(draft)} />
                )}
              </div>
            );
          })}
          <Button variant="ghost" disabled={disabled || draft.length <= 1} onClick={() => save(draft.filter((_, j) => j !== i))}>
            Remove
          </Button>
        </div>
      ))}
      {draft.length < spec.maxItems ? (
        <Button
          variant="secondary"
          disabled={disabled}
          onClick={() => save([...draft, Object.fromEntries(spec.fields.map((f) => [f.name, f.kind === "markdown" ? "Text." : "New item"]))])}
        >
          Add
        </Button>
      ) : null}
    </fieldset>
  );
}

function Field({ spec, props, commit, disabled, data }: { spec: FieldSpec; props: Record<string, unknown>; commit: Commit; disabled: boolean; data: PickerData }) {
  const value = props[spec.name];
  const id = `f-${spec.name}`;
  // An emptied optional field is removed rather than saved as "".
  const setText = (v: string) => (v.trim() === "" ? commit({}, [spec.name]) : commit({ [spec.name]: v }));

  switch (spec.kind) {
    case "text":
    case "link":
      return <TextField key={String(value ?? "")} spec={spec} value={value} onCommit={spec.kind === "link" ? setText : (v) => commit({ [spec.name]: v })} disabled={disabled} />;
    case "markdown":
      return <TextField key={String(value ?? "")} spec={spec} value={value} onCommit={(v) => commit({ [spec.name]: v })} disabled={disabled} multiline />;
    case "number":
      return (
        <div>
          <Label htmlFor={id}>{spec.label}</Label>
          <Input
            id={id}
            type="number"
            min={spec.min}
            max={spec.max}
            defaultValue={String(value ?? "")}
            key={String(value)}
            disabled={disabled}
            onBlur={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n !== value) commit({ [spec.name]: n });
            }}
          />
        </div>
      );
    case "select":
      return (
        <div>
          <Label htmlFor={id}>{spec.label}</Label>
          <Select
            id={id}
            value={String(value ?? "")}
            disabled={disabled}
            onChange={(e) => {
              const opt = spec.options.find((o) => String(o.value) === e.target.value);
              if (opt) commit({ [spec.name]: opt.value });
            }}
          >
            {spec.options.map((o) => (
              <option key={String(o.value)} value={String(o.value)}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
      );
    case "boolean":
      return <Toggle checked={Boolean(value)} onChange={(next) => commit({ [spec.name]: next })} label={spec.label} disabled={disabled} />;
    case "image": {
      const images = [...new Set(data.products.flatMap((p) => p.images))].slice(0, 60);
      return (
        <div className="space-y-2">
          <TextField key={String(value ?? "")} spec={{ ...spec, kind: "text", maxLength: 2000 }} value={value} onCommit={setText} disabled={disabled} />
          {images.length > 0 ? (
            <div>
              <p className="mb-1.5 text-xs text-muted">Or pick one of the store&apos;s product images</p>
              <div className="grid grid-cols-4 gap-1.5">
                {images.map((src) => (
                  <button
                    key={src}
                    type="button"
                    disabled={disabled}
                    onClick={() => commit({ [spec.name]: src })}
                    className={`aspect-square overflow-hidden rounded border ${value === src ? "border-brand ring-2 ring-brand/30" : "border-border"}`}
                    aria-label="Use this image"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={src} alt="" className="h-full w-full object-cover" />
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      );
    }
    case "product":
    case "category":
    case "collection": {
      const options =
        spec.kind === "product"
          ? data.products.map((p) => ({ value: p.slug, label: p.name }))
          : spec.kind === "category"
            ? data.categories.map((c) => ({ value: c.slug, label: c.name }))
            : data.collections.map((c) => ({ value: c.handle, label: c.title }));
      return (
        <div>
          <Label htmlFor={id}>{spec.label}</Label>
          <Select id={id} value={String(value ?? "")} disabled={disabled} onChange={(e) => (e.target.value ? commit({ [spec.name]: e.target.value }) : commit({}, [spec.name]))}>
            <option value="">— Choose —</option>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          {options.length === 0 ? <p className="mt-1 text-xs text-muted">This store has none yet.</p> : null}
        </div>
      );
    }
    case "stringList":
      return (
        <TextField
          key={JSON.stringify(value ?? [])}
          spec={{ ...spec, kind: "markdown", maxLength: spec.maxItems * (spec.maxLength + 1), label: `${spec.label} (one per line)` }}
          value={Array.isArray(value) ? value.join("\n") : ""}
          onCommit={(v) => commit({ [spec.name]: v.split("\n").map((x) => x.trim()).filter(Boolean) })}
          disabled={disabled}
        />
      );
    case "items":
      return <ItemsField key={JSON.stringify(value ?? [])} spec={spec} value={value} onCommit={(v) => commit({ [spec.name]: v })} disabled={disabled} />;
  }
}

type DataList = BlockRegistry["data"];

/**
 * Bindings (M4): each prop the block lets be bound, with the paths that fit
 * both its type and the document — a product path is offered only in the
 * product template, `item.*` only inside a repeater.
 */
function DataSection({ node, block, paths, scopes, disabled, onBindings }: { node: PageNode; block: BlockDescription; paths: DataList; scopes: string[]; disabled: boolean; onBindings: (patch: Record<string, string | null>) => void }) {
  const rows = Object.entries(block.bindable ?? {})
    .map(([prop, accepts]) => {
      const current = node.bindings?.[prop] ?? "";
      const options = paths.bindings.filter((b) => accepts.includes(b.type) && scopes.includes(b.scope));
      const label = block.editorPanel.find((f) => f.name === prop)?.label ?? prop;
      return { prop, current, options, label };
    })
    .filter((r) => r.options.length > 0 || r.current);
  if (rows.length === 0) return null;
  return (
    <section className="space-y-3" aria-label="Data">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Data</h3>
        <p className="text-xs text-muted">Fill a field from the store instead of fixed text. The text above stays as the placeholder.</p>
      </div>
      {rows.map((r) => (
        <div key={r.prop}>
          <Label htmlFor={`b-${r.prop}`} className="text-xs">
            {r.label} comes from
          </Label>
          <Select id={`b-${r.prop}`} className="py-1.5 text-xs" value={r.current} disabled={disabled} onChange={(e) => onBindings({ [r.prop]: e.target.value || null })}>
            <option value="">Fixed text</option>
            {r.current && !r.options.some((o) => o.path === r.current) ? <option value={r.current}>{r.current} (not available here)</option> : null}
            {r.options.map((o) => (
              <option key={o.path} value={o.path}>
                {o.label} — {o.path}
              </option>
            ))}
          </Select>
        </div>
      ))}
    </section>
  );
}

const OPS_BY_TYPE: Record<string, { value: Condition["op"]; label: string }[]> = {
  number: [
    { value: "gt", label: "is more than" },
    { value: "gte", label: "is at least" },
    { value: "lt", label: "is less than" },
    { value: "lte", label: "is at most" },
    { value: "eq", label: "is exactly" },
    { value: "neq", label: "is not" },
  ],
  boolean: [
    { value: "eq", label: "is" },
    { value: "neq", label: "is not" },
  ],
  text: [
    { value: "exists", label: "is set" },
    { value: "missing", label: "is empty" },
  ],
};

/** Conditional visibility (M4): one whitelisted comparison, built from selects — never typed as an expression. */
function VisibilitySection({ node, paths, scopes, disabled, onVisibility }: { node: PageNode; paths: DataList; scopes: string[]; disabled: boolean; onVisibility: (when: Condition | null) => void }) {
  const current = node.visibleWhen ?? null;
  const conditions = paths.conditions.filter((c) => scopes.includes(c.scope) || c.path === current?.path);
  const [path, setPath] = useState(current?.path ?? "");
  const spec = conditions.find((c) => c.path === path);
  const ops = spec ? OPS_BY_TYPE[spec.type] : [];
  const [op, setOp] = useState<Condition["op"] | "">(current?.op ?? "");
  const [value, setValue] = useState(current?.value === undefined ? "" : String(current.value));
  const chosenOp = ops.some((o) => o.value === op) ? op : (ops[0]?.value ?? "");
  const needsValue = chosenOp !== "exists" && chosenOp !== "missing" && chosenOp !== "";
  const parsed: Condition | null = spec && chosenOp
    ? needsValue
      ? spec.type === "number"
        ? value.trim() !== "" && Number.isFinite(Number(value)) ? { path, op: chosenOp, value: Number(value) } : null
        : spec.type === "boolean"
          ? { path, op: chosenOp, value: value !== "false" }
          : null
      : { path, op: chosenOp }
    : null;
  if (conditions.length === 0) return null;
  return (
    <section className="space-y-3" aria-label="Visibility">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Show only when</h3>
        <p className="text-xs text-muted">{current ? "This block is hidden for shoppers unless the condition holds." : "Always shown."}</p>
      </div>
      <div className="grid gap-2">
        <Select aria-label="Condition data" className="py-1.5 text-xs" value={path} disabled={disabled} onChange={(e) => setPath(e.target.value)}>
          <option value="">Choose…</option>
          {conditions.map((c) => (
            <option key={c.path} value={c.path}>
              {c.path.split(".")[0]} {c.label}
            </option>
          ))}
        </Select>
        {spec ? (
          <div className="flex gap-2">
            <Select aria-label="Comparison" className="py-1.5 text-xs" value={chosenOp} disabled={disabled} onChange={(e) => setOp(e.target.value as Condition["op"])}>
              {ops.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
            {needsValue && spec.type === "number" ? (
              <Input aria-label="Value" type="number" className="py-1.5 text-xs" value={value} disabled={disabled} onChange={(e) => setValue(e.target.value)} />
            ) : null}
            {needsValue && spec.type === "boolean" ? (
              <Select aria-label="Value" className="py-1.5 text-xs" value={value === "false" ? "false" : "true"} disabled={disabled} onChange={(e) => setValue(e.target.value)}>
                <option value="true">true</option>
                <option value="false">false</option>
              </Select>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="flex gap-2">
        <Button variant="secondary" disabled={disabled || !parsed || JSON.stringify(parsed) === JSON.stringify(current)} onClick={() => parsed && onVisibility(parsed)}>
          Save condition
        </Button>
        {current ? (
          <Button variant="ghost" disabled={disabled} onClick={() => onVisibility(null)}>
            Always show
          </Button>
        ) : null}
      </div>
    </section>
  );
}

export function Inspector({
  node,
  block,
  breakpoint,
  onBreakpoint,
  disabled,
  data,
  paths,
  scopes,
  onProps,
  onStyles,
  onIntent,
  onBindings,
  onVisibility,
  onDuplicate,
  onRemove,
}: {
  node: PageNode | null;
  block: BlockDescription | undefined;
  breakpoint: Breakpoint;
  onBreakpoint: (b: Breakpoint) => void;
  disabled: boolean;
  data: PickerData;
  /** M4: the binding and condition whitelist, from the block registry. */
  paths: DataList;
  /** M4: the data scopes this node can read — its document's, plus `item` inside a repeater. */
  scopes: string[];
  onProps: Commit;
  onStyles: (styles: Record<string, unknown>) => void;
  onIntent: (intent: string | null) => void;
  onBindings: (patch: Record<string, string | null>) => void;
  onVisibility: (when: Condition | null) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  if (!node) {
    return <p className="p-4 text-sm text-muted">Select a block on the page or in the layers list to edit it.</p>;
  }
  if (node.type === "root") {
    return <p className="p-4 text-sm text-muted">This is the page itself. Add sections from the Add tab.</p>;
  }
  const props = node.props as Record<string, unknown>;
  const current = (node.styles?.[breakpoint] ?? {}) as Record<string, unknown>;

  return (
    <div className="space-y-6 p-4">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{block?.label ?? node.type}</h2>
        {block?.usageHints?.length ? (
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-muted">
            {block.usageHints.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        ) : null}
      </div>

      {block?.requiresScope && !scopes.includes(block.requiresScope) ? (
        <p className="rounded-[var(--radius-control)] border border-warning-border bg-warning-bg p-2 text-xs text-warning-text" role="note">
          This block works only in the {block.requiresScope} template. Publishing is blocked while it is here.
        </p>
      ) : null}

      {block?.editorPanel.length ? (
        <section className="space-y-4" aria-label="Content">
          {block.editorPanel.map((spec) => (
            <Field key={spec.name} spec={spec} props={props} commit={onProps} disabled={disabled} data={data} />
          ))}
        </section>
      ) : null}

      {block ? <DataSection node={node} block={block} paths={paths} scopes={scopes} disabled={disabled} onBindings={onBindings} /> : null}
      <VisibilitySection
        key={`${node.id}-${JSON.stringify(node.visibleWhen ?? null)}-${scopes.join(",")}`}
        node={node}
        paths={paths}
        scopes={scopes}
        disabled={disabled}
        onVisibility={onVisibility}
      />

      <section className="space-y-3" aria-label="Style">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-foreground">Style</h3>
          <Select aria-label="Screen size these styles apply to" className="w-auto py-1.5 text-xs" value={breakpoint} disabled={disabled} onChange={(e) => onBreakpoint(e.target.value as Breakpoint)}>
            <option value="base">All screens</option>
            <option value="sm">640px and up</option>
            <option value="md">768px and up</option>
            <option value="lg">1024px and up</option>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {STYLE_FIELDS.map((f) => (
            <div key={f.key}>
              <Label htmlFor={`s-${f.key}`} className="text-xs">
                {f.label}
              </Label>
              <Select
                id={`s-${f.key}`}
                className="py-1.5 text-xs"
                value={current[f.key] === undefined ? "" : String(current[f.key])}
                disabled={disabled}
                onChange={(e) =>
                  onStyles({ [f.key]: e.target.value === "" ? null : f.key === "columns" ? Number(e.target.value) : e.target.value })
                }
              >
                <option value="">{breakpoint === "base" ? "Default" : "Inherit"}</option>
                {f.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </Select>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-4">
          <Toggle checked={current.border === true} onChange={(v) => onStyles({ border: v ? true : null })} label="Border" disabled={disabled} />
          <Toggle checked={current.hidden === true} onChange={(v) => onStyles({ hidden: v ? true : null })} label="Hide at this size" disabled={disabled} />
        </div>
      </section>

      <TextField
        key={`${node.id}-${node.intent ?? ""}`}
        spec={{ name: "intent", label: "Note: what this block is for (not shown to shoppers)", kind: "text", maxLength: 200 }}
        value={node.intent ?? ""}
        onCommit={(v) => onIntent(v.trim() ? v.trim() : null)}
        disabled={disabled}
      />

      <div className="flex gap-2 border-t border-border pt-4">
        <Button variant="secondary" disabled={disabled} onClick={onDuplicate}>
          Duplicate
        </Button>
        <Button variant="ghost" disabled={disabled} onClick={onRemove}>
          Delete
        </Button>
      </div>
    </div>
  );
}
