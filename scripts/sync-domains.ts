/**
 * Reconciles the hosting platform's domain list with what the database says
 * should be reachable (§2).
 *
 * Run: `pnpm domains:sync`         (report what is missing and what is stray)
 *      `pnpm domains:sync --apply` (attach the missing ones)
 *
 * **Why this exists.** Registration is an effect of a *transition* — a store
 * going live, a domain verifying. Storefronts that were already live when that
 * code shipped never transitioned, so nothing ever attached them and their
 * `{slug}.{ROOT_DOMAIN}` addresses fail TLS: DNS reaches Vercel, and Vercel
 * rejects a hostname not registered to the project. This is the one-off that
 * catches them up, and the reconciliation you run afterwards when something
 * looks wrong.
 *
 * **It attaches, and it never detaches.** A missing domain is a store nobody
 * can reach — safe to fix automatically. A *stray* is the opposite: removing one
 * takes a live storefront offline instantly, and the reason it is unrecognised
 * may simply be that a human added it deliberately. Strays are reported for a
 * person to judge, the same way `stripe:prices` reports a mismatched Price
 * rather than editing it.
 *
 * Idempotent. Re-running is the normal way to verify.
 */
import { eq, or } from "drizzle-orm";
import { db, sites, sql } from "../lib/db";
import { isPlatformCriticalHost, tenantHost } from "../lib/domains/records";

const API = "https://api.vercel.com";
const apply = process.argv.includes("--apply");

const token = process.env.VERCEL_TOKEN;
const projectId = process.env.VERCEL_PROJECT_ID;
const teamId = process.env.VERCEL_TEAM_ID || null;

/** Appends `teamId` with the right separator, since some paths already carry a query. */
function url(path: string): string {
  if (!teamId) return `${API}${path}`;
  const sep = path.includes("?") ? "&" : "?";
  return `${API}${path}${sep}teamId=${encodeURIComponent(teamId)}`;
}

