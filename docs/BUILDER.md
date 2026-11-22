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

**Sequencing consequence — important, and revised 2026-07-29.** Agent-nativeness cannot be bolted
on afterward without rewriting the mutation layer, so the pieces are split across phases rather than
all landing with the builder:

| Piece | When | Why |
|---|---|---|
| **`defineAction` primitive + registry** | **Phase C** (commerce) | ~a day of work. If Phase C's commerce mutations ship as plain route handlers they all get refactored later — the exact bolt-on failure this design prevents. See `docs/BACKEND.md` §1 |
| Builder-specific actions | Phase D | Depend on the node model |
| ~~**MCP server**~~ | ✅ **Shipped 2026-09-07, ahead of Phase D** | It was cheap once the registry existed, exactly as predicted — and it validated parity early, which is why it was worth pulling forward. See §10 |
| Agent Ops chat UI | Phase F | Product packaging, not architecture |

So the registry is in use from the first commerce mutation onward, and Phase D adds the builder's
actions and the protocol surface on top of something already proven.

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

## 10. MCP server — ✅ BUILT (2026-09-07)

"Protocol-ready by design" means a real MCP endpoint, not a promise. `POST /api/mcp` is that
endpoint. **Connecting a client is `docs/MCP.md`; the contract is `docs/API.md` §22.** This section
is the architecture and what it deliberately does not do.

It exposes the action registry as tools — read tools always, write tools gated by the connected
credential's role, which held up exactly as written here. Auth is a scoped token tied to a staff
role, and every call lands in the same audit log as a UI click, including the refusals.

The pitch this unlocks: **a developer can point Claude Code or Cursor at their Markii store and
build it conversationally**, while their non-technical colleague edits the same store visually, at
the same time, with the same permissions and the same audit trail. Neither view is a second-class
citizen — which is the whole point of agent-native.

**Two things this section used to promise that are not built**, called out rather than quietly
dropped:

- **The block registry as a discoverable capability.** There is no node model yet — that is Phase D,
  and the builder actions it would advertise do not exist. Nothing to discover until they do.
- **Store and page context as `resources/*`.** `initialize` does not advertise the capability. Page
  context waits on the same node model; store context is served by the ten `read_*` tools instead,
  which is the better fit for *querying* — resources are for context a client pins into a
  conversation, not for lookups.

**What building it early actually bought**, since "validates parity" was the stated reason: it
forced §22 rule 3 to become real. "A `high` action always requires human approval" had been enforced
by nothing — advertised in the registry, checked nowhere — which was survivable while every caller
was a dashboard click and untenable the moment a token became the front door, because tokens are
exempt from step-up. It also found that authorization refusals were never reaching the audit log at
all. Both were pre-existing holes in the *registry*, not in MCP; the surface just made them
load-bearing.

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
restore and diff, with agent-made versions labeled as such. **The diff is built (2026-11-21)** —
`GET /api/builder/sites/:idOrSlug/diff` over a pure `lib/builder/design-diff.ts`, comparing any two of
the draft, the live design and a stored version. Nodes are followed by id, which publish and restore
keep. "Agent-made versions" never arise: agents cannot publish (D51), so every version names a person.

Publishing invalidates storefront caches by tag and must not break `sitemap.xml`, `llms.txt`, or
`agent.md` generation — those regenerate from the published tree.

**Publish is high risk tier**: agents propose, humans publish, unless a merchant explicitly opts
into auto-publish for a specific store.

## 13. Performance budget

Storefront pages: no editor runtime, no builder JS, compiled CSS under ~50 KB, images through the
Next image pipeline with explicit dimensions, LCP block server-rendered and never inside an island,
total client JS on a content page ideally zero. Cart and variant islands are the only sanctioned
interactivity.

