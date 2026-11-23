import "server-only";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import pkg from "@/package.json";
import type { ZipEntry } from "@/lib/zip";

/**
 * The storefront as a Next.js app the merchant owns (D53) — the files of the
 * project, ready to zip.
 *
 * **Everything in it is Apache 2.0**: the renderer (`packages/renderer/src`,
 * tests left out), the app scaffold (`packages/renderer/next-app`), and their
 * `LICENSE` and `NOTICE`. Nothing from the FSL side is copied, which is what
 * the package boundary (`lib/builder/renderer-boundary.test.ts`) guarantees for
 * the renderer and this module's own walk guarantees for the scaffold. The
 * handful of files written here — `package.json`, `tsconfig.json`,
 * `.env.example`, `.gitignore` — are configuration naming the store.
 *
 * **No secret is ever written into it.** The store's URL is public; the
 * storefront key, if the merchant wants members-only sales, is theirs to put
 * in their host's environment, never in a file Markii hands out.
 *
 * The source is read from disk at request time, so the route that calls this
 * is named in `next.config.ts` `outputFileTracingIncludes` — without that the
 * deployed function would not carry these files.
 */

const PKG = join(process.cwd(), "packages", "renderer");

function walk(dir: string, skip: (rel: string) => boolean): { rel: string; abs: string }[] {
  const out: { rel: string; abs: string }[] = [];
  const visit = (d: string) => {
    for (const name of readdirSync(d)) {
      const abs = join(d, name);
      const rel = relative(dir, abs).replace(/\\/g, "/");
      if (skip(rel)) continue;
      if (statSync(abs).isDirectory()) visit(abs);
      else out.push({ rel, abs });
    }
  };
  visit(dir);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

const versionOf = (name: string): string => {
  const all = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>;
  const v = all[name];
  if (!v) throw new Error(`${name} is not a Markii dependency`);
  return v;
};

export function nextExportFiles(store: { slug: string; name: string; url: string }): ZipEntry[] {
  const files: ZipEntry[] = [];

  for (const f of walk(join(PKG, "src"), (rel) => rel.endsWith(".test.ts"))) {
    files.push({ path: `renderer/src/${f.rel}`, data: readFileSync(f.abs) });
  }
  for (const name of ["LICENSE", "NOTICE"]) {
    const data = readFileSync(join(PKG, name));
    files.push({ path: `renderer/${name}`, data }, { path: name, data });
  }
  for (const f of walk(join(PKG, "next-app"), () => false)) {
    files.push({ path: f.rel, data: readFileSync(f.abs) });
  }

  const name = `${store.slug}-storefront`;
  files.push(
    {
      path: "package.json",
      data: `${JSON.stringify(
        {
          name,
          version: "0.1.0",
          private: true,
          license: "Apache-2.0",
          scripts: { dev: "next dev", build: "next build", start: "next start" },
          dependencies: {
            cheerio: versionOf("cheerio"),
            next: versionOf("next"),
            react: versionOf("react"),
            "react-dom": versionOf("react-dom"),
            zod: versionOf("zod"),
          },
          devDependencies: {
            "@types/node": versionOf("@types/node"),
            "@types/react": versionOf("@types/react"),
            "@types/react-dom": versionOf("@types/react-dom"),
            typescript: versionOf("typescript"),
          },
        },
        null,
        2,
      )}\n`,
    },
    {
      path: "tsconfig.json",
      data: `${JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            lib: ["dom", "dom.iterable", "esnext"],
            allowJs: true,
            skipLibCheck: true,
            strict: true,
            noEmit: true,
            esModuleInterop: true,
            module: "esnext",
            moduleResolution: "bundler",
            resolveJsonModule: true,
            isolatedModules: true,
            jsx: "react-jsx",
            incremental: true,
            plugins: [{ name: "next" }],
            paths: { "@markii/renderer/*": ["./renderer/src/*"] },
          },
          // What `next build` would otherwise rewrite this file to on first run.
          include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts", ".next/dev/types/**/*.ts"],
          exclude: ["node_modules"],
        },
        null,
        2,
      )}\n`,
    },
    {
      path: ".env.example",
      data: [
        `# ${store.name} on Markii — read live for catalogue, design and stock.`,
        `MARKII_STORE_URL=${store.url}`,
        "",
        "# Where this app is served, e.g. https://shop.example.com",
        "SITE_URL=",
        "",
        "# The store's secret key from the Markii dashboard — for members-only products, and so",
        "# form posts go through this server and stay on this site. Server-only: never expose it.",
        "MARKII_STOREFRONT_KEY=",
        "",
        "# Where the Account link goes — your own sign-in page (see lib/shopper.ts).",
        "ACCOUNT_URL=",
        "",
      ].join("\n"),
    },
    { path: ".gitignore", data: ["node_modules", ".next", ".env*.local", ".env", "next-env.d.ts", ""].join("\n") },
  );
  return files;
}
