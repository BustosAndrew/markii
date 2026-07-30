# Markii — Agent-Native Site Builder

Visual, drag-and-drop storefront editing in the **Stacks (RapidWeaver) / Webflow** tradition, with
custom code access — built so that **humans and AI agents edit the same site through the same
primitives**.

Reference: [Agent-Native Architecture, Builder.io](https://www.builder.io/blog/agent-native-architecture)
(fetched 2026-07-29).

## 1. Two governing constraints

**A. Storefront output must stay agent-legible.** Markii's differentiator is that its storefronts
are readable by AI shoppers: semantic HTML, clean JSON-LD, `llms.txt`, `agent.md`. A conventional
visual builder emits deeply nested, absolutely positioned `<div>` soup, which would destroy exactly
that. **So the builder is block-based, not free-canvas** — merchants compose *stacks of typed
blocks* in normal document flow, with layout freedom inside each block but no absolute positioning
on the page. Slightly less pixel freedom than Webflow, in exchange for output that stays fast,
accessible, and machine-readable. It also matches the Stacks model the brief asked for.

**B. The editor must be agent-operable.** Not "has an AI panel" — *operable*. Every edit a human
can make, an agent can make, through the same action definitions, the same permissions, and the
same audit trail. This cannot be retrofitted; it is a property of how the mutation layer is built.

These are two different audiences and both must be served: **agents that shop the storefront**
(constraint A) and **agents that build the storefront** (constraint B).

## 2. Agent-native by construction

The five principles, and what each concretely means here:

| Principle | Implementation in Markii |
|---|---|
| **Agent UI parity** | Every builder capability — add block, move, restyle, bind data, publish — is an action in a shared registry. The editor UI calls actions; agents call the same actions. No screen-scraping, no separate agent code path, no capability that exists only in the UI. |
| **One shared action model** | An action is defined **once** (`defineAction`), and that definition becomes a UI mutation, an HTTP endpoint, an agent tool, and an MCP tool simultaneously. |
| **Shared state & context** | Agents read the same state the human sees: current page tree, selection, active breakpoint, draft-vs-published status, and the catalog data bound into the page. The database is the coordination layer. |
| **Protocol-ready** | A first-class MCP server exposes the action registry, so Claude Code, Cursor, and other MCP clients can build a Markii storefront without a bespoke integration. |
| **Governed execution** | Agents inherit the human permission model exactly (`docs/API.md` §16 roles). Every action is scoped, audited, and reversible via the version history. |

**Sequencing consequence — important.** `docs/PLAN.md` puts the Agent Ops *chat product* last
(Phase F). Agent-nativeness is **not** deferred with it: the action layer and MCP surface are built
**with** the builder in Phase D, because the article's core claim is right — you cannot bolt this
on afterward without rewriting the mutation layer. What ships last is the chat UI and the ops
agent's product packaging, not the architecture underneath it.

## 3. The action model

The central primitive. Everything mutating flows through it.

```ts
export const setNodeStyle = defineAction({
  id: "builder.setNodeStyle",
  description: "Set style properties on a page node at a given breakpoint.",
  input: z.object({
    pageId: z.string(),
    nodeId: z.string(),
    breakpoint: z.enum(["base", "sm", "md", "lg"]).default("base"),
    styles: styleSchema.partial(),
  }),
  permission: "cms.write",
  riskTier: "low",                  // see docs/AGENT-OPS.md §3
  undoable: true,
  async run(input, ctx) { /* single implementation */ },
});
```

One definition yields all of:

- **UI mutation** — the inspector dispatches `setNodeStyle`; no bespoke handler.
- **HTTP endpoint** — `POST /api/actions/builder.setNodeStyle`.
- **Agent tool** — name, description, and JSON schema derived from the definition.
- **MCP tool** — same, exposed over the MCP server.
- **CLI / scripting** — same registry, for power users and CI.

Rules: actions are the **only** mutation path (no route handler edits page state directly);
`input` is a zod schema and is the single source of truth for validation everywhere; `permission`
is checked server-side identically regardless of caller; `riskTier` decides whether an agent may
execute directly or must produce a proposal; `undoable` actions record an inverse for the undo
stack, which serves human undo/redo *and* agent rollback with one mechanism.

**Builder action set (launch):** `addBlock`, `moveBlock`, `duplicateBlock`, `removeBlock`,
`setProps`, `setNodeStyle`, `setBinding`, `setPageSeo`, `createPage`, `renamePage`, `setTheme`,
`setThemeTokens`, `saveCustomCode`, `publishPage`, `restoreVersion`.

**Read side.** Agents need context, not just verbs: `getPage` (tree + status), `getSelection`,
`getBlockRegistry` (what block types exist and their schemas), `getThemeTokens`, `renderPreview`
(HTML for a subtree), `getPageIssues` (pre-publish check results). An agent asked to "fix the
cramped mobile hero" reads the tree, inspects `sm` styles, and dispatches `setNodeStyle` — the same
three steps a human takes.

## 4. Document model

A page is a **versioned JSON node tree**, never an HTML string. HTML is a render target, not
storage — that is what lets the same document render in the editor, on the storefront, as a
protocol preview, and as a diff an agent proposes.

```ts
interface PageNode {
  id: NodeId;
  type: string;                    // registry key: "section" | "heading" | "product-grid" | …
  props: Record<string, unknown>;  // validated by the block's zod schema
  styles: {
    base: StyleProps;
    sm?: Partial<StyleProps>;      // breakpoint overrides
    md?: Partial<StyleProps>;
    lg?: Partial<StyleProps>;
  };
  bindings?: Record<string, string>; // prop → context path, e.g. { text: "product.title" }
  children?: PageNode[];
  customClass?: string;
  a11y?: { label?: string; role?: string };
  intent?: string;                 // optional human/agent-authored note: "hero, above the fold"
}

interface PageDocument {
  id: string; storeId: number;
  kind: "page" | "template";
  template?: "product" | "collection" | "blog-post" | "index" | "cart" | "search" | "404";
  handle: string; title: string;
  seo: { title?: string; description?: string; ogImage?: string; noindex?: boolean };
  tree: PageNode; themeId: string;
  version: number; status: "draft" | "published"; publishedVersion?: number;
  updatedAt: string;
}
```

`intent` is small but load-bearing for agent work: it gives an agent (and a returning human)
semantic context that raw structure loses. Optional, never required, never shown to shoppers.

**Global regions** (header, footer, announcement bar) are their own documents referenced by theme,
so editing them once updates every page.

## 5. Component registry ("stacks")

Every block type is registered once and declares everything the system needs — including everything
an agent needs to use it correctly without guessing.

```ts
interface BlockDefinition {
  type: string; label: string;
  category: "layout" | "content" | "commerce" | "media" | "form" | "advanced";
  icon: string;
  description: string;             // written for an agent as much as for a human
  schema: ZodSchema;               // props validation — single source of truth
  defaults: { props: object; styles: StyleProps };
  slots?: { name: string; accepts: string[] | "any"; min?: number; max?: number }[];
  render: (props, ctx) => ReactNode;      // server component → semantic HTML
  editorPanel: FieldSpec[];               // right-inspector fields, generated not hand-built
  semantics: { element: string; landmark?: string };
  jsonLd?: (props, ctx) => object | null; // structured-data contribution
  requiresData?: "product" | "collection" | "customer" | null;
  clientIsland?: boolean;                 // true only where interactivity is unavoidable
  usageHints?: string[];                  // "Use for the primary page headline, once per page"
}
```

`description` and `usageHints` are the agent-facing documentation, and they live **in the registry
rather than in a separate prompt** — one place to update, exposed via `getBlockRegistry` and MCP.
No block ships without `semantics`; commerce blocks must implement `jsonLd`.

**Launch set.** *Layout:* section, container, grid, columns, spacer, divider. *Content:* heading,
rich text, image, video, button, list, accordion, tabs, testimonial, FAQ (contributes `FAQPage`
JSON-LD). *Commerce:* product grid, product card, product detail (gallery, variant picker, add to
cart, price, stock), collection list, cart drawer, checkout button, recently viewed, upsell.
*Media:* gallery, slider, logo strip. *Form:* contact, newsletter. *Advanced:* custom code, embed.

## 6. Renderer

One renderer, four consumers:

| Consumer | Mode |
|---|---|
| Storefront | React Server Components → semantic HTML, zero editor runtime shipped |
| Editor canvas | Same tree, client-side, wrapped in selection/drop affordances |
| Protocol preview | Tree → `llms.txt` / `agent.md` / JSON-LD extraction (`docs/API.md` §11) |
| Agent proposal | Tree diff → human-readable summary + rendered before/after preview |

Rules: semantic output (`<section>`, `<article>`, `<h1>`–`<h6>`, `<nav>`, `<figure>`); heading
levels validated for correct nesting with editor warnings on skips; images always carry dimensions
and `alt` (empty `alt` must be an explicit decorative choice); JSON-LD from every block merged and
deduplicated into one `<script type="application/ld+json">`; interactivity islands-only and only
where `clientIsland: true`.

## 7. Style system

Token-driven, not free-form CSS. Themes define color, type scale, spacing scale, radii, shadows,
and breakpoints; blocks reference tokens.

- **Layout:** flow, flex, and grid only — no absolute positioning. Merchants set direction, gap,
  alignment, wrap, span.
- **Responsive:** mobile-first with `sm`/`md`/`lg` overrides; the editor shows which values are
  inherited vs overridden at the current breakpoint (and so does `getPage` for agents).
- **Contrast:** the color picker warns on WCAG AA failures for text pairs. Warn, don't block.
- **Compilation:** styles compile to a static stylesheet per published version — no inline style
  explosion, no runtime CSS-in-JS on the storefront.

Token-based styling is also what makes agent edits safe: an agent adjusting spacing picks from a
scale, so it cannot produce the visual drift that arbitrary pixel values invite.

## 8. Custom code

Four escalating levels, each with a distinct risk profile:

| Level | What | Controls |
|---|---|---|
| 1. Custom classes | `customClass` on any node, styled in theme CSS | None needed |
| 2. Theme CSS | Global stylesheet editor | Scoped to storefront; syntax-validated |
| 3. Custom code block | HTML/CSS/JS block placed in a page | Sanitized on save; script execution opt-in per block with explicit warning |
| 4. Theme/template code | Direct template and global-region editing, `<head>` injection | Developer/Owner roles only; versioned with diff and one-click revert |

**Security posture.** Custom code runs on the merchant's own storefront, so the primary risk is
self-inflicted — but Markii owns the blast radius: sanitize injected HTML against an allowlist,
strict storefront CSP with per-store nonces for approved scripts, block injection into `llms.txt` /
`agent.md` / `sitemap.xml` / checkout entirely, never expose session or payment context to custom
code, and run publish-time checks that warn when custom code breaks JSON-LD validity or the
performance budget.

**Agent-specific:** custom code is **high risk tier** — an agent may draft it, never execute it
unreviewed. Level 4 requires human approval unconditionally, with no auto-allow setting.

## 9. Data binding & templates

Template documents render against typed context — `product`, `collection`, `customer`, `cart`,
`store`. A node binds a prop to a context path:

```json
{ "type": "heading", "bindings": { "text": "product.title" },
  "props": { "level": 1, "text": "Sample Product" } }
```

`props` holds the design-time placeholder; `bindings` wins at render. The editor previews with real
catalog data (a selectable sample product), so merchants never design against lorem ipsum.
Repeaters iterate a bound collection and render their child subtree per item. Conditional
visibility supports a small whitelisted expression set (`product.stock > 0`,
`customer.loggedIn`) — a safe evaluator, never `eval`.

## 10. MCP server

"Protocol-ready by design" means a real MCP endpoint, not a promise. It exposes the action registry
(read tools always; write tools gated by the connected credential's role), the block registry as
discoverable capability, and store/page context resources.

The pitch this unlocks: **a developer can point Claude Code or Cursor at their Markii store and
build it conversationally**, while their non-technical colleague edits the same store visually, at
the same time, with the same permissions and the same audit trail. Neither view is a second-class
citizen — which is the whole point of agent-native.

Auth via scoped tokens tied to a staff member and role; every MCP call lands in the same audit log
as a UI click.

## 11. Editor UX

Four regions: left panel (page list, layer tree, block library), center canvas (breakpoint
switcher, selection, drop indicators), right inspector (content / style / advanced, generated from
`editorPanel`), top bar (undo/redo, preview, version history, publish).

**Accessibility is a launch requirement, not a follow-up.** Every drag-and-drop move, nest, and
reorder needs a keyboard equivalent via the layer tree and context menus, with live-region
announcements. A mouse-only builder excludes disabled merchants from running their own store.
(Pleasant side effect: the keyboard command path and the agent action path are the same underlying
actions, so building one hardens the other.)

Also required: undo/redo across every mutation (command stack over the action registry, not state
snapshots), autosave to draft with explicit save state, multi-select and bulk move, copy/paste
blocks within and across pages, reusable saved blocks, and per-region reset to theme default.

**Agent presence in the editor.** When an agent edits, the human sees it: changed nodes are
highlighted, the change appears in history attributed to the agent, and proposals surface as a
reviewable diff overlay rather than silent mutation. Concurrent human/agent editing needs a
conflict policy — last-write-wins with a visible warning at minimum, per-node locking if it proves
necessary in testing.

## 12. Versioning & publishing

Draft and published versions are separate rows; the storefront only reads `publishedVersion`.
Publishing is atomic across the page tree, compiled CSS, and referenced assets, and runs a
pre-publish check (broken links, missing alt text, heading order, JSON-LD validity, unbound
bindings, performance budget) — warnings inform, structural errors block. Version history offers
restore and diff, with agent-made versions labeled as such.

Publishing invalidates storefront caches by tag and must not break `sitemap.xml`, `llms.txt`, or
`agent.md` generation — those regenerate from the published tree.

**Publish is high risk tier**: agents propose, humans publish, unless a merchant explicitly opts
into auto-publish for a specific store.

## 13. Performance budget

Storefront pages: no editor runtime, no builder JS, compiled CSS under ~50 KB, images through the
Next image pipeline with explicit dimensions, LCP block server-rendered and never inside an island,
total client JS on a content page ideally zero. Cart and variant islands are the only sanctioned
interactivity.

The editor is dashboard-side and may be heavy, but lazy-loads the block library and virtualizes the
layer tree for large pages.

## 14. Migration from the current renderer

Today `app/%5Fsites/[site]/` renders fixed templates from `lib/storefront.ts`. Path forward: ship
those exact layouts as the **default theme** expressed as node documents, so every existing site
gets an editable equivalent of what it already has and nothing regresses. The current renderer
becomes the fallback for stores with no published document. Generators (`lib/generators.ts`) shift
from reading products directly to reading the published tree plus catalog data.

## 15. Build order

1. **Action registry + `defineAction` primitive** — first, because everything else routes through it
2. Node model, zod schemas, versioned persistence, migrations
3. Server renderer + default theme ported from current templates
4. Component registry with the layout/content launch set
5. Editor shell: layer tree, canvas, inspector, selection, undo/redo (over actions), autosave
6. Drag-and-drop **plus** the keyboard equivalent, breakpoint switcher, style tokens
7. **MCP server + agent tool exposure** — cheap once actions exist, and validates parity early
8. Commerce blocks (depends on Phase C: variants, cart, checkout)
9. Templates, data binding, repeaters, conditional visibility
10. Custom code levels 1–4, sanitization, CSP, publish-time checks
11. Publish pipeline, version history, pre-publish checks, cache invalidation
12. Content surfaces: blog, menus, SEO fields, redirects, forms

Steps 1 and 7 are what make this agent-native rather than agent-compatible. Do not defer them into
Phase F with the chat UI.

## 16. Open decisions

- **Cloneability / code export.** The article argues agent-native products should let users own the
  code and database. For Markii this could be a genuine anti-lock-in differentiator against Shopify
  ("export your store as a Next.js app") — or a support and security burden. Not decided; decide
  before the theme system hardens, since export shape constrains it.
- Do merchants get raw template-language access, or only the four custom-code levels?
- Theme marketplace; theme export/import between stores.
- Concurrent-editing conflict policy: last-write-wins with warning, or per-node locking?
- Whether agents may auto-execute low-risk builder actions (spacing, alt text) without a proposal —
  and whether that is per-store configurable.
- Multi-language content model — deferred, but the node model must not foreclose it.
