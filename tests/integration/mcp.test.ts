import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, createTestStore, signUpMerchant, sql } from "./helpers";
import { BASE_URL } from "./setup";

/**
 * The MCP server end to end (§22, `docs/BUILDER.md` §10).
 *
 * The registry→tool translation is unit-tested in `lib/mcp/tools.test.ts` and
 * needs no database. What only a real request can show is the span: that a
 * scoped token authenticates and a **session cookie does not** (rule 6), that a
 * tool call runs the real action through the real pipeline and lands in the
 * audit log, and — the one that matters most — that a high-risk action is
 * refused to an agent holding every permission.
 */
describe("MCP server", () => {
  const merchant = new Client();
  const cleanup = new Cleanup();

  let orgId: string;
  let token: string;
  let variantId: number;

  /** A JSON-RPC call carrying the scoped token, as an MCP client would send it. */
  async function rpc(method: string, params?: unknown, id: number | null = 1) {
    const res = await fetch(`${BASE_URL}/api/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params }),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }

  const callTool = (name: string, args: unknown) =>
    rpc("tools/call", { name, arguments: args });

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "mcp");
    cleanup.merchantEmails.push(email);
    orgId = (await merchant.get("/api/me")).json.org.id;

    const store = await createTestStore(cleanup, "mcp", { orgId });
    const [variant] = await sql`insert into variants
      (product_id, title, option_values, price_minor, position)
      values (${store.products[0].id}, 'Default', ${sql.json({})}, 1500, 0)
      returning *`;
    variantId = variant.id;

    /**
     * `administrator`, deliberately the strongest mintable role. The high-risk
     * refusal below must be about the *actor being a token*, not about a missing
     * permission — with a weaker role the test would pass for the wrong reason.
     */
    const created = await merchant.post("/api/org/tokens", {
      label: "mcp-test",
      role: "administrator",
    });
    expect(created.status).toBeLessThan(300);
    token = created.json.token;
    expect(token).toBeTruthy();
  }, 180_000);

  afterAll(async () => {
    await sql`delete from action_invocations where org_id = ${orgId}`;
    await cleanup.run();
  });

  describe("authentication (rule 6)", () => {
    it("refuses an unauthenticated call and says how to authenticate", async () => {
      const res = await fetch(`${BASE_URL}/api/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
    }, 60_000);

    /**
     * **The rule-6 assertion.** A dashboard session must not authenticate an MCP
     * client: cookies are ambient, and anything running in the merchant's
     * browser would otherwise inherit their full authority with no scoped token
     * to revoke. The merchant session is proven live first — otherwise this
     * would pass against any 401, including a broken one.
     */
    it("refuses a signed-in session cookie, accepting only a scoped token", async () => {
      const live = await merchant.get("/api/me");
      expect(live.status).toBe(200);

      const viaCookie = await merchant.post("/api/mcp", {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
      });
      expect(viaCookie.status).toBe(401);
    }, 60_000);

    it("accepts the scoped token", async () => {
      const { status, json } = await rpc("initialize", { protocolVersion: "2025-06-18" });
      expect(status).toBe(200);
      expect(json.result.serverInfo.name).toBe("markii");
    }, 60_000);
  });

  describe("protocol", () => {
    it("echoes a protocol version it supports", async () => {
      const { json } = await rpc("initialize", { protocolVersion: "2024-11-05" });
      expect(json.result.protocolVersion).toBe("2024-11-05");
    }, 60_000);

    it("advertises tool capability", async () => {
      const { json } = await rpc("initialize", {});
      expect(json.result.capabilities.tools).toBeDefined();
    }, 60_000);

    /** A notification has no id and must be answered with no body at all. */
    it("answers a notification with 202 and nothing else", async () => {
      const { status, json } = await rpc("notifications/initialized", {}, null);
      expect(status).toBe(202);
      expect(json).toBeNull();
    }, 60_000);

    it("answers ping", async () => {
      const { json } = await rpc("ping");
      expect(json.result).toEqual({});
    }, 60_000);

    it("reports an unknown method as a JSON-RPC error", async () => {
      const { json } = await rpc("resources/list");
      expect(json.error.code).toBe(-32601);
    }, 60_000);

    it("reports malformed JSON as a parse error", async () => {
      const res = await fetch(`${BASE_URL}/api/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: "{not json",
      });
      expect((await res.json()).error.code).toBe(-32700);
    }, 60_000);
  });

  describe("tools/list", () => {
    it("lists the registry as tools with dot-free names and JSON Schema", async () => {
      const { json } = await rpc("tools/list");
      const tools = json.result.tools as { name: string; inputSchema: { type: string } }[];

      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) {
        expect(tool.name).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(tool.inputSchema.type).toBe("object");
      }
      expect(tools.map((t) => t.name)).toContain("catalog_updateVariant");
    }, 60_000);

    it("advertises the dry-run flag on every tool", async () => {
      const { json } = await rpc("tools/list");
      for (const tool of json.result.tools) {
        expect(tool.inputSchema.properties._dryRun).toBeDefined();
      }
    }, 60_000);
  });

  describe("tools/call", () => {
    it("runs a real action and records it in the audit log", async () => {
      const { json } = await callTool("catalog_updateVariant", {
        variantId,
        priceMinor: 4200,
      });

      expect(json.result.isError).toBe(false);
      const outcome = json.result.structuredContent;
      expect(outcome.ok).toBe(true);

      const [row] = await sql`select price_minor from variants where id = ${variantId}`;
      expect(Number(row.price_minor)).toBe(4200);

      /** Rule 5: an MCP call is audited exactly like a click, as a token actor. */
      const [audit] = await sql`select actor_type, action_id from action_invocations
        where id = ${outcome.invocationId}`;
      expect(audit.actor_type).toBe("token");
      expect(audit.action_id).toBe("catalog.updateVariant");
    }, 90_000);

    it("writes nothing on a dry run but still returns the diff", async () => {
      const [before] = await sql`select price_minor from variants where id = ${variantId}`;

      const { json } = await callTool("catalog_updateVariant", {
        variantId,
        priceMinor: 9999,
        _dryRun: true,
      });
      expect(json.result.isError).toBe(false);
      expect(json.result.structuredContent.dryRun).toBe(true);
      expect(json.result.structuredContent.diff.length).toBeGreaterThan(0);

      const [after] = await sql`select price_minor from variants where id = ${variantId}`;
      expect(Number(after.price_minor)).toBe(Number(before.price_minor));
    }, 90_000);

    /**
     * **The gate, end to end.** The token holds `administrator`, so every
     * permission resolves — the refusal can only be the tier check. This is the
     * assertion that makes exposing MCP defensible at all.
     */
    it("refuses a high-risk action to a token holding every permission", async () => {
      const { json } = await callTool("customers_delete", { customerId: 1 });

      expect(json.result.isError).toBe(true);
      const text = json.result.content[0].text as string;
      expect(text).toContain("HUMAN_APPROVAL_REQUIRED");
      expect(text).toContain("_dryRun");
    }, 90_000);

    /** Rule 2: it may still *propose* the high-risk change. */
    it("allows the same high-risk action as a dry run", async () => {
      const { json } = await callTool("customers_delete", { customerId: 1, _dryRun: true });
      const text = json.result.content[0].text as string;
      expect(text).not.toContain("HUMAN_APPROVAL_REQUIRED");
    }, 90_000);

    /**
     * A refusal is a tool result, not a protocol error — the model has to be
     * able to read the reason and choose differently.
     */
    it("reports a validation failure as a tool error, not a JSON-RPC error", async () => {
      const { json } = await callTool("catalog_updateVariant", { variantId: "not-a-number" });
      expect(json.error).toBeUndefined();
      expect(json.result.isError).toBe(true);
    }, 90_000);

    it("reports an unknown tool as a tool error naming tools/list", async () => {
      const { json } = await callTool("catalog_doesNotExist", {});
      expect(json.error).toBeUndefined();
      expect(json.result.isError).toBe(true);
      expect(json.result.content[0].text).toContain("tools/list");
    }, 60_000);
  });
});
