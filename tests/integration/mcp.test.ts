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
      /**
       * This used to probe `resources/list`, which was genuinely unimplemented.
       * It is implemented now (`tests/integration/mcp-resources.test.ts`), and
       * the test failing on the day that landed is the test working — a
       * method-not-found assertion has to name something this server really
       * does not have, or it silently stops testing anything the moment the
       * method ships. `resources/subscribe` is the honest choice: the server
       * advertises `subscribe: false`, being stateless with no connection to
       * push down.
       */
      const { json } = await rpc("resources/subscribe", { uri: "markii://store" });
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

    /**
     * Only the action-backed tools take a dry run. A read has nothing to
     * propose, and advertising the flag there would invite an agent to "safely
     * preview" a call that was never going to write anything.
     */
    it("advertises the dry-run flag on the write tools and not the reads", async () => {
      const { json } = await rpc("tools/list");
      for (const tool of json.result.tools) {
        const hasFlag = tool.inputSchema.properties._dryRun !== undefined;
        expect(hasFlag, tool.name).toBe(!tool.name.startsWith("read_"));
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

  /**
   * Read tools (`lib/mcp/reads.ts`). These forward to the real GET handlers, so
   * what is being proven is that the token is re-presented and the handler
   * authorizes it — not that a serializer works, which its own route already
   * covers.
   */
  describe("read tools", () => {
    it("are listed, marked read-only, and come before the write tools", async () => {
      const { json } = await rpc("tools/list");
      const tools = json.result.tools as {
        name: string;
        annotations: { readOnlyHint: boolean };
      }[];

      const names = tools.map((t) => t.name);
      expect(names).toContain("read_store");
      expect(names).toContain("read_products");

      // Reads lead the list, so an agent scanning from the top sees them first.
      expect(tools[0].name.startsWith("read_")).toBe(true);

      for (const tool of tools) {
        expect(tool.annotations.readOnlyHint).toBe(tool.name.startsWith("read_"));
      }
    }, 60_000);

    it("reads the store through the real /api/org handler", async () => {
      const { json } = await callTool("read_store", {});
      expect(json.result.isError).toBe(false);
      const org = json.result.structuredContent;
      expect(org.id).toBe(orgId);
      // What an agent needs before touching money: currency and plan limits.
      expect(org.currency).toBeTruthy();
      expect(org.entitlements).toBeDefined();
    }, 60_000);

    it("lists products and forwards query arguments", async () => {
      const { json } = await callTool("read_products", { limit: 1 });
      expect(json.result.isError).toBe(false);
      expect(json.result.structuredContent.items).toHaveLength(1);
    }, 60_000);

    it("reads one product, including the variant ids the write tools take", async () => {
      const list = await callTool("read_products", { limit: 1 });
      const id = list.json.result.structuredContent.items[0].id;

      const { json } = await callTool("read_product", { idOrSlug: String(id) });
      expect(json.result.isError).toBe(false);
      expect(json.result.structuredContent.id).toBe(id);
    }, 60_000);

    it("reads orders and readiness without error", async () => {
      for (const name of ["read_orders", "read_readiness", "read_sites", "read_customers"]) {
        const { json } = await callTool(name, {});
        expect(json.result.isError, `${name} failed: ${JSON.stringify(json.result)}`).toBe(false);
      }
    }, 90_000);

    /**
     * A read must never write. Asserted against the audit table directly,
     * because the whole reason these are not registry actions is that a
     * browsing agent would otherwise bury the log.
     */
    it("writes no audit row", async () => {
      const [{ n: before }] = await sql`select count(*)::int as n from action_invocations
        where org_id = ${orgId}`;

      await callTool("read_products", {});
      await callTool("read_store", {});
      await callTool("read_orders", {});

      const [{ n: after }] = await sql`select count(*)::int as n from action_invocations
        where org_id = ${orgId}`;
      expect(after).toBe(before);
    }, 90_000);

    /** The handler's own refusal shape is passed through, not re-worded. */
    it("passes a handler refusal through as a tool error", async () => {
      const { json } = await callTool("read_product", { idOrSlug: "no-such-product-xyz" });
      expect(json.error).toBeUndefined();
      expect(json.result.isError).toBe(true);
    }, 60_000);
  });

  /**
   * Refusals must reach the audit log, not just the caller.
   *
   * Every one of these used to write nothing: the pre-flight checks and the zod
   * parse all threw above the block that recorded failures, so the log held
   * failures raised inside an action's `run` and no others. "An agent kept
   * trying to delete customers" was invisible, which is the opposite of what
   * `?ok=false` is for.
   */
  describe("refusals are audited", () => {
    const auditRow = (id: string) =>
      sql`select ok, error_code, action_id, actor_type, input from action_invocations
          where org_id = ${orgId} and action_id = ${id} and ok = false
          order by occurred_at desc limit 1`;

    it("records a high-risk refusal against the token that attempted it", async () => {
      await sql`delete from action_invocations
        where org_id = ${orgId} and action_id = 'customers.delete'`;

      const { json } = await callTool("customers_delete", { customerId: 1 });
      expect(json.result.isError).toBe(true);

      const [row] = await auditRow("customers.delete");
      expect(row, "the refusal wrote no audit row").toBeDefined();
      expect(row.ok).toBe(false);
      expect(row.error_code).toBe("HUMAN_APPROVAL_REQUIRED");
      expect(row.actor_type).toBe("token");
    }, 90_000);

    it("records a validation failure without storing the rejected payload", async () => {
      await sql`delete from action_invocations
        where org_id = ${orgId} and action_id = 'catalog.updateVariant' and ok = false`;

      await callTool("catalog_updateVariant", { variantId: "not-a-number" });

      const [row] = await auditRow("catalog.updateVariant");
      expect(row).toBeDefined();
      expect(row.error_code).toBeTruthy();
      /**
       * The payload is deliberately absent: `redactInput` works on the parsed
       * shape, so raw input could not be stripped of a secret before writing.
       */
      expect(row.input).toEqual({ unrecorded: "input rejected before validation" });
    }, 90_000);

    /** "Nothing happened" stays true for a dry run, refusal included. */
    it("records nothing for a refused dry run", async () => {
      const [{ n: before }] = await sql`select count(*)::int as n from action_invocations
        where org_id = ${orgId}`;

      await callTool("customers_delete", { customerId: 1, _dryRun: true });

      const [{ n: after }] = await sql`select count(*)::int as n from action_invocations
        where org_id = ${orgId}`;
      expect(after).toBe(before);
    }, 90_000);

    /** And the refusals are reachable through the surface built to read them. */
    it("surfaces them in the org audit log's incident view", async () => {
      await callTool("customers_delete", { customerId: 1 });

      const res = await merchant.get("/api/org/audit?ok=false");
      expect(res.status).toBe(200);
      const refusal = res.json.items.find(
        (i: any) => i.action === "customers.delete" && i.actor.type === "token",
      );
      expect(refusal).toBeDefined();
      expect(refusal.error.code).toBe("HUMAN_APPROVAL_REQUIRED");
    }, 90_000);
  });

  /**
   * **A declared filter must actually filter.**
   *
   * Every read tool names the query parameters it forwards, and those names have
   * to be the route's own. They were not: `read_products` and `read_customers`
   * declared `search` while the routes read `q`, and `read_orders` declared a
   * `search` the route has no concept of. All three were accepted, forwarded and
   * ignored — so an agent narrowing to one product received the entire catalogue
   * and had no way to know the filter had done nothing.
   *
   * Structural checks cannot catch that; only calling the tool and watching the
   * result narrow can.
   */
  describe("declared filters really filter", () => {
    it("narrows products by q", async () => {
      const all = await callTool("read_products", {});
      /**
       * `name`, not `title`. The first version of this test read `.title`, got
       * `undefined`, sent no `q` at all, and then asserted the unfiltered list
       * was smaller than itself — a test that would have passed just as happily
       * against a filter that did nothing.
       */
      const items = all.json.result.structuredContent.items as { name: string }[];
      expect(items.length).toBeGreaterThan(1);

      const target = items[0].name;
      expect(target, "fixture product has no name").toBeTruthy();

      const filtered = await callTool("read_products", { q: target });
      const got = filtered.json.result.structuredContent.items as { name: string }[];

      expect(filtered.json.result.isError).toBe(false);
      expect(got.length).toBeGreaterThan(0);
      expect(got.length).toBeLessThan(items.length);
      expect(got.every((p) => p.name.includes(target))).toBe(true);
    }, 90_000);

    it("narrows products to nothing for a term that matches nothing", async () => {
      const { json } = await callTool("read_products", { q: "zzz-no-such-product-zzz" });
      expect(json.result.isError).toBe(false);
      expect(json.result.structuredContent.items).toEqual([]);
    }, 60_000);

    it("honours the paging arguments", async () => {
      const { json } = await callTool("read_products", { limit: 1, page: 1 });
      expect(json.result.structuredContent.items).toHaveLength(1);
      expect(json.result.structuredContent.total).toBeGreaterThan(1);
    }, 60_000);

    /**
     * The order enums are validated by the route, which answers 400 on a value
     * outside them — so an agent reading the advertised `enum` is the only thing
     * standing between it and a refused call.
     */
    it("accepts every advertised order status and refuses one outside the enum", async () => {
      for (const status of ["pending", "success", "cancel", "failed"]) {
        const { json } = await callTool("read_orders", { status });
        expect(json.result.isError, `status=${status}`).toBe(false);
      }

      const bad = await callTool("read_orders", { status: "completed" });
      expect(bad.json.result.isError).toBe(true);
    }, 90_000);

    it("forwards the customer search parameter the route actually reads", async () => {
      const { json } = await callTool("read_customers", { q: "zzz-no-such-customer-zzz" });
      expect(json.result.isError).toBe(false);
      expect(json.result.structuredContent.items).toEqual([]);
    }, 60_000);
  });

  /**
   * Prompts. A client surfaces these as commands the *merchant* picks, so the
   * text lands as the opening instruction of a turn with a live store
   * credential attached — which makes what they say part of the behaviour.
   */
  describe("prompts", () => {
    it("advertises the prompts capability", async () => {
      const { json } = await rpc("initialize", {});
      expect(json.result.capabilities.prompts).toBeDefined();
    }, 60_000);

    it("lists them with titles and argument descriptions", async () => {
      const { json } = await rpc("prompts/list");
      const prompts = json.result.prompts as {
        name: string;
        title: string;
        arguments: { name: string; required: boolean }[];
      }[];

      expect(prompts.length).toBeGreaterThan(0);
      expect(prompts.map((p) => p.name)).toContain("store_health");
      for (const p of prompts) {
        expect(p.title.length, p.name).toBeGreaterThan(0);
        expect(Array.isArray(p.arguments), p.name).toBe(true);
      }
    }, 60_000);

    it("renders one as a user message carrying the ground rules", async () => {
      const { json } = await rpc("prompts/get", { name: "store_health", arguments: {} });
      const message = json.result.messages[0];

      expect(message.role).toBe("user");
      expect(message.content.type).toBe("text");
      expect(message.content.text).toMatch(/minor units/i);
      expect(message.content.text).toMatch(/_dryRun/);
    }, 60_000);

    it("substitutes the arguments it was given", async () => {
      const { json } = await rpc("prompts/get", {
        name: "propose_change",
        arguments: { request: "discount every hoodie by 15%" },
      });
      expect(json.result.messages[0].content.text).toContain("discount every hoodie by 15%");
    }, 60_000);

    it("renders with no arguments rather than failing", async () => {
      const { json } = await rpc("prompts/get", { name: "propose_change" });
      expect(json.error).toBeUndefined();
      expect(json.result.messages[0].content.text.length).toBeGreaterThan(50);
    }, 60_000);

    /**
     * Unlike an unknown *tool*, this is a JSON-RPC error: the client picked the
     * name off a list it was handed, so there is no model in the loop to recover
     * by choosing differently.
     */
    it("refuses an unknown prompt as a protocol error", async () => {
      const { json } = await rpc("prompts/get", { name: "no_such_prompt" });
      expect(json.error).toBeDefined();
      expect(json.result).toBeUndefined();
    }, 60_000);

    it("requires a prompt name", async () => {
      const { json } = await rpc("prompts/get", {});
      expect(json.error).toBeDefined();
    }, 60_000);
  });
});
