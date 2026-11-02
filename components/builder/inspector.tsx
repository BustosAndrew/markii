"use client";

import { useState } from "react";
import type { BlockDescription, Breakpoint, FieldSpec, PageNode, StyleProps } from "@/lib/api/builder";
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

export function Inspector({
  node,
  block,
  breakpoint,
  onBreakpoint,
  disabled,
  data,
  onProps,
  onStyles,
  onIntent,
  onDuplicate,
  onRemove,
}: {
  node: PageNode | null;
  block: BlockDescription | undefined;
  breakpoint: Breakpoint;
  onBreakpoint: (b: Breakpoint) => void;
  disabled: boolean;
  data: PickerData;
  onProps: Commit;
  onStyles: (styles: Record<string, unknown>) => void;
  onIntent: (intent: string | null) => void;
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

      {block?.editorPanel.length ? (
        <section className="space-y-4" aria-label="Content">
          {block.editorPanel.map((spec) => (
            <Field key={spec.name} spec={spec} props={props} commit={onProps} disabled={disabled} data={data} />
          ))}
        </section>
      ) : null}

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
