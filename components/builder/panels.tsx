"use client";

import { useState } from "react";
import type { BlockRegistry, DesignPage, DesignTokens, PageSeo, ThemeId } from "@/lib/api/builder";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/field";

/** The block library and presets (`docs/BUILDER.md` §11). Inserts go into or after the selection. */
export function AddPanel({
  registry,
  disabled,
  onAddBlock,
  onAddPreset,
}: {
  registry: BlockRegistry;
  disabled: boolean;
  onAddBlock: (type: string) => void;
  onAddPreset: (preset: string) => void;
}) {
  const groups = ["layout", "content", "media", "commerce"] as const;
  return (
    <div className="space-y-5 p-3">
      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Sections</h3>
        <div className="grid gap-1.5">
          {registry.presets.map((p) => (
            <button
              key={p.id}
              type="button"
              disabled={disabled}
              onClick={() => onAddPreset(p.id)}
              className="rounded-[var(--radius-control)] border border-border px-3 py-2 text-left text-sm hover:border-brand disabled:opacity-50"
            >
              <span className="block font-medium text-foreground">{p.label}</span>
              <span className="block text-xs text-muted">{p.description}</span>
            </button>
          ))}
        </div>
      </section>
      {groups.map((g) => (
        <section key={g}>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{g}</h3>
          <div className="grid grid-cols-2 gap-1.5">
            {registry.blocks
              .filter((b) => b.category === g && b.type !== "column")
              .map((b) => (
                <button
                  key={b.type}
                  type="button"
                  disabled={disabled}
                  title={b.description}
                  onClick={() => onAddBlock(b.type)}
                  className="rounded-[var(--radius-control)] border border-border px-2 py-1.5 text-left text-sm text-foreground hover:border-brand disabled:opacity-50"
                >
                  {b.label}
                </button>
              ))}
          </div>
        </section>
      ))}
      <p className="text-xs text-muted">New blocks go inside the selected block when it can hold them, otherwise right after it.</p>
    </div>
  );
}

const HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function PagesPanel({
  pages,
  currentId,
  currentSeo,
  disabled,
  onOpen,
  onCreate,
  onRename,
  onDelete,
  onRestore,
}: {
  pages: DesignPage[];
  currentId: number | null;
  /** The open page's SEO, from its document. */
  currentSeo: PageSeo;
  disabled: boolean;
  onOpen: (id: number) => void;
  onCreate: (handle: string, title: string) => Promise<boolean>;
  onRename: (id: number, patch: { title?: string; seo?: { title?: string; description?: string } }) => void;
  onDelete: (id: number) => void;
  onRestore: (id: number) => void;
}) {
  const [title, setTitle] = useState("");
  const [handle, setHandle] = useState("");
  const derived = handle || title.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const current = pages.find((p) => p.id === currentId);
  return (
    <div className="space-y-5 p-3">
      <ul className="space-y-1">
        {pages.map((p) => (
          <li key={p.id} className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onOpen(p.id)}
              className={`min-w-0 flex-1 truncate rounded px-2 py-1.5 text-left text-sm ${p.id === currentId ? "bg-brand/10" : "hover:bg-hover"} ${p.deleted ? "text-muted line-through" : "text-foreground"}`}
            >
              {p.title} <span className="text-xs text-muted">{p.path}</span>
              {!p.published && !p.deleted ? <span className="ml-1 text-xs text-muted">· not published</span> : null}
            </button>
            {p.handle !== "home" ? (
              p.deleted ? (
                <Button variant="ghost" disabled={disabled} onClick={() => onRestore(p.id)}>
                  Restore
                </Button>
              ) : (
                <Button variant="ghost" disabled={disabled} onClick={() => onDelete(p.id)} aria-label={`Delete ${p.title}`}>
                  Delete
                </Button>
              )
            ) : null}
          </li>
        ))}
      </ul>

      {current ? (
        <section className="space-y-3 border-t border-border pt-4" aria-label="This page">
          <h3 className="text-sm font-semibold text-foreground">This page</h3>
          <div>
            <Label htmlFor="pg-title">Title</Label>
            <Input id="pg-title" defaultValue={current.title} key={`t-${current.id}-${current.title}`} disabled={disabled} maxLength={120} onBlur={(e) => e.target.value.trim() && e.target.value !== current.title && onRename(current.id, { title: e.target.value.trim() })} />
          </div>
          <SeoFields key={`${current.id}-${JSON.stringify(currentSeo)}`} seo={currentSeo} disabled={disabled} onSave={(seo) => onRename(current.id, { seo })} />
        </section>
      ) : null}

      <form
        className="space-y-3 border-t border-border pt-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!title.trim() || !HANDLE.test(derived)) return;
          if (await onCreate(derived, title.trim())) {
            setTitle("");
            setHandle("");
          }
        }}
      >
        <h3 className="text-sm font-semibold text-foreground">New page</h3>
        <div>
          <Label htmlFor="np-title">Title</Label>
          <Input id="np-title" value={title} maxLength={120} disabled={disabled} onChange={(e) => setTitle(e.target.value)} placeholder="About us" />
        </div>
        <div>
          <Label htmlFor="np-handle">Address</Label>
          <Input id="np-handle" value={handle} maxLength={60} disabled={disabled} onChange={(e) => setHandle(e.target.value)} placeholder={derived || "about-us"} />
          <p className="mt-1 text-xs text-muted">/pages/{derived || "…"}</p>
        </div>
        <Button type="submit" variant="secondary" disabled={disabled || !title.trim() || !HANDLE.test(derived) || derived === "home"}>
          Create page
        </Button>
      </form>
    </div>
  );
}

