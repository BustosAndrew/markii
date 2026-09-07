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
});
