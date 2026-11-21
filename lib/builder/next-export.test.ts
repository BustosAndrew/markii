import { describe, expect, it } from "vitest";
import { nextExportFiles } from "./next-export";

/**
 * The Next.js export (D53): what the merchant downloads. It must be a whole
 * project, Apache throughout, with no test files, nothing from the FSL side,
 * and no secret — the storefront key is theirs to set on their own host.
 */
describe("the Next.js export's files", () => {
  const files = nextExportFiles({ slug: "leaf", name: "Leaf & Co", url: "https://leaf.markii.shop" });
  const paths = files.map((f) => f.path);
  const text = (p: string) => {
    const f = files.find((x) => x.path === p);
    if (!f) throw new Error(`missing ${p}`);
    return typeof f.data === "string" ? f.data : Buffer.from(f.data).toString("utf8");
  };

  it("is a whole Next.js project around the renderer", () => {
    for (const p of ["package.json", "tsconfig.json", "next.config.ts", "README.md", ".env.example", "app/layout.tsx", "app/page.tsx", "app/p/[slug]/page.tsx", "app/cart/add/route.ts", "lib/shopper.ts", "renderer/src/render.tsx"]) {
      expect(paths, p).toContain(p);
    }
    expect(JSON.parse(text("tsconfig.json")).compilerOptions.paths).toEqual({ "@markii/renderer/*": ["./renderer/src/*"] });
    const manifest = JSON.parse(text("package.json"));
    expect(manifest.name).toBe("leaf-storefront");
    expect(Object.keys(manifest.dependencies).sort()).toEqual(["cheerio", "next", "react", "react-dom", "zod"]);
  });

  it("is Apache throughout, and carries no tests and no Markii code", () => {
    expect(text("LICENSE")).toContain("Apache License");
    expect(text("renderer/LICENSE")).toContain("Apache License");
    expect(JSON.parse(text("package.json")).license).toBe("Apache-2.0");
    expect(paths.filter((p) => p.endsWith(".test.ts"))).toEqual([]);
    for (const f of files) {
      if (/\.tsx?$/.test(f.path)) expect(text(f.path), f.path).not.toMatch(/from ["']@\/|import ["']@\//);
    }
  });

  it("names the store and no secret", () => {
    expect(text(".env.example")).toContain("MARKII_STORE_URL=https://leaf.markii.shop");
    expect(text(".env.example")).toMatch(/^MARKII_STOREFRONT_KEY=$/m);
    expect(files.some((f) => (typeof f.data === "string" ? f.data : Buffer.from(f.data).toString("utf8")).includes("mksk_live_") && !f.path.endsWith(".md") && f.path !== "lib/markii.ts")).toBe(false);
  });
});
