import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachTenantHost,
  detachTenantHost,
  isPlatformConfigured,
  platformStatus,
  registerDomain,
  unregisterDomain,
} from "./platform";

/**
 * Platform registration (§2 "step two").
 *
 * The HTTP calls are stubbed — what is worth testing is the **decisions taken
 * around them**, because each one has a wrong answer that reports a broken
 * domain as working:
 *
 *   - unconfigured must refuse and say whose problem it is, never quietly pass;
 *   - Vercel's `409` is ambiguous and means two opposite things;
 *   - a `404` on lookup is "not registered", not an outage;
 *   - an unreachable platform is unknown, and unknown is not false.
 */
const env = { ...process.env };

function configure() {
  process.env.VERCEL_TOKEN = "tok_test";
  process.env.VERCEL_PROJECT_ID = "prj_test";
  delete process.env.VERCEL_TEAM_ID;
}

/** Replies in order, and records the requests so ordering can be asserted. */
function stubFetch(replies: { status: number; body?: unknown }[]) {
  const calls: { url: string; method: string }[] = [];
  let i = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    const reply = replies[Math.min(i++, replies.length - 1)];
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.body ?? {},
    } as Response;
  });
  return calls;
}

beforeEach(() => {
  delete process.env.VERCEL_TOKEN;
  delete process.env.VERCEL_PROJECT_ID;
  delete process.env.VERCEL_TEAM_ID;
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...env };
});

