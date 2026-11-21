import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The renderer's boundary (D53). The drawing code — what turns a node tree
 * into HTML, Markdown and JSON-LD — lives in `packages/renderer/`, which is
 * **Apache 2.0** (its own `LICENSE` and `NOTICE`) while the rest of Markii
 * stays FSL, because a store's Next.js export ships it. **An Apache release
 * cannot be withdrawn**, so anything that drifts across this line would be
 * permissively licensed for good.
 *
 * So every file in the package may import only other files in the package and
 * the third-party packages below. Not the database, the actions, storage,
 * auth, `server-only`, or Markii's components — what the drawing code needs
 * from outside arrives through its render context (`catalog.ts`, `membersOf`,
 * `ProductPurchase.buy`). This test sits outside the package on purpose: the
 * guard of the line is FSL, like everything else that is not drawing code.
 */

const ROOT = resolve(__dirname, "../..");
const PKG = "packages/renderer";
const SRC = `${PKG}/src`;

/** Third-party code the drawing code may use — the package's peer dependencies, and Node's crypto for content hashes. */
const PACKAGES = new Set(["react", "zod", "cheerio", "node:crypto"]);
/** What may sit beside `src/` — nothing that is code. */
const PACKAGE_FILES = new Set(["LICENSE", "NOTICE", "README.md", "package.json", "src", "next-app"]);
/** The exported app's scaffold — Apache too, shipped in every Next.js export. */
const APP = `${PKG}/next-app`;
/** What the scaffold may import besides itself and the renderer. */
const APP_PACKAGES = new Set(["next", "next/headers", "next/navigation", "next/server", "react", "server-only"]);

function specifiers(source: string): string[] {
  const out: string[] = [];
  const re = /(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of source.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function resolveModule(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith("@markii/renderer/")) base = join(ROOT, SRC, spec.slice("@markii/renderer/".length));
  else if (spec.startsWith(".")) base = resolve(dirname(join(ROOT, from)), spec);
  else return null;
  for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx", ""]) {
    try {
      if (statSync(base + ext).isFile()) return relative(ROOT, base + ext).replace(/\\/g, "/");
    } catch {
      // try the next extension
    }
  }
  throw new Error(`${from}: cannot resolve "${spec}"`);
}

function packageFiles(): string[] {
  return readdirSync(join(ROOT, SRC))
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => `${SRC}/${f}`);
}

function violations(): string[] {
  const out: string[] = [];
  for (const file of packageFiles()) {
    const source = readFileSync(join(ROOT, file), "utf8");
    const isTest = file.endsWith(".test.ts");
    if (/^\s*["']use client["']/m.test(source)) out.push(`${file} is a client module`);
    for (const spec of specifiers(source)) {
      if (spec === "server-only") {
        out.push(`${file} imports server-only`);
        continue;
      }
      // A spec file may use the test runner; nothing else may.
      if (isTest && spec === "vitest") continue;
      if (spec.startsWith("@/") || spec.startsWith("@markii/")) {
        out.push(`${file} imports ${spec} by an alias — inside the package, imports are relative so it stands alone`);
        continue;
      }
      const target = resolveModule(file, spec);
      if (target === null) {
        if (!PACKAGES.has(spec)) out.push(`${file} imports the package "${spec}"`);
        continue;
      }
      if (!target.startsWith(`${SRC}/`)) out.push(`${file} imports ${target}`);
    }
  }
  return out;
}

function appFiles(): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${name}`;
      if (statSync(join(ROOT, rel)).isDirectory()) visit(rel);
      else if (/\.tsx?$/.test(name)) out.push(rel);
    }
  };
  visit(APP);
  return out;
}

/** The scaffold imports only itself, the renderer by its package name, and Next and React — never Markii's own code. */
function appViolations(): string[] {
  const out: string[] = [];
  for (const file of appFiles()) {
    for (const spec of specifiers(readFileSync(join(ROOT, file), "utf8"))) {
      if (spec.startsWith("@markii/renderer/")) {
        resolveModule(file, spec);
        continue;
      }
      if (spec.startsWith("@/")) {
        out.push(`${file} imports ${spec} — Markii's own code does not ship in an export`);
        continue;
      }
      const target = resolveModule(file, spec);
      if (target === null) {
        if (!APP_PACKAGES.has(spec)) out.push(`${file} imports the package "${spec}"`);
      } else if (!target.startsWith(`${APP}/`)) {
        out.push(`${file} imports ${target} by a relative path — use @markii/renderer/*`);
      }
    }
  }
  return out;
}

describe("the renderer's boundary (D53)", () => {
  it("the exported app's scaffold reaches nothing of Markii's but the renderer", () => {
    expect(appFiles().length).toBeGreaterThan(5);
    expect(appViolations()).toEqual([]);
  });

  it("imports nothing outside the package", () => {
    expect(violations()).toEqual([]);
  });

  it("holds the drawing code and nothing beside it but its licence and manifest", () => {
    const files = packageFiles();
    for (const entry of ["render.tsx", "to-markdown.ts", "views.ts", "block-css.ts", "tokens.ts", "theme-package.ts", "catalog.ts"]) {
      expect(files, entry).toContain(`${SRC}/${entry}`);
    }
    expect(readdirSync(join(ROOT, PKG)).filter((f) => !PACKAGE_FILES.has(f))).toEqual([]);
    expect(readFileSync(join(ROOT, PKG, "LICENSE"), "utf8")).toContain("Apache License");
    expect(JSON.parse(readFileSync(join(ROOT, PKG, "package.json"), "utf8")).license).toBe("Apache-2.0");
  });

  it("never holds Markii's server-side builder modules", () => {
    for (const forbidden of ["store", "queries", "lease", "preview", "theme-assets", "theme-import"]) {
      expect(packageFiles(), forbidden).not.toContain(`${SRC}/${forbidden}.ts`);
    }
  });

  it("the walker would catch a crossing — it is not passing vacuously", () => {
    expect(specifiers('import type { Product } from "@/lib/db";\nimport x from "./y";')).toEqual(["@/lib/db", "./y"]);
    expect(packageFiles().length).toBeGreaterThan(10);
  });
});
