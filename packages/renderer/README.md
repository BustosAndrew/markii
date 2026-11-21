# @markii/renderer — Apache 2.0

Markii's **drawing code** (D53, `docs/DECISIONS.md`): what turns a page's node tree into HTML,
Markdown and JSON-LD, plus the node model, tree operations, block definitions, bindings, styles,
design tokens, the theme-package format, and currency formatting. Markii's own storefront draws with
it, and a store's Next.js export ships it, so the two cannot drift apart.

**Only what is in this folder is Apache 2.0**, under the `LICENSE` and `NOTICE` beside this file.
Everything else in the repository is under the root `LICENSE` (FSL-1.1-ALv2). The Apache licence does
not grant use of the Markii name or logo — see `TRADEMARK.md` at the repository root.

## The rule this folder keeps

Every file in `src/` imports only other files in `src/` and `react`, `zod`, `cheerio` and
`node:crypto`. Data access, the action registry, checkout, billing, payments, agents and the editor
stay outside; what drawing needs from them arrives through the render context (`src/catalog.ts`,
`membersOf`, `ProductPurchase.buy`). `lib/builder/renderer-boundary.test.ts` enforces it. **An Apache
release cannot be withdrawn**, so nothing crosses that line by accident.

`next-app/` is the scaffold of a store's Next.js export — Apache too, shipped in every export with
`src/`. It imports only itself, `@markii/renderer/*`, Next and React; the same test holds it.

Inside Markii it is imported as `@markii/renderer/<module>` through a tsconfig path alias; it is not
published to a registry yet.