type Body = { error?: { message?: string }; domains?: { name: string }[] } | null;

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; body: Body; problem: string | null }> {
  try {
    const res = await fetch(url(path), {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const parsed = (await res.json().catch(() => null)) as Body;
    return {
      ok: res.ok,
      status: res.status,
      body: parsed,
      problem: res.ok ? null : (parsed?.error?.message ?? `HTTP ${res.status}`),
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      body: null,
      problem: e instanceof Error ? e.message : "network error",
    };
  }
}

const PAGE_LIMIT = 100;

/**
 * Every domain currently on the project.
 *
 * A truncated list is worse than a failed one: unseen domains would be reported
 * as MISSING and, with `--apply`, re-attached — harmless in itself, since the
 * API is idempotent, but it would print a page of changes that did not happen
 * and hide the real state. So a full page is treated as "cannot trust this"
 * rather than assumed complete.
 */
async function projectDomains(): Promise<string[] | null> {
  const res = await call("GET", `/v9/projects/${projectId}/domains?limit=${PAGE_LIMIT}`);
  if (!res.ok) {
    console.error(`✖ could not read the project's domains: ${res.problem}`);
    return null;
  }

  const names = (res.body?.domains ?? []).map((d) => d.name);
  if (names.length >= PAGE_LIMIT) {
    console.error(
      `✖ the project has at least ${PAGE_LIMIT} domains, so this listing may be truncated.\n` +
        "  Refusing to report MISSING or STRAY from a partial list — that would be a\n" +
        "  confident answer built on half the data. Add pagination here before re-running.\n",
    );
    return null;
  }
  return names;
}

/**
 * Returns the exit code rather than calling `process.exit` itself, so every
 * path — success, refusal, failure — goes through the one place that closes the
 * database pool. Exiting mid-query aborts the process on Windows.
 */
async function main(): Promise<number> {
  if (!token || !projectId) {
    console.error(
      "\n✖ VERCEL_TOKEN and VERCEL_PROJECT_ID are required.\n" +
        "  Without them nothing can be attached, and a verified domain does not serve.\n",
    );
    process.exit(1);
  }

  const root = process.env.ROOT_DOMAIN;
  if (!root || root === "localhost" || root.endsWith(".localhost")) {
    console.error(
      `\n✖ ROOT_DOMAIN is ${root ? `"${root}"` : "unset"}, so there are no tenant hostnames to sync.\n` +
        "  Set it to the real apex before running this.\n",
    );
    process.exit(1);
  }

  console.log(`\nProject ${projectId}${teamId ? ` (team ${teamId})` : ""} · root ${root}\n`);

  const rows = await db
    .select()
    .from(sites)
    .where(or(eq(sites.status, "live"), eq(sites.domainStatus, "verified")));

  /**
   * What *should* be attached, and why each one.
   *
   * Live stores only. A draft is not meant to be reachable, and a paused store
   * that was never attached picks its host up when it resumes — the status
   * transition fires the same attach. Spending a project domain slot on either
   * would be paying for something nobody can visit.
   */
  const wanted = new Map<string, string>();
  for (const s of rows) {
    if (s.status === "live") {
      const host = tenantHost(s.slug);
      if (host) wanted.set(host, `storefront "${s.name}"`);
    }
    if (s.domainStatus === "verified" && s.customDomain) {
      wanted.set(s.customDomain, `custom domain on "${s.name}"`);
    }
  }

  const attached = await projectDomains();
  if (attached === null) return 1;
  const attachedSet = new Set(attached);

  const missing = [...wanted].filter(([host]) => !attachedSet.has(host));
  /**
   * On the project but not in the database. Markii's own routing is excluded —
   * the apex, its `www`, and the `*.vercel.app` deployment address are expected
   * and are never anybody's storefront.
   */
  const stray = attached.filter((h) => !wanted.has(h) && !isPlatformCriticalHost(h));

  console.log(`  ${wanted.size} hostname(s) should be attached · ${attached.length} currently are\n`);

  let failures = 0;
  if (missing.length === 0) {
    console.log("  · nothing missing\n");
  } else {
    for (const [host, why] of missing) {
      if (!apply) {
        console.log(`  MISSING  ${host.padEnd(40)} ${why}`);
        continue;
      }
      const res = await call("POST", `/v10/projects/${projectId}/domains`, { name: host });
      // 409 means it is already there — the list was simply stale.
      const ok = res.ok || res.status === 409;
      if (!ok) failures++;
      console.log(`  ${ok ? "·" : "✖"} ${host.padEnd(40)} ${ok ? "attached" : res.problem}`);
    }
    console.log("");
  }

  if (stray.length > 0) {
    console.log(
      "  Attached but not in the database. **Not removed** — detaching takes a live\n" +
        "  storefront offline at once, and one of these may have been added on purpose:\n",
    );
    for (const host of stray) console.log(`  STRAY    ${host}`);
    console.log("");
  }

  if (failures > 0) {
    console.error(`✖ ${failures} hostname(s) could not be attached. Those stores are unreachable.\n`);
    return 1;
  }

  console.log(
    apply
      ? "✔ Every live storefront and verified domain is attached.\n"
      : missing.length > 0
        ? "  Dry run. Re-run with --apply to attach the MISSING hostnames.\n"
        : "  Dry run complete. Nothing to do.\n",
  );
  return 0;
}

main()
  .then(async (code) => {
    // postgres.js holds sockets open; close them rather than relying on
    // process.exit to sever a live connection mid-flight — on Windows that
    // aborts the process with a libuv assertion instead of exiting cleanly,
    // which turns a successful run into a non-zero exit code in CI.
    await sql.end();
    process.exit(code);
  })
  .catch(async (e) => {
    console.error(e);
    await sql.end({ timeout: 5 }).catch(() => {});
    process.exit(1);
  });
