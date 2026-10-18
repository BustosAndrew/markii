import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Whether a dashboard href names a page that exists — for unit tests holding
 * the assistant and the setup checklist to links that go somewhere.
 *
 * Walks `app/(dashboard)` one segment at a time, accepting a literal folder
 * or a dynamic `[param]` one, and requires a `page.tsx` at the end. A link
 * the model repeats to a merchant is a claim, and a 404 is a broken one.
 */
export function dashboardPageExists(href: string): boolean {
  if (!href.startsWith("/dashboard")) return false;
  const root = join(process.cwd(), "app", "(dashboard)");
  let dirs = [root];
  for (const segment of href.split("?")[0].split("/").filter(Boolean)) {
    const nextDirs: string[] = [];
    for (const dir of dirs) {
      if (existsSync(join(dir, segment))) nextDirs.push(join(dir, segment));
      const dynamic = readdirSync(dir, { withFileTypes: true }).filter(
        (e) => e.isDirectory() && /^\[[^\]]+\]$/.test(e.name),
      );
      for (const d of dynamic) nextDirs.push(join(dir, d.name));
    }
    if (nextDirs.length === 0) return false;
    dirs = nextDirs;
  }
  return dirs.some((d) => existsSync(join(d, "page.tsx")));
}