**Built:** the CSS budget is the `CSS_BUDGET` pre-publish warning (M6), and **the lead image loads
eagerly as of 2026-11-21** — the first `image` or `productGallery` inside a page's first top-level block
gets `loading="eager"` and `fetchpriority="high"` (`leadImageId` in `packages/renderer/src/render.tsx`),
as does the fixed product page's first photo. Every image had been `loading="lazy"`, so the hero — the
page's LCP — waited for layout. Only the first block is looked in: a high-priority fetch below the fold
competes with what the shopper sees first. **Explicit image dimensions are not done**: no upload records
an image's size, so there is nothing to write into `width`/`height` yet.

The editor is dashboard-side and may be heavy, but lazy-loads the block library and virtualizes the
layer tree for large pages.

## 14. Migration from the current renderer

Today `app/%5Fsites/[site]/` renders fixed templates from `lib/storefront.ts`. Path forward: ship
those exact layouts as the **default theme** expressed as node documents, so every existing site
gets an editable equivalent of what it already has and nothing regresses. The current renderer
becomes the fallback for stores with no published document. Generators (`lib/generators.ts`) shift
from reading products directly to reading the published tree plus catalog data.

## 15. Build order

**Started 2026-10-31 (D51).** M1 — steps 1–4 below plus the publish half of step 11 (atomic
publish, version snapshots, restore, pre-publish checks) — is built: `lib/builder/`,
`lib/actions/definitions/builder.ts`, `docs/API.md` §19. Next are the editor and live preview (M2),
then the brand agent (M3). Cache invalidation is moot for now: `loadSite` reads per request.
**M2 is built (2026-11-01)** — step 5 and part of 6: the editor shell (layers, block library,
inspector generated from `editorPanel`, pages, theme, undo/redo over registry undo, publish with
checks, history) and a live preview that is the storefront renderer itself on its own origin. The
canvas is the real page in an iframe rather than an in-editor re-render, so preview and storefront
cannot diverge. Drag-and-drop lives in the layer tree, with Alt+arrow keyboard equivalents.
**M3 is built (2026-11-02)** — the brand agent, docked in the editor (`docs/API.md` §27). It edits the
draft directly through the `agentExecution: "draft"` actions, holds the edit lease while it works,
and is told at the start of every turn what the draft looks like now and what the merchant changed
since it last spoke.
**M4 is built (2026-11-03)** — step 9 and the menus of step 12: product and collection templates,
the announcement bar, header and footer as global regions (§4), data bindings, repeaters and
conditional visibility (§9). Two decisions §9 left open: conditions are **structured** (`{ path, op,
value }`) rather than a parsed expression — the same whitelist, with nothing to parse — and
`customer.loggedIn` is **not** offered, because no storefront render reads the shopper's session
today and a per-shopper page is a caching decision of its own. Menus are a `navMenu` block in a
region, not a separate table. The editor previews a template against the store's first product or
collection and follows links inside the preview to any other.
**M5 is built (2026-11-12)** — §6's protocol-preview consumer and §14's generators: the sitemap,
`llms.txt` and a new `llms-full.txt` read the published pages (`noindex` ones excluded from all
three), the Markdown is rendered from the tree with the HTML's bindings and visibility, and the
renderer contributes `WebPage`, `FAQPage` and `ItemList` JSON-LD — commerce blocks now implement
§5's `jsonLd` requirement. Product data still comes from the catalogue, never from a block.
**M6 is built for levels 1–3 without scripts (2026-11-13)** — custom classes, theme CSS (checked on
save, `high`), and a custom HTML block rebuilt from an allowlist on save and on render. Custom code is
a person's alone — agents and API tokens are refused it through every action that could write it —
and none of it runs on the cart or account pages or reaches the agent documents. **Custom scripts
are built too (owner decision 2026-11-13)**: head snippets only — `<script>`, verification `<meta>`,
preconnects and `<noscript>` pixels — written by a person holding `cms.scripts` with a fresh second
factor, published with the design, and run on every storefront page except the cart, account and
preview. **No script inside a custom HTML block** (level 3's opt-in block scripts were declined). The
storefront CSP ships with them: a per-request nonce with `'strict-dynamic'`, and the cart and account
limited to the store and Stripe. Building it found that `SameSite=Lax` does not separate sibling
subdomains, so `proxy.ts` now refuses cookie-carrying cross-origin writes on every host.
**M7 is built (2026-11-14)** — the rest of §11: a breakpoint switcher that also sets the preview width,
inherited-versus-overridden styles in the inspector, multi-select and bulk move (`builder.moveNodes`,
one undo), copy/paste within and across pages, reusable saved blocks per site, an explicit save state,
and a keyboard-complete layer tree (one tab stop, arrow-key navigation, every action announced).

0. **Action registry + `defineAction` primitive** — built back in **Phase C** (`docs/BACKEND.md` §1),
   so it already exists and commerce mutations already use it
1. Builder-specific actions registered against it
2. Node model, zod schemas, versioned persistence, migrations
3. Server renderer + default theme ported from current templates
4. Component registry with the layout/content launch set
5. Editor shell: layer tree, canvas, inspector, selection, undo/redo (over actions), autosave
6. Drag-and-drop **plus** the keyboard equivalent, breakpoint switcher, style tokens
7. ~~**MCP server + agent tool exposure**~~ — ✅ done 2026-09-07, pulled ahead of this list. Builder-specific tools join it automatically the day they are defined, since it renders whatever the registry holds
8. Commerce blocks (depends on Phase C: variants, cart, checkout)
9. Templates, data binding, repeaters, conditional visibility
10. Custom code levels 1–4, sanitization, CSP, publish-time checks
11. Publish pipeline, version history, pre-publish checks, cache invalidation
12. Content surfaces: blog, menus, SEO fields, redirects, forms — **menus (M4), SEO fields (M5) and
    redirects (2026-11-21, migration 0051, `docs/API.md` §19) and the blog (2026-11-22, migration 0052)
    are built; forms are not.** Posts are their own table with a Markdown body, outside the
    design's site-wide publish and its snapshots, so a post goes live alone and a design restore leaves
    posts where they are.
    Redirects fire only where the storefront would 404 and are live when saved, outside the draft:
    they cannot hide a page that exists, so publish has nothing to protect there.

Steps 1 and 7 are what make this agent-native rather than agent-compatible. Do not defer them into
Phase F with the chat UI.

## 16. Open decisions

- ~~Cloneability / code export~~ — **decided 2026-11-19 (D53): yes, two forms.** A **store export**
  (catalog, customers, orders, files, design) that a self-hosted Markii imports, and **the storefront
  as a Next.js app** the merchant deploys anywhere, running headless against the store's own
  storefront API. **One renderer, not two:** the block registry, `render.tsx`, bindings and the
  agent-document generators become a package that both Markii's storefront and the exported app
  import, so an export cannot render, or describe to agents, differently from the live store. **The
  boundary is drawn as of 2026-11-20 (stage 1 of the split), and a test holds it.** The drawing
  code — everything reachable from `render.tsx`, `to-markdown.ts`, `views.ts`, `block-css.ts`,
  `tokens.ts`, `theme-package.ts`, `product-card.tsx`, `catalog.ts` and `format.ts` — imports only
  itself, `react`, `zod`, `cheerio`, `node:crypto`, and three pure modules that move with it
  (`packages/renderer/src/money.ts`, `packages/renderer/src/themes.ts`, `lib/api/types.ts`);
  `lib/builder/renderer-boundary.test.ts` walks the imports and refuses anything else (falsified: a
  type-only `@/lib/db` import in `views.ts` fails it). What used to cross the line now arrives
  through the render context: **the catalogue as the renderer's own shapes** (`packages/renderer/src/catalog.ts`
  — database rows fit them as they are), **collection lookups as `membersOf(handle, limit)`** (Markii's
  side is `membersByHandle` in `lib/storefront/collections.ts`), and **the cart as a rendered element**
  (`ProductPurchase.buy` — the product route renders `AddToCart`, the renderer only places it).
  `formatPrice` and `ProductCard` moved in, and their old homes re-export them. **Stage 2 is built
  (2026-11-20): the drawing code is `packages/renderer/` (`@markii/renderer/*`), Apache 2.0 with
  `Copyright 2026 Markii`**, and the boundary test now walks every file in it. Never add a `@/lib/db` read, a server-only module or a client island to the drawing
  code — the test will say so. **The package is Apache 2.0; the rest of
  Markii stays FSL** (D53) — so nothing outside the drawing code may move into it, since anything
  that does is permissively licensed for good from its first release. **The storefront API is not yet enough
  to run headless** (checked 2026-11-19): it has cart, checkout, search, shopper auth and memberships,
  but no product, collection, category or published-design reads, and shopper sessions are host-only
  cookies — an app on another origin meets the cross-origin write guard in `proxy.ts` by design. A
  headless export needs those reads plus a non-cookie shopper credential, decided with the same care
  as D30. **Both answered 2026-11-20**: the read API is built (`docs/API.md` §23), and there is no
  shopper credential — the export's sign-in is its owner's, and its server vouches for a shopper with
  a per-store storefront secret key (migration 0050). **The Next.js export is built (2026-11-20)** —
  `packages/renderer/next-app/` is the scaffold it ships, Apache like the renderer.
