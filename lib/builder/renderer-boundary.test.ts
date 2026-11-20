import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The renderer's boundary (D53). The drawing code — what turns a node tree
 * into HTML, Markdown and JSON-LD — is what a store's Next.js export ships,
 * under Apache 2.0 once it is its own package, while the rest of Markii stays
 * FSL. **An Apache release cannot be withdrawn**, so anything that drifts
 * across this line before the split would be permissively licensed for good.
 *
 * This walks every module reachable from the renderer's entry points and
 * refuses an import of anything outside the drawing code: the database, the
 * actions, storage, auth, Markii's components. What the drawing code needs from
 * outside arrives through its context instead (`./catalog`, `membersOf`,
 * `ProductPurchase.buy`).
 */

const ROOT = resolve(__dirname, "../..");

/** What the package exports — the renderer, its Markdown and JSON-LD, the theme format. */
const ENTRY_POINTS = [
  "lib/builder/render.tsx",
  "lib/builder/to-markdown.ts",
  "lib/builder/views.ts",
  "lib/builder/block-css.ts",
  "lib/builder/tokens.ts",
  "lib/builder/theme-package.ts",
  "lib/builder/product-card.tsx",
  "lib/builder/catalog.ts",
  "lib/builder/format.ts",
];

/** Third-party code the drawing code may use. */
const PACKAGES = new Set(["react", "zod", "cheerio", "node:crypto"]);

/**
 * Pure modules outside `lib/builder/` that belong to the drawing code and move
 * into the package with it: theme definitions and currency formatting. They
 * are walked like any other, so they may not reach further out either.
 */
const ADOPTED = new Set(["lib/api/money.ts", "lib/storefront/themes.ts", "lib/api/types.ts"]);

function specifiers(source: string): string[] {
  const out: string[] = [];
  const re = /(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of source.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function resolveModule(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(join(ROOT, from)), spec);
  else return null;
  for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx", ""]) {
    try {
      readFileSync(base + ext);
      return relative(ROOT, base + ext).replace(/\\/g, "/");
    } catch {
      // try the next extension
    }
  }
  throw new Error(`${from}: cannot resolve "${spec}"`);
}

function walk(): { modules: Set<string>; violations: string[] } {
  const modules = new Set<string>();
  const violations: string[] = [];
  const queue = [...ENTRY_POINTS];
  while (queue.length) {
    const file = queue.shift()!;
    if (modules.has(file)) continue;
    modules.add(file);
    const source = readFileSync(join(ROOT, file), "utf8");
    if (/^\s*["']use client["']/m.test(source)) violations.push(`${file} is a client module`);
    for (const spec of specifiers(source)) {
      if (spec === "server-only") {
        violations.push(`${file} imports server-only`);
        continue;
      }
      const target = resolveModule(file, spec);
      if (target === null) {
        if (!PACKAGES.has(spec)) violations.push(`${file} imports the package "${spec}"`);
        continue;
      }
      if (!target.startsWith("lib/builder/") && !ADOPTED.has(target)) {
        violations.push(`${file} imports ${target}`);
        continue;
      }
      queue.push(target);
    }
  }
  return { modules, violations };
}

describe("the renderer's boundary (D53)", () => {
  const { modules, violations } = walk();

  it("imports nothing outside the drawing code", () => {
    expect(violations).toEqual([]);
  });

  it("does not reach Markii's server-side builder modules", () => {
    for (const forbidden of ["store", "queries", "lease", "preview", "theme-assets", "theme-import"]) {
      expect(modules.has(`lib/builder/${forbidden}.ts`), forbidden).toBe(false);
    }
  });

  it("the walker would catch a crossing — it is not passing vacuously", () => {
    expect(specifiers('import type { Product } from "@/lib/db";\nimport x from "./y";')).toEqual(["@/lib/db", "./y"]);
    expect(modules.size).toBeGreaterThan(ENTRY_POINTS.length);
  });
});
