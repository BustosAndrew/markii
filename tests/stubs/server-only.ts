/**
 * Test stub for the `server-only` package.
 *
 * In a Next build, importing `server-only` from a client component is a build
 * error — that is the entire feature, and it is enforced by the bundler, not at
 * runtime. Outside a Next build the package has no resolvable entry point, so
 * any module marked server-only would be unimportable in tests.
 *
 * This empty module stands in for it. The guarantee is unaffected: `next build`
 * still uses the real package and still fails on a client import. Aliased in
 * `vitest.config.mts`.
 */
export {};
