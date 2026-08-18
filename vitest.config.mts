import { defineConfig } from "vitest/config";

/**
 * Three suites, deliberately separated by what they need to run.
 *
 * **`unit`** covers the pure money and rule functions — discount amounts, tax
 * extraction, rate eligibility, zone resolution. No database, no server, no
 * network. These are the calculations that decide what a shopper is charged, so
 * they should be runnable by anyone who has cloned the repo, in a second.
 *
 * **`integration`** drives real HTTP against a running dev server and a real
 * Postgres. It is what caught every bug worth catching so far — the cart wiping
 * its own shipping address, a free-shipping rate inverted in both directions, a
 * metering base that disagreed with the pricing spec. None of those are
 * reachable from a unit test, because each lived in the wiring rather than the
 * arithmetic.
 *
 * **`components`** renders React components against a DOM, with the network
 * mocked. It exists because the two worst bugs found in the storefront cart were
 * both invisible to everything else here: a raw state enum printed to shoppers
 * ("Tax (not_configured)"), and a tax-inclusive store displaying "Tax $0.00"
 * while really charging tax. Neither is a type error, neither is reachable from
 * an integration test — the island renders in a browser — and both were found
 * only by a human looking at the page. This suite is what makes them
 * regressions instead of rediscoveries.
 *
 * It is **not** a general component-testing mandate. It covers surfaces where a
 * wrong render misstates money or blocks a sale, which is a much smaller set
 * than "every component".
 *
 * They are separate projects rather than one suite because the integration
 * tests **write to a real database** and must never run by accident — see
 * `tests/integration/setup.ts` — and because the DOM suite needs an
 * environment the other two must not pay for.
 */

const shared = {
  resolve: {
    tsconfigPaths: true,
    alias: {
      /**
       * `server-only` is a build-time marker: Next resolves it to a module that
       * throws if imported from a client bundle. It has no runtime meaning and
       * no resolvable entry point outside a Next build, so importing any module
       * that uses it would otherwise fail here. Stubbing it keeps the guarantee
       * where it belongs — in `next build` — without making server modules
       * untestable.
       */
      "server-only": new URL("./tests/stubs/server-only.ts", import.meta.url).pathname,
    },
  },
};

export default defineConfig({
  ...shared,
  test: {
    projects: [
      {
        ...shared,
        test: {
          name: "unit",
          include: ["lib/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        ...shared,
        test: {
          name: "components",
          include: ["components/**/*.test.tsx"],
          /**
           * `happy-dom` rather than `jsdom`: it starts in a fraction of the
           * time, and nothing here needs the corners of the DOM spec where the
           * two differ. Swap it if a test ever does.
           */
          environment: "happy-dom",
        },
      },
      {
        ...shared,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          globalSetup: ["tests/integration/setup.ts"],
          // One database, one dev server: parallel files would race on the
          // shared fixtures they create and clean up.
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