/** SEO fields save on blur. Their current values come from the page document, loaded by the editor. */
function SeoFields({ seo: initial, disabled, onSave }: { seo: PageSeo; disabled: boolean; onSave: (seo: { title?: string; description?: string }) => void }) {
  const [seo, setSeo] = useState<{ title?: string; description?: string }>({ title: initial.title, description: initial.description });
  const save = () => {
    const next = Object.fromEntries(Object.entries(seo).filter(([, v]) => v && v.trim())) as { title?: string; description?: string };
    if (JSON.stringify(next) !== JSON.stringify({ ...(initial.title ? { title: initial.title } : {}), ...(initial.description ? { description: initial.description } : {}) })) onSave(next);
  };
  return (
    <div className="space-y-3">
      <div>
        <Label htmlFor="seo-title">Search title</Label>
        <Input id="seo-title" maxLength={120} disabled={disabled} value={seo.title ?? ""} placeholder="Defaults to the page title" onChange={(e) => setSeo({ ...seo, title: e.target.value })} onBlur={save} />
      </div>
      <div>
        <Label htmlFor="seo-desc">Search description</Label>
        <Input id="seo-desc" maxLength={320} disabled={disabled} value={seo.description ?? ""} onChange={(e) => setSeo({ ...seo, description: e.target.value })} onBlur={save} />
      </div>
    </div>
  );
}

const THEMES: { id: ThemeId; label: string }[] = [
  { id: "studio", label: "Studio" },
  { id: "atlas", label: "Atlas" },
  { id: "noir", label: "Noir" },
  { id: "bloom", label: "Bloom" },
];

const COLOR_TOKENS: { key: keyof DesignTokens; label: string }[] = [
  { key: "background", label: "Background" },
  { key: "surface", label: "Cards" },
  { key: "foreground", label: "Text" },
  { key: "muted", label: "Secondary text" },
  { key: "border", label: "Borders" },
  { key: "accent", label: "Accent" },
  { key: "accentText", label: "Text on accent" },
];

/** The draft theme and token overrides. Colour inputs save on change; null resets a token to the theme's own. */
export function ThemePanel({
  themeId,
  tokens,
  contrast,
  registry,
  disabled,
  onTheme,
  onTokens,
}: {
  themeId: ThemeId;
  tokens: DesignTokens;
  contrast: string[];
  registry: BlockRegistry;
  disabled: boolean;
  onTheme: (id: ThemeId) => void;
  onTokens: (patch: Record<string, unknown>) => void;
}) {
  return (
    <div className="space-y-5 p-3">
      <div>
        <Label htmlFor="th-base">Base theme</Label>
        <Select id="th-base" value={themeId} disabled={disabled} onChange={(e) => onTheme(e.target.value as ThemeId)}>
          {THEMES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </Select>
        <p className="mt-1 text-xs text-muted">Your overrides below stay on top of whichever theme you pick.</p>
      </div>

      <section className="space-y-2" aria-label="Colours">
        <h3 className="text-sm font-semibold text-foreground">Colours</h3>
        {COLOR_TOKENS.map((c) => {
          const value = tokens[c.key] as string | undefined;
          return (
            <div key={c.key} className="flex items-center gap-2">
              <input
                type="color"
                aria-label={c.label}
                disabled={disabled}
                value={value ?? "#888888"}
                onChange={(e) => onTokens({ [c.key]: e.target.value })}
                className="h-8 w-10 cursor-pointer rounded border border-border bg-surface disabled:cursor-not-allowed"
              />
              <span className="flex-1 text-sm text-foreground">{c.label}</span>
              {value ? (
                <button type="button" className="text-xs text-muted underline disabled:opacity-50" disabled={disabled} onClick={() => onTokens({ [c.key]: null })}>
                  Reset
                </button>
              ) : (
                <span className="text-xs text-muted">Theme</span>
              )}
            </div>
          );
        })}
      </section>

      {contrast.length ? (
        <ul className="space-y-1 rounded-[var(--radius-control)] border border-warning-border bg-warning-bg p-3 text-xs text-warning-text" aria-label="Contrast warnings">
          {contrast.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      ) : null}

      <section className="space-y-3" aria-label="Type and shape">
        <h3 className="text-sm font-semibold text-foreground">Type and shape</h3>
        {(
          [
            ["fontDisplay", "Headings font", registry.tokens.fonts],
            ["fontBody", "Body font", registry.tokens.fonts],
            ["radius", "Corner radius", registry.tokens.radius],
            ["maxWidth", "Content width", registry.tokens.maxWidth],
          ] as const
        ).map(([key, label, options]) => (
          <div key={key}>
            <Label htmlFor={`tk-${key}`}>{label}</Label>
            <Select id={`tk-${key}`} value={(tokens[key] as string | undefined) ?? ""} disabled={disabled} onChange={(e) => onTokens({ [key]: e.target.value || null })}>
              <option value="">Theme default</option>
              {options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </Select>
          </div>
        ))}
      </section>
    </div>
  );
}
