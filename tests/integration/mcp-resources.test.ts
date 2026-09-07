import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, createTestStore, signUpMerchant, sql } from "./helpers";
import { BASE_URL } from "./setup";

/**
 * MCP `resources/*` end to end (§22).
 *
 * `lib/mcp/resources.test.ts` covers the shapes and the URI grammar without a
 * database. Three properties only exist across the wire, and each is a way this
 * could be wrong while looking right:
 *
 * 1. **`markii://site/{slug}/llms.txt` is byte for byte what the storefront
 *    serves.** Both go through `renderLlmsTxt` now; before that they were two
 *    assemblies of the same options, and the resource could have quietly shown a
 *    merchant a document their store does not publish.
 * 2. **A slug from another org resolves to nothing**, and reports the same
 *    "no such resource" as a slug that never existed — so the answer cannot be
 *    used to discover whose store exists.
 * 3. **Reading a resource writes no audit row.** The same rule the read tools
 *    hold: a client that pins four resources would otherwise put four rows in
 *    the log the merchant reads during an incident.
 */
describe("MCP resources", () => {
  const merchant = new Client();
  const other = new Client();
  const cleanup = new Cleanup();

  let token: string;
  let orgId: string;
  let siteSlug: string;
  let otherSiteSlug: string;
  let nextId = 100;

  async function rpc(method: string, params?: unknown) {
    const res = await fetch(`${BASE_URL}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }

  const readUri = (uri: string) => rpc("resources/read", { uri });

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "mcpres");
    cleanup.merchantEmails.push(email);
    orgId = (await merchant.get("/api/me")).json.org.id;
    siteSlug = (await createTestStore(cleanup, "mcpres", { orgId })).site.slug;

    // A second merchant with their own store, for the cross-org check.
    const { email: otherEmail } = await signUpMerchant(other, "mcpresother");
    cleanup.merchantEmails.push(otherEmail);
    const otherOrgId = (await other.get("/api/me")).json.org.id;
    otherSiteSlug = (await createTestStore(cleanup, "mcpresalt", { orgId: otherOrgId })).site.slug;

    const created = await merchant.post("/api/org/tokens", {
      label: "mcp resources",
      role: "administrator",
    });
    expect(created.status).toBe(201);
    token = created.json.token;
  }, 180_000);

  afterAll(async () => {
    await cleanup.run();
  }, 120_000);

  it("advertises the resources capability without promising subscriptions", async () => {
    const res = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(res.status).toBe(200);

    const caps = res.json.result.capabilities;
    expect(caps.resources).toBeDefined();
    /**
     * The server is stateless and holds no connection to push down. Advertising
     * `subscribe` would tell a client it may wait for a notification that is
     * never coming.
     */
    expect(caps.resources.subscribe).toBe(false);
    expect(caps.resources.listChanged).toBe(false);
  });

  it("lists resources and templates", async () => {
    const list = await rpc("resources/list");
    const uris = list.json.result.resources.map((r: any) => r.uri);
    expect(uris).toContain("markii://store");
    expect(uris).toContain("markii://sites");
    expect(uris).toContain("markii://conventions");

    const templates = await rpc("resources/templates/list");
    const shapes = templates.json.result.resourceTemplates.map((t: any) => t.uriTemplate);
    expect(shapes).toContain("markii://site/{slug}/llms.txt");
    expect(shapes).toContain("markii://site/{slug}/agent.md");
  });

  /**
   * The resource and the tool are the same handler forwarded the same header, so
   * they must return the same bytes. If they ever diverge, one of them is
   * answering from somewhere else.
   */
  it("markii://store returns exactly what read_store returns", async () => {
    const resource = await readUri("markii://store");
    const [contents] = resource.json.result.contents;
    expect(contents.mimeType).toBe("application/json");

    const tool = await rpc("tools/call", { name: "read_store", arguments: {} });
    expect(tool.json.result.isError).toBe(false);
    expect(JSON.parse(contents.text)).toEqual(JSON.parse(tool.json.result.content[0].text));

    // And it really is this merchant's org, not a shape that happens to match.
    expect(JSON.parse(contents.text).id).toBe(orgId);
  });

  it("serves the conventions document as markdown", async () => {
    const res = await readUri("markii://conventions");
    const [contents] = res.json.result.contents;
    expect(contents.mimeType).toBe("text/markdown");
    expect(contents.text).toContain("minor units");
  });

  /**
   * **The assertion this file exists for.** The MCP resource and the public
   * storefront route must render from one place; anything else lets a merchant
   * be shown a document agents do not actually receive.
   */
  it("markii://site/{slug}/llms.txt is byte for byte what the storefront serves", async () => {
    const served = await fetch(`${BASE_URL}/_sites/${siteSlug}/llms.txt`);
    expect(served.status).toBe(200);
    const publicText = await served.text();

    const res = await readUri(`markii://site/${siteSlug}/llms.txt`);
    const [contents] = res.json.result.contents;
    expect(contents.mimeType).toBe("text/plain");
    expect(contents.text).toBe(publicText);
  });

  it("markii://site/{slug}/agent.md is byte for byte what the storefront serves", async () => {
    const served = await fetch(`${BASE_URL}/_sites/${siteSlug}/agent.md`);
    expect(served.status).toBe(200);
    const publicText = await served.text();

    const res = await readUri(`markii://site/${siteSlug}/agent.md`);
    const [contents] = res.json.result.contents;
    expect(contents.mimeType).toBe("text/markdown");
    expect(contents.text).toBe(publicText);
  });

  it("refuses another org's storefront the same way it refuses one that does not exist", async () => {
    /**
     * The token must be proved working first, or a refusal here would pass with
     * the org filter deleted — the failure mode this repo has already shipped
     * once.
     */
    const live = await readUri("markii://store");
    expect(live.json.result).toBeDefined();

    // The other org's store is real and publicly reachable, which is what makes
    // this a scoping test rather than a spelling test.
    const publiclyServed = await fetch(`${BASE_URL}/_sites/${otherSiteSlug}/llms.txt`);
    expect(publiclyServed.status).toBe(200);

    const foreign = await readUri(`markii://site/${otherSiteSlug}/llms.txt`);
    const invented = await readUri("markii://site/no-such-store-anywhere/llms.txt");

    expect(foreign.json.error.code).toBe(-32002);
    // Identical treatment: the response cannot be used to probe for existence.
    expect(foreign.json.error.code).toBe(invented.json.error.code);
    expect(foreign.json.result).toBeUndefined();
  });

  it("answers -32002 for a uri outside the grammar", async () => {
    const res = await readUri("markii://not-a-thing");
    expect(res.json.error.code).toBe(-32002);
    expect(res.json.error.data.uri).toBe("markii://not-a-thing");
  });

  it("rejects resources/read with no uri as a protocol error", async () => {
    const res = await rpc("resources/read", {});
    expect(res.json.error.code).toBe(-32602);
  });

  /**
   * A storefront with agent discovery off serves a 404 to agents. Rendering the
   * document anyway would show the merchant a page their store does not publish
   * — so the refusal names the cause instead.
   */
  it("refuses a storefront that publishes no agent documents, and says why", async () => {
    await sql`update sites set agent_discovery = false where slug = ${siteSlug}`;
    try {
      const res = await readUri(`markii://site/${siteSlug}/llms.txt`);
      expect(res.json.result).toBeUndefined();
      expect(res.json.error.message).toMatch(/agent discovery/i);

      // The public route agrees — that is the state being reported.
      const served = await fetch(`${BASE_URL}/_sites/${siteSlug}/llms.txt`);
      expect(served.status).toBe(404);
    } finally {
      await sql`update sites set agent_discovery = true where slug = ${siteSlug}`;
    }
  });

  /**
   * Same rule as the read tools: pinning context must not fill the audit log a
   * merchant reads during an incident.
   */
  it("writes no audit row", async () => {
    const before = await sql`select count(*)::int as n from action_invocations where org_id = ${orgId}`;

    await rpc("resources/list");
    await readUri("markii://store");
    await readUri("markii://conventions");
    await readUri(`markii://site/${siteSlug}/agent.md`);

    const after = await sql`select count(*)::int as n from action_invocations where org_id = ${orgId}`;
    expect(after[0].n).toBe(before[0].n);
  });
});
