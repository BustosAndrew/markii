"use client";

import { useState } from "react";
import type { BlockRegistry, DesignPage, DesignTokens, PageSeo, SavedBlock, SharedDocument, ThemeId } from "@/lib/api/builder";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/field";
import { Toggle } from "@/components/ui/toggle";

/** The block library and presets (`docs/BUILDER.md` §11). Inserts go into or after the selection. */
export function AddPanel({
  registry,
  disabled,
  onAddBlock,
  onAddPreset,
  clipboard,
  onPaste,
  saved,
  onInsertSaved,
  onDeleteSaved,
}: {
  registry: BlockRegistry;
  disabled: boolean;
  onAddBlock: (type: string) => void;
  onAddPreset: (preset: string) => void;
  /** M7: what Copy put on the clipboard, if anything. */
  clipboard: { count: number; label: string } | null;
  onPaste: () => void;
  /** M7: the site's saved blocks; null while loading or when they could not be read. */
  saved: SavedBlock[] | null;
  onInsertSaved: (block: SavedBlock) => void;
  onDeleteSaved: (block: SavedBlock) => void;
}) {
  const groups = ["layout", "content", "media", "commerce", "navigation", "advanced"] as const;
  const [confirming, setConfirming] = useState<number | null>(null);
  const label = (type: string) => registry.blocks.find((b) => b.type === type)?.label ?? type;
  return (
    <div className="space-y-5 p-3">
      {clipboard ? (
        <button
          type="button"
          disabled={disabled}
          onClick={onPaste}
          aria-keyshortcuts="Control+V"
          className="w-full rounded-[var(--radius-control)] border border-dashed border-brand/60 px-3 py-2 text-left text-sm hover:border-brand disabled:opacity-50"
        >
          <span className="block font-medium text-foreground">Paste {clipboard.count === 1 ? "block" : `${clipboard.count} blocks`}</span>
          <span className="block truncate text-xs text-muted">{clipboard.label}</span>
        </button>
      ) : null}
      <section aria-label="Saved blocks">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Saved blocks</h3>
        {saved === null ? (
          <p className="text-xs text-muted">Loading saved blocks…</p>
        ) : saved.length === 0 ? (
          <p className="text-xs text-muted">None yet. Select a block and use &ldquo;Save as a reusable block&rdquo; in the inspector.</p>
        ) : (
          <ul className="grid gap-1.5">
            {saved.map((b) => (
              <li key={b.id} className="flex items-stretch gap-1">
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onInsertSaved(b)}
                  className="min-w-0 flex-1 rounded-[var(--radius-control)] border border-border px-3 py-2 text-left text-sm hover:border-brand disabled:opacity-50"
                >
                  <span className="block truncate font-medium text-foreground">{b.name}</span>
                  <span className="block text-xs text-muted">
                    {label(b.type)} · {b.nodeCount} {b.nodeCount === 1 ? "block" : "blocks"}
                  </span>
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={confirming === b.id ? `Confirm deleting saved block ${b.name}` : `Delete saved block ${b.name}`}
                  onClick={() => {
                    if (confirming === b.id) {
                      setConfirming(null);
                      onDeleteSaved(b);
                    } else setConfirming(b.id);
                  }}
                  onBlur={() => setConfirming((c) => (c === b.id ? null : c))}
                  className={`shrink-0 rounded-[var(--radius-control)] border px-2 text-xs disabled:opacity-50 ${confirming === b.id ? "border-error-border bg-error-bg text-error-text" : "border-border text-muted hover:text-foreground"}`}
                >
                  {confirming === b.id ? "Confirm" : "Delete"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
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
  onRename: (id: number, patch: { title?: string; seo?: PageSeo }) => void;
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

const SHARED_HELP: Record<string, string> = {
  product: "Every product page",
  collection: "Every collection page",
  announcement: "A line above the header on every page",
  header: "The top of every page",
  footer: "The bottom of every page",
};

/**
 * Templates and global regions (M4). Not customised, the storefront uses its
 * built-in layout; customising starts from that layout, so nothing changes
 * for shoppers until it is edited and published. Reset is the same delete a
 * page has: the built-in layout returns at the next publish.
 */
export function SharedLayoutsPanel({
  templates,
  regions,
  currentId,
  disabled,
  onOpen,
  onCustomize,
  onReset,
  onRestore,
}: {
  templates: SharedDocument[];
  regions: SharedDocument[];
  currentId: number | null;
  disabled: boolean;
  onOpen: (doc: SharedDocument & { id: number }) => void;
  onCustomize: (kind: "template" | "region", handle: string) => void;
  onReset: (id: number) => void;
  onRestore: (id: number) => void;
}) {
  const row = (kind: "template" | "region", d: SharedDocument) => (
    <li key={d.handle} className="space-y-1">
      <div className="flex items-center gap-2">
        {d.customized && d.id !== null ? (
          <button
            type="button"
            onClick={() => onOpen(d as SharedDocument & { id: number })}
            className={`min-w-0 flex-1 truncate rounded px-2 py-1.5 text-left text-sm text-foreground ${d.id === currentId ? "bg-brand/10" : "hover:bg-hover"}`}
          >
            {d.title}
            {!d.published ? <span className="ml-1 text-xs text-muted">· not published</span> : null}
          </button>
        ) : (
          <span className={`min-w-0 flex-1 truncate px-2 py-1.5 text-sm ${d.deleted ? "text-muted line-through" : "text-muted"}`}>
            {d.title} <span className="text-xs">· {d.deleted ? "reset at next publish" : "built-in"}</span>
          </span>
        )}
        {d.customized && d.id !== null ? (
          <Button variant="ghost" disabled={disabled} onClick={() => onReset(d.id!)} aria-label={`Reset ${d.title} to the built-in layout`}>
            Reset
          </Button>
        ) : d.deleted && d.id !== null ? (
          <Button variant="ghost" disabled={disabled} onClick={() => onRestore(d.id!)}>
            Restore
          </Button>
        ) : (
          <Button variant="ghost" disabled={disabled} onClick={() => onCustomize(kind, d.handle)}>
            Customize
          </Button>
        )}
      </div>
      <p className="px-2 text-xs text-muted">
        {SHARED_HELP[d.handle]}
        {kind === "template" && d.previewPath === null ? " — add a product (or publish a collection) to preview it." : "."}
      </p>
    </li>
  );
  return (
    <div className="space-y-4 border-t border-border p-3">
      <section aria-label="Templates">
        <h3 className="mb-1 text-sm font-semibold text-foreground">Templates</h3>
        <ul className="space-y-2">{templates.map((t) => row("template", t))}</ul>
      </section>
      <section aria-label="Shared regions">
        <h3 className="mb-1 text-sm font-semibold text-foreground">On every page</h3>
        <ul className="space-y-2">{regions.map((r) => row("region", r))}</ul>
      </section>
    </div>
  );
}

/** SEO fields save on blur. Their current values come from the page document, loaded by the editor. */
/**
 * The page's SEO, saved as one object on blur or toggle — `builder.updatePage`
 * replaces `seo` whole, so every field is sent every time, or saving the title
 * would drop the share image and the noindex switch.
 */
function SeoFields({ seo: initial, disabled, onSave }: { seo: PageSeo; disabled: boolean; onSave: (seo: PageSeo) => void }) {
  const [seo, setSeo] = useState<PageSeo>(initial);
  const clean = (s: PageSeo): PageSeo => {
    const out: PageSeo = {};
    if (s.title?.trim()) out.title = s.title.trim();
    if (s.description?.trim()) out.description = s.description.trim();
    if (s.ogImage?.trim()) out.ogImage = s.ogImage.trim();
    if (s.noindex) out.noindex = true;
    return out;
  };
  const save = (next: PageSeo = seo) => {
    if (JSON.stringify(clean(next)) !== JSON.stringify(clean(initial))) onSave(clean(next));
  };
  return (
    <div className="space-y-3">
      <div>
        <Label htmlFor="seo-title">Search title</Label>
        <Input id="seo-title" maxLength={120} disabled={disabled} value={seo.title ?? ""} placeholder="Defaults to the page title" onChange={(e) => setSeo({ ...seo, title: e.target.value })} onBlur={() => save()} />
      </div>
      <div>
        <Label htmlFor="seo-desc">Search description</Label>
        <Input id="seo-desc" maxLength={320} disabled={disabled} value={seo.description ?? ""} onChange={(e) => setSeo({ ...seo, description: e.target.value })} onBlur={() => save()} />
        <p className="mt-1 text-xs text-muted">Also how llms.txt describes this page to AI agents.</p>
      </div>
      <div>
        <Label htmlFor="seo-image">Share image</Label>
        <Input id="seo-image" maxLength={2000} disabled={disabled} value={seo.ogImage ?? ""} placeholder="https://…" onChange={(e) => setSeo({ ...seo, ogImage: e.target.value })} onBlur={() => save()} />
        <p className="mt-1 text-xs text-muted">Shown when a link to this page is shared.</p>
      </div>
      <Toggle
        checked={Boolean(seo.noindex)}
        disabled={disabled}
        label="Hide from search engines and AI agents"
        onChange={(v) => {
          const next = { ...seo, noindex: v };
          setSeo(next);
          save(next);
        }}
      />
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
  customCss,
  canWriteCode,
  onTheme,
  onTokens,
  onCustomCss,
  headHtml,
  canWriteScripts,
  onHeadCode,
}: {
  themeId: ThemeId;
  tokens: DesignTokens;
  contrast: string[];
  registry: BlockRegistry;
  disabled: boolean;
  /** M6: the draft's custom CSS. */
  customCss: string;
  /** Whether this viewer may save custom code at all (a person with edit rights). */
  canWriteCode: boolean;
  onTheme: (id: ThemeId) => void;
  onTokens: (patch: Record<string, unknown>) => void;
  /** Empty array: saved. Non-empty: `details.problems` from a refused save. */
  onCustomCss: (css: string) => Promise<string[]>;
  /** M6: the draft's custom scripts, as stored (cleaned). */
  headHtml: string;
  /** `cms.scripts` — owner, administrator, developer. */
  canWriteScripts: boolean;
  /** Saves; resolves to what the server dropped, or null when the save failed. */
  onHeadCode: (html: string) => Promise<string[] | null>;
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

      <CustomCssField key={customCss} css={customCss} disabled={disabled || !canWriteCode} onSave={onCustomCss} />
      <HeadCodeField key={headHtml} html={headHtml} disabled={disabled} canWrite={canWriteScripts} onSave={onHeadCode} />
    </div>
  );
}

/**
 * Custom scripts (M6 head code). An explicit Save, not save-on-blur: saving
 * asks for a fresh authenticator code, and a modal that appears because focus
 * moved would be a surprise. After saving, the field shows what was stored and
 * lists anything the server dropped.
 */
function HeadCodeField({
  html,
  disabled,
  canWrite,
  onSave,
}: {
  html: string;
  disabled: boolean;
  canWrite: boolean;
  onSave: (html: string) => Promise<string[] | null>;
}) {
  const [draft, setDraft] = useState(html);
  const [removed, setRemoved] = useState<string[]>([]);
  return (
    <section className="space-y-2 border-t border-border pt-4" aria-label="Custom scripts">
      <div>
        <Label htmlFor="th-head">Custom scripts</Label>
        <p className="text-xs text-muted">
          For analytics and pixels: paste the vendor&rsquo;s snippet. Runs on every storefront page once published — never on the cart or account pages, and never in this preview.
          Kept: &lt;script&gt;, &lt;meta name&gt;, &lt;link rel=&quot;preconnect&quot;&gt; and &lt;noscript&gt; tracking images. Saving asks for your authenticator code.
        </p>
      </div>
      {canWrite ? (
        <>
          <textarea
            id="th-head"
            rows={8}
            spellCheck={false}
            value={draft}
            disabled={disabled}
            maxLength={20_000}
            onChange={(e) => setDraft(e.target.value)}
            className="w-full rounded-[var(--radius-control)] border border-border bg-surface p-2 font-mono text-xs text-foreground disabled:opacity-60"
            placeholder={'<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXX"></script>'}
          />
          <button
            type="button"
            className="rounded-[var(--radius-control)] border border-border px-3 py-1.5 text-sm text-foreground hover:bg-hover disabled:opacity-50"
            disabled={disabled || draft === html}
            onClick={async () => {
              const dropped = await onSave(draft);
              if (dropped) setRemoved(dropped);
            }}
          >
            Save scripts
          </button>
          {removed.length ? (
            <div role="status" className="rounded-[var(--radius-control)] border border-warning-border bg-warning-bg p-3 text-xs text-warning-text">
              <p className="font-medium">Saved without:</p>
              <ul className="mt-1 list-disc pl-4">
                {removed.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : (
        <p className="text-xs text-muted">{html ? "This store has custom scripts. " : ""}Only an owner, administrator or developer can change them.</p>
      )}
    </section>
  );
}

/**
 * The site's custom CSS (M6). Saves on blur; the server checks it and a
 * refusal comes back through the editor's error bar. The brand agent has no
 * way to write it — the action refuses anything but a signed-in person.
 */
function CustomCssField({ css, disabled, onSave }: { css: string; disabled: boolean; onSave: (css: string) => Promise<string[]> }) {
  const [draft, setDraft] = useState(css);
  const [problems, setProblems] = useState<string[]>([]);
  return (
    <section className="space-y-2 border-t border-border pt-4" aria-label="Custom CSS">
      <div>
        <Label htmlFor="th-css">Custom CSS</Label>
        <p className="text-xs text-muted">
          Applied after the theme on every page except the cart and account pages. Target your own classes (set them on a block in the inspector). No @import; images by https:// address only.
        </p>
      </div>
      <textarea
        id="th-css"
        rows={10}
        spellCheck={false}
        value={draft}
        disabled={disabled}
        maxLength={20_000}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={async () => {
          if (draft === css) return;
          setProblems(await onSave(draft));
        }}
        className="w-full rounded-[var(--radius-control)] border border-border bg-surface p-2 font-mono text-xs text-foreground disabled:opacity-60"
        placeholder={".promo-banner {\n  letter-spacing: 0.04em;\n}"}
      />
      {problems.length ? (
        <ul className="space-y-1 rounded-[var(--radius-control)] border border-error-border bg-error-bg p-3 text-xs text-error-text" role="alert">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