describe("configuration", () => {
  it("needs both a token and a project id", () => {
    expect(isPlatformConfigured()).toBe(false);
    process.env.VERCEL_TOKEN = "tok_test";
    expect(isPlatformConfigured(), "a token alone cannot address a project").toBe(false);
    process.env.VERCEL_PROJECT_ID = "prj_test";
    expect(isPlatformConfigured()).toBe(true);
  });

  it("refuses rather than pretending, and blames Markii not the merchant", async () => {
    const res = await registerDomain("shop.acme.com");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("configuration_required");
    // The merchant can do nothing about a missing platform credential, so the
    // copy must not read as a task for them.
    expect(res.message).toMatch(/Markii's to fix/);
  });

  it("reports an unconfigured platform as unknown, never as registered", async () => {
    const status = await platformStatus("shop.acme.com");
    expect(status.configured).toBe(false);
    // Null, not false. "Not registered" would send a merchant chasing DNS.
    expect(status.registered).toBeNull();
    expect(status.misconfigured).toBeNull();
  });
});

describe("registerDomain", () => {
  it("adds the domain", async () => {
    configure();
    const calls = stubFetch([{ status: 200, body: { name: "shop.acme.com" } }]);
    const res = await registerDomain("shop.acme.com");
    expect(res).toEqual({ ok: true, alreadyRegistered: false });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toContain("/v10/projects/prj_test/domains");
  });

  it("treats a 409 already on this project as success", async () => {
    /**
     * Idempotence is what makes "Check DNS" the repair path for a registration
     * that failed the first time. Without this, every re-verify of a working
     * domain would surface a conflict the merchant cannot act on.
     */
    configure();
    stubFetch([
      { status: 409, body: { error: { code: "domain_already_in_use" } } },
      { status: 200, body: { name: "shop.acme.com" } },
    ]);
    const res = await registerDomain("shop.acme.com");
    expect(res).toEqual({ ok: true, alreadyRegistered: true });
  });

  it("treats a 409 held by another project as a real conflict", async () => {
    // The same status code, the opposite meaning. Reporting this as success is
    // how a domain gets marked working while serving nothing.
    configure();
    stubFetch([
      { status: 409, body: { error: { code: "domain_already_in_use" } } },
      { status: 404, body: { error: { message: "not found" } } },
    ]);
    const res = await registerDomain("shop.acme.com");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("taken");
  });

  it("reports an unreachable platform instead of throwing", async () => {
    // A verify whose DNS proof already succeeded must not fail because Vercel
    // is down — the ownership fact is real either way.
    configure();
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const res = await registerDomain("shop.acme.com");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("provider_error");
    expect(res.message).toMatch(/network down/);
  });

  it("scopes calls to the team when one is set", async () => {
    configure();
    process.env.VERCEL_TEAM_ID = "team_abc";
    const calls = stubFetch([{ status: 200 }]);
    await registerDomain("shop.acme.com");
    expect(calls[0].url).toContain("teamId=team_abc");
  });
});

describe("platformStatus", () => {
  it("reads a 404 as not registered, with something the merchant can do", async () => {
    configure();
    stubFetch([{ status: 404, body: {} }]);
    const status = await platformStatus("shop.acme.com");
    expect(status).toMatchObject({ configured: true, registered: false });
    expect(status.problem).toMatch(/will not reach your storefront/);
  });

  it("reports registered and well-configured", async () => {
    configure();
    stubFetch([
      { status: 200, body: { name: "shop.acme.com" } },
      { status: 200, body: { misconfigured: false } },
    ]);
    const status = await platformStatus("shop.acme.com");
    expect(status).toEqual({
      configured: true,
      registered: true,
      misconfigured: false,
      problem: null,
    });
  });

  it("surfaces a misconfigured domain rather than calling it ready", async () => {
    configure();
    stubFetch([
      { status: 200, body: { name: "shop.acme.com" } },
      { status: 200, body: { misconfigured: true } },
    ]);
    const status = await platformStatus("shop.acme.com");
    expect(status.registered).toBe(true);
    expect(status.misconfigured).toBe(true);
  });

  it("keeps an unreachable platform as unknown rather than false", async () => {
    configure();
    stubFetch([{ status: 500, body: { error: { message: "boom" } } }]);
    const status = await platformStatus("shop.acme.com");
    expect(status.registered, "unknown is not the same as not registered").toBeNull();
    expect(status.problem).toBe("boom");
  });
});

describe("unregisterDomain", () => {
  it("treats an already-absent domain as removed", async () => {
    configure();
    stubFetch([{ status: 404 }]);
    expect(await unregisterDomain("shop.acme.com")).toEqual({ ok: true, message: null });
  });

  it("refuses to detach Markii's own routing, even fully configured", async () => {
    /**
     * Guards the irreversible half: a future change passing the wrong value
     * would delete Markii's apex from the project that serves every merchant,
     * with no undo.
     */
    configure();
    process.env.ROOT_DOMAIN = "markii.shop";
    const calls = stubFetch([{ status: 200 }]);

    for (const host of ["markii.shop", "www.markii.shop", "markii-orcin.vercel.app", "localhost"]) {
      const res = await unregisterDomain(host);
      expect(res.ok, `${host} must never be detached`).toBe(false);
    }
    expect(calls.length, "no request may even be issued").toBe(0);
  });

  it("still detaches a tenant subdomain, which is Markii's to hand out", async () => {
    /**
     * The distinction the guard has to get right. A merchant may not *claim*
     * `{slug}.markii.shop` as a custom domain — `isReservedHost` says no — but
     * Markii attaches and detaches those itself as storefronts are published,
     * renamed, and deleted. Covering them in the detach guard would make that
     * lifecycle refuse itself, stranding a project domain slot per rename.
     */
    configure();
    process.env.ROOT_DOMAIN = "markii.shop";
    const calls = stubFetch([{ status: 200 }]);

    const res = await unregisterDomain("aurora-supply.markii.shop");
    expect(res.ok).toBe(true);
    expect(calls[0].method).toBe("DELETE");
  });

  it("attaches and detaches a storefront's own address by slug", async () => {
    configure();
    process.env.ROOT_DOMAIN = "markii.shop";
    const calls = stubFetch([{ status: 200 }]);

    await attachTenantHost("aurora-supply");
    expect(calls[0].url).toContain("/v10/projects/prj_test/domains");

    await detachTenantHost("aurora-supply");
    expect(calls[1].url).toContain(encodeURIComponent("aurora-supply.markii.shop"));
    expect(calls[1].method).toBe("DELETE");
  });

  it("does nothing in local development, where *.localhost needs no registration", async () => {
    // ROOT_DOMAIN=localhost is what the integration suite runs with. Issuing
    // Vercel calls there would mutate a real project from a test run.
    configure();
    process.env.ROOT_DOMAIN = "localhost";
    const calls = stubFetch([{ status: 200 }]);

    expect(await attachTenantHost("aurora-supply")).toEqual({ ok: true, alreadyRegistered: true });
    expect(await detachTenantHost("aurora-supply")).toEqual({ ok: true, message: null });
    expect(calls.length, "no platform call may be made").toBe(0);
  });

  it("reports a refusal so a stuck domain is not silently left attached", async () => {
    // A hostname left bound to Markii's project blocks the merchant from
    // attaching it anywhere else — including to a competitor.
    configure();
    stubFetch([{ status: 403, body: { error: { message: "forbidden" } } }]);
    expect(await unregisterDomain("shop.acme.com")).toEqual({ ok: false, message: "forbidden" });
  });
});