- Do merchants get raw template-language access, or only the four custom-code levels?
- ~~Theme marketplace; theme export/import between stores~~ — **decided 2026-11-19 (D53): yes to
  both, on one format.** The **theme package** (node documents for pages, templates and regions;
  tokens; theme CSS; saved blocks; versioned JSON) is the unit for store-to-store copy, the
  marketplace. (**The store export carries the design as rows instead** — draft, published and history —
  built 2026-11-21; a package drops the unpublished work and history a store moving house needs.) Rules every new block and binding must keep
  from now on, so packages stay portable:
  - **Store data only through bindings or slugs/handles, never by row id.** A product or collection
    id means nothing in another store. Today's blocks already comply (`productGrid`, `productCard`
    use `categorySlug`, `collectionHandle`, `productSlug`); a handle the importing store lacks must
    render empty, not fail.
  - **Images travel inside the package** (built 2026-11-19, `packages/renderer/src/theme-package.ts`
    `mapImages`). An image can sit in four places — a block prop whose editor field is `kind:
    "image"` (found from the registry, so a new image prop joins on its own), a page's
    `seo.ogImage`, custom HTML `<img src>`, theme CSS `url()` — and one walker covers all four. A
    same-org copy keeps the URLs; an export copies the store's own uploads in as `asset:{sha256}`;
    import checks hash, size and file signature and stores them content-addressed in the importing
    org's `public-media`. Bounded by the package's own limits (100 images, 5 MB each, 25 MB), **not
    the storage quota**, which meters only files merchants sell (G5). External URLs are kept and
    reported; a marketplace submission will refuse them until bundled. Product images are not theme
    assets — they come from the importing store's catalog through bindings. **A new place that can
    hold an image URL must join `mapImages`**, or a package silently ships a link back to the seller's
    store. The blog, forms and anything else that adds an image field inherit this rule.
  - **Import is a draft edit by a person**, through the registry (`builder.copyDesign`,
    `builder.importTheme`, both `high`); it never publishes. Every tree is validated and custom HTML
    rebuilt from the allowlist again on import.
  - **Head scripts never travel** — not in a marketplace theme, a file or a store-to-store copy. The
    importing store keeps its own; copying one across is `builder.setHeadCode`, with step-up.
  - **Markii is never in a paid theme's funds flow** (D4). Paid-versus-free-only, licensing and
    designer review are still open and go to counsel with the licence.
- ~~Concurrent-editing conflict policy~~ — **decided 2026-10-31 (D51): one writer at a time.** Writes
  to a site are serialised on its design row, and while the brand agent works it holds a lease that
  refuses every other writer (`AGENT_EDITING`) until stopped or expired.
- ~~Whether agents may auto-execute low-risk builder actions~~ — **decided 2026-10-31 (D51): yes, on
  the draft only**, for the brand agent; publishing stays human. Not per-store configurable.
- Multi-language content model — deferred, but the node model must not foreclose it.
