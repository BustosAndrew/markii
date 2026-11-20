# Markii renderer — Apache 2.0 (not populated yet)

This folder is where Markii's **drawing code** moves when it is split out of `lib/builder/` (D53,
`docs/DECISIONS.md`): the code that turns a page's node tree into HTML, Markdown and JSON-LD, which a
store's Next.js export ships.

**Only what is in this folder is Apache 2.0**, under the `LICENSE` and `NOTICE` beside this file.
Today that is nothing but these three files. Everything else in the repository — including the
drawing code while it still lives in `lib/builder/` — is under the repository's root `LICENSE`
(FSL-1.1-ALv2).

What may move here is fixed by `lib/builder/renderer-boundary.test.ts`: the drawing code and the three
pure modules it adopts, never data access, the action registry, checkout, billing, payments, agents
or the editor. **An Apache release cannot be withdrawn**, so nothing crosses that line by accident.
