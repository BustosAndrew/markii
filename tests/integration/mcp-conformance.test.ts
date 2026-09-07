import { beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, signUpMerchant, sql } from "./helpers";
import { BASE_URL } from "./setup";

/**
 * Protocol conformance — the handshake exactly as a real MCP client performs it.
 *
 * `mcp.test.ts` proves the server does the right *things*: tools run, refusals
 * are audited, reads do not write. It sends only `content-type` and
 * `authorization`, because that is all our own code needs.
 *
 * A real client sends more, and the gap between those two is the last place this
 * server could be wrong in a way nothing here would notice — `Accept` carrying
 * `text/event-stream`, an `MCP-Protocol-Version` header on every request after
 * the handshake, `initialize` with full client capabilities, and
 * `notifications/initialized` as a notification that must draw no response.
 *
 * This is deliberately **not** an MCP client. Writing one to test our own server
 * would mostly prove both halves share a misunderstanding; the point here is to
 * pin the wire format against what the spec says a client sends, in CI, where
 * the official Inspector cannot run.
 */

/** Headers a real client attaches to every POST. */
const CLIENT_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

const PROTOCOL_VERSION = "2025-06-18";

describe("MCP protocol conformance", () => {
  const merchant = new Client();
  const cleanup = new Cleanup();
  let token: string;
  let orgId: string;
  let nextId = 1;

  /** One request, shaped the way a client shapes it. */
  async function send(
    body: unknown,
    extra: Record<string, string> = {},
  ): Promise<{ status: number; headers: Headers; text: string }> {
    const res = await fetch(`${BASE_URL}/api/mcp`, {
      method: "POST",
      headers: { ...CLIENT_HEADERS, authorization: `Bearer ${token}`, ...extra },
      body: JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, text: await res.text() };
  }

  const request = (method: string, params?: unknown, extra?: Record<string, string>) =>
    send({ jsonrpc: "2.0", id: nextId++, method, params }, extra);

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "mcpconf");
    cleanup.merchantEmails.push(email);
    orgId = (await merchant.get("/api/me")).json.org.id;

    const created = await merchant.post("/api/org/tokens", {
      label: "mcp-conformance",
      role: "catalog_manager",
    });
    expect(created.status).toBeLessThan(300);
    token = created.json.token;
  }, 180_000);

  /**
   * The full opening exchange, in order, as a client performs it. Run as one
   * test because the sequence is the thing under test — asserting the steps
   * independently would not catch an ordering assumption.
   */
  it("completes the client handshake in order", async () => {
    // 1. initialize, with the capabilities and clientInfo a real client sends.
    const init = await request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { roots: { listChanged: true }, sampling: {} },
      clientInfo: { name: "conformance-probe", version: "1.0.0" },
    });

    expect(init.status).toBe(200);
    expect(init.headers.get("content-type")).toMatch(/application\/json/);

    const initBody = JSON.parse(init.text);
    expect(initBody.jsonrpc).toBe("2.0");
    expect(initBody.error, JSON.stringify(initBody.error)).toBeUndefined();
    expect(initBody.result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(initBody.result.serverInfo.name).toBeTruthy();
    expect(initBody.result.serverInfo.version).toBeTruthy();
    expect(initBody.result.capabilities).toBeDefined();

    /**
     * A stateless server returns no session id. Pinned because it is a
     * behaviour a client branches on: if this ever starts being sent, clients
     * will begin echoing it back and expecting it to mean something.
     */
    expect(init.headers.get("mcp-session-id")).toBeNull();

    // 2. notifications/initialized — no id, so it must draw no response body.
    const ack = await send({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(ack.status).toBe(202);
    expect(ack.text).toBe("");

    // 3. Subsequent requests carry the negotiated version.
    const versioned = { "MCP-Protocol-Version": PROTOCOL_VERSION };

    const tools = await request("tools/list", {}, versioned);
    expect(tools.status).toBe(200);
    const toolBody = JSON.parse(tools.text);
    expect(toolBody.error).toBeUndefined();
    expect(Array.isArray(toolBody.result.tools)).toBe(true);
    expect(toolBody.result.tools.length).toBeGreaterThan(0);

    const prompts = await request("prompts/list", {}, versioned);
    expect(JSON.parse(prompts.text).error).toBeUndefined();

    const ping = await request("ping", {}, versioned);
    expect(JSON.parse(ping.text).result).toEqual({});
  }, 120_000);

  /**
   * The header is required of clients by the 2025-06-18 spec and this server
   * ignores it, which is the lenient reading. Pinned both ways so the leniency
   * is a decision rather than an accident: an older client that omits it must
   * keep working, and an unfamiliar version must not be rejected outright.
   */
  it("tolerates a missing or unfamiliar MCP-Protocol-Version header", async () => {
    const without = await request("tools/list", {});
    expect(without.status).toBe(200);
    expect(JSON.parse(without.text).error).toBeUndefined();

    const unfamiliar = await request("tools/list", {}, { "MCP-Protocol-Version": "2099-01-01" });
    expect(unfamiliar.status).toBe(200);
    expect(JSON.parse(unfamiliar.text).error).toBeUndefined();
  }, 90_000);

  /**
   * Clients advertise both content types because a server may answer either.
   * This one always answers JSON — legal, and worth pinning: a client that gets
   * `text/event-stream` back would wait for a stream that never ends.
   */
  it("answers JSON even though the client accepts an event stream", async () => {
    const res = await request("ping", {}, { accept: "application/json, text/event-stream" });
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(res.headers.get("content-type")).not.toMatch(/event-stream/);
  }, 60_000);

  /**
   * **Statelessness, asserted rather than assumed.** Every request stands alone,
   * so a client that reconnects — or a second instance behind a load balancer —
   * does not have to replay `initialize` first. If this ever stops being true,
   * it must be a deliberate change with session handling to match.
   */
  it("serves a request on a fresh connection with no prior initialize", async () => {
    const res = await fetch(`${BASE_URL}/api/mcp`, {
      method: "POST",
      headers: { ...CLIENT_HEADERS, authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(body.result.tools.length).toBeGreaterThan(0);
  }, 60_000);

  it("echoes the request id it was given, including id 0", async () => {
    const res = await send({ jsonrpc: "2.0", id: 0, method: "ping", params: {} });
    const body = JSON.parse(res.text);
    /**
     * `0` is falsy, which is exactly the value an `id ?? null` written slightly
     * wrong turns into `null` — and a client matching responses to requests by
     * id would then hang on this one forever.
     */
    expect(body.id).toBe(0);

    const str = await send({ jsonrpc: "2.0", id: "abc", method: "ping", params: {} });
    expect(JSON.parse(str.text).id).toBe("abc");
  }, 60_000);

  /**
   * The token here is `catalog_manager`, so the listing is narrower than an
   * administrator's — the property the setup guide's role table rests on.
   */
  it("scopes the tool list to the connected credential's role", async () => {
    const res = await request("tools/list", {});
    const names = (JSON.parse(res.text).result.tools as { name: string }[]).map((t) => t.name);

    expect(names).toContain("read_products");
    expect(names.some((n) => n.startsWith("catalog_"))).toBe(true);
    // Billing is an owner/administrator concern and must not appear here.
    expect(names.some((n) => n.startsWith("billing_"))).toBe(false);
  }, 60_000);

  it("leaves no audit rows behind from a handshake", async () => {
    const [{ n }] = await sql`select count(*)::int as n from action_invocations
      where org_id = ${orgId}`;
    // Nothing above invoked an action: a handshake and some listing only.
    expect(n).toBe(0);
  }, 60_000);

  /**
   * **Error output is sanitized, because an agent is an audience.**
   *
   * `lib/api/public-copy.ts` exists to keep internal planning refs, repo paths
   * and env var names out of anything shown to "merchants, shoppers, or
   * agents" — and `errorResponse` applies it on every HTTP reply. The MCP route
   * did neither: it passed `ApiError.message` through unsanitized and echoed a
   * raw exception's text on the internal-error path, which sends a driver error
   * naming tables and columns to a model, and from there to whatever provider
   * the client uses.
   */
  describe("error output does not leak internals", () => {
    const INTERNAL = [
      "DATABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "STRIPE_SECRET_KEY",
      "CRON_SECRET",
      /lib\/[A-Za-z0-9._/-]+\.ts/,
      /docs\/[A-Za-z0-9._/-]+/,
    ];

    const assertClean = (text: string, label: string) => {
      for (const needle of INTERNAL) {
        if (typeof needle === "string") {
          expect(text.includes(needle), `${label} leaked ${needle}`).toBe(false);
        } else {
          expect(needle.test(text), `${label} leaked ${needle}`).toBe(false);
        }
      }
    };

    it("keeps a validation refusal free of internal references", async () => {
      const res = await request("tools/call", {
        name: "catalog_updateVariant",
        arguments: { variantId: "not-a-number" },
      });
      assertClean(res.text, "validation error");
    }, 60_000);

    it("keeps a not-found refusal free of internal references", async () => {
      const res = await request("tools/call", {
        name: "catalog_updateVariant",
        arguments: { variantId: 999999999, priceMinor: 100 },
      });
      assertClean(res.text, "not-found error");
    }, 60_000);

    it("keeps a protocol error free of internal references", async () => {
      const res = await request("prompts/get", { name: "no_such_prompt" });
      assertClean(res.text, "protocol error");
    }, 60_000);

    /**
     * Every reply in the handshake suite, swept in one pass — the leak this
     * guards against is not specific to one code path.
     */
    it("keeps a full listing free of internal references", async () => {
      const tools = await request("tools/list", {});
      assertClean(tools.text, "tools/list");

      const prompts = await request("prompts/list", {});
      assertClean(prompts.text, "prompts/list");
    }, 60_000);
  });

  /**
   * Rate limiting (`lib/rate-limit.ts`).
   *
   * The arithmetic is unit-tested and needs no database. What only a real
   * request can show is that the counter is shared and atomic — the reason it
   * lives in Postgres rather than in a module-scope `Map`, which would reset on
   * every cold start and refuse almost nothing while looking like protection.
   *
   * The limit is driven off `MCP_RATE_LIMIT`, so these drive the counter
   * directly rather than sending hundreds of requests to discover the ceiling.
   */
  describe("rate limiting", () => {
    /** A key nothing else uses, so the assertions cannot be disturbed. */
    const probeKey = `mcp:conformance-probe-${Date.now()}`;

    it("publishes the remaining budget on a successful reply", async () => {
      const res = await request("ping", {});
      expect(res.status).toBe(200);

      expect(res.headers.get("ratelimit-limit")).toBeTruthy();
      const remaining = Number(res.headers.get("ratelimit-remaining"));
      expect(Number.isFinite(remaining)).toBe(true);
      expect(remaining).toBeGreaterThanOrEqual(0);

      /** Only a refusal carries Retry-After; on a 200 it would misread. */
      expect(res.headers.get("retry-after")).toBeNull();
    }, 60_000);

    it("counts each request against the token, in one shared row", async () => {
      const before = Number((await request("ping", {})).headers.get("ratelimit-remaining"));
      const after = Number((await request("ping", {})).headers.get("ratelimit-remaining"));

      /**
       * Strictly decreasing across two separate HTTP requests is the property
       * an in-memory counter could not provide on a serverless deployment.
       */
      expect(after).toBeLessThan(before);
    }, 60_000);

    /**
     * The increment is a single upsert precisely so two concurrent requests
     * cannot both read the same count and both decide they fit. Twenty at once
     * must consume exactly twenty.
     */
    it("counts concurrent requests exactly once each", async () => {
      const start = Number((await request("ping", {})).headers.get("ratelimit-remaining"));

      const burst = await Promise.all(Array.from({ length: 20 }, () => request("ping", {})));
      for (const r of burst) expect(r.status).toBe(200);

      const end = Number((await request("ping", {})).headers.get("ratelimit-remaining"));
      // 20 in the burst plus the one that read `end`.
      expect(start - end).toBe(21);
    }, 120_000);

    /**
     * **A small policy of its own, rather than spending the real one.**
     *
     * The first version of this looped `MCP_RATE_LIMIT.limit` times — 120
     * sequential round trips — and was flaky for a reason that is the feature
     * working: a run slow enough to cross a minute boundary reset the window
     * mid-loop, and the count legitimately started again. `consumeRateLimit`
     * takes the policy as an argument precisely so a test can use a ceiling it
     * can reach in three calls.
     */
    it("refuses once the window is spent, and says how long to wait", async () => {
      const { consumeRateLimit } = await import("@/lib/rate-limit-store");
      const tiny = { limit: 3, windowMs: 60_000 };

      expect((await consumeRateLimit(probeKey, tiny)).remaining).toBe(2);
      expect((await consumeRateLimit(probeKey, tiny)).remaining).toBe(1);

      const last = await consumeRateLimit(probeKey, tiny);
      expect(last.allowed).toBe(true);
      expect(last.remaining).toBe(0);

      const over = await consumeRateLimit(probeKey, tiny);
      expect(over.allowed).toBe(false);
      expect(over.retryAfterSeconds).toBeGreaterThanOrEqual(1);

      await sql`delete from rate_limit_counters where key = ${probeKey}`;
    }, 90_000);

    /**
     * A stale row is reset in place rather than deleted, which is what keeps
     * this table bounded by callers instead of by traffic — there is no
     * scheduled sweeper here to rely on.
     */
    it("reuses a row from a previous window instead of accumulating", async () => {
      const { consumeRateLimit } = await import("@/lib/rate-limit-store");
      const tiny = { limit: 3, windowMs: 60_000 };

      await consumeRateLimit(probeKey, tiny, new Date(Date.now() - 5 * 60_000));
      const fresh = await consumeRateLimit(probeKey, tiny);
      expect(fresh.remaining).toBe(tiny.limit - 1);

      const [{ n }] = await sql`select count(*)::int as n from rate_limit_counters
        where key = ${probeKey}`;
      expect(n).toBe(1);

      await sql`delete from rate_limit_counters where key = ${probeKey}`;
    }, 90_000);
  });

  /**
   * Branches of the transport that nothing else reaches.
   *
   * Batching was **removed** from MCP in the 2025-06-18 revision, but this
   * server accepts `2024-11-05` and `2025-03-26` too, where it still existed —
   * so the branch is reachable by a client on an older version and had no test
   * at all. Dead-looking code that is actually reachable is the worst of both.
   */
  describe("transport branches", () => {
    it("answers a batch with one reply per request, in order", async () => {
      const res = await send([
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      ]);

      expect(res.status).toBe(200);
      const replies = JSON.parse(res.text);
      expect(Array.isArray(replies)).toBe(true);
      expect(replies).toHaveLength(2);
      expect(replies[0].id).toBe(1);
      expect(replies[1].id).toBe(2);
      expect(replies[1].result.tools.length).toBeGreaterThan(0);
    }, 60_000);

    /** Notifications draw no reply, so a mixed batch returns only the requests. */
    it("omits notifications from a batch reply", async () => {
      const res = await send([
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 7, method: "ping" },
      ]);

      const replies = JSON.parse(res.text);
      expect(replies).toHaveLength(1);
      expect(replies[0].id).toBe(7);
    }, 60_000);

    /** A batch of nothing but notifications has no body to return at all. */
    it("answers an all-notification batch with 202 and no body", async () => {
      const res = await send([
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", method: "notifications/cancelled" },
      ]);
      expect(res.status).toBe(202);
      expect(res.text).toBe("");
    }, 60_000);

    /**
     * An unknown *notification* must be swallowed, not answered — replying to
     * something with no id is the classic JSON-RPC violation, and strict
     * clients treat an unexpected response as a protocol failure.
     */
    it("silently ignores an unknown notification", async () => {
      const res = await send({ jsonrpc: "2.0", method: "notifications/progress" });
      expect(res.status).toBe(202);
      expect(res.text).toBe("");
    }, 60_000);

    it("rejects a body that is not a JSON-RPC request", async () => {
      const res = await send({ hello: "world" });
      expect(JSON.parse(res.text).error.code).toBe(-32600);
    }, 60_000);

    it("requires a tool name on tools/call", async () => {
      const res = await request("tools/call", { arguments: {} });
      expect(JSON.parse(res.text).error).toBeDefined();
    }, 60_000);

    it("refuses DELETE, which a stateless server has no session to end", async () => {
      const res = await fetch(`${BASE_URL}/api/mcp`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }, 60_000);

    /**
     * Revocation is a soft delete so past audit entries stay attributable — but
     * it must stop the credential working immediately, which is the only reason
     * "revoke the token" is the answer to a leak.
     */
    it("stops accepting a token the moment it is revoked", async () => {
      const created = await merchant.post("/api/org/tokens", {
        label: "revoke-probe",
        role: "analyst",
      });
      const doomed: string = created.json.token;

      const before = await fetch(`${BASE_URL}/api/mcp`, {
        method: "POST",
        headers: { ...CLIENT_HEADERS, authorization: `Bearer ${doomed}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      expect(before.status).toBe(200);

      const del = await merchant.del(`/api/org/tokens/${created.json.id}`);
      expect(del.status).toBeLessThan(300);

      const after = await fetch(`${BASE_URL}/api/mcp`, {
        method: "POST",
        headers: { ...CLIENT_HEADERS, authorization: `Bearer ${doomed}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      expect(after.status).toBe(401);
    }, 90_000);
  });
});
