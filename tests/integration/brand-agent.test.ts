import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cleanup, Client, createTestStore, signUpMerchant, sql } from "./helpers";

/**
 * The brand agent end to end (D51, M3) — it edits the draft for real, holds
 * the editor while it works, and is told about every edit made by hand.
 *
 * Driven by the scripted mock model, so the tools, the registry, the lease and
 * the live context are all real. `{{instructions}}` in a script's text makes
 * the mock reply with the system prompt, which is how this file reads what
 * the agent was *told* — the context never otherwise leaves the server.
 *
 * ```bash
 * MARKII_AGENT_MOCK_MODEL=1 DEMO_SKIP_PAYMENT_VERIFICATION=1 ROOT_DOMAIN=localhost pnpm dev
 * pnpm exec cross-env MARKII_ALLOW_INTEGRATION_TESTS=1 vitest run --project integration brand-agent
 * ```
 */

const mock = (script: { toolCalls?: { toolName: string; input: unknown }[]; text?: string }) =>
  `MOCK:${JSON.stringify(script)}`;

const userMessage = (text: string) => ({
  id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  role: "user",
  parts: [{ type: "text", text }],
});

/** The text deltas of a UI message stream, joined — what the merchant would read. */
function streamedText(body: string): string {
  return body
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => {
      try {
        const e = JSON.parse(l.slice(6));
        return e.type === "text-delta" ? e.delta : "";
      } catch {
        return "";
      }
    })
    .join("");
}

describe("brand agent", () => {
  const merchant = new Client();
  const shopper = new Client();
  const cleanup = new Cleanup();

  let orgId: string;
  let userId: string;
  let siteId: number;
  let slug: string;
  let homeId: number;
  let headingId: string;
  let sessionId: string;

  const act = (id: string, input: unknown) => merchant.post(`/api/actions/${id}`, input);
  const homeTree = async () => (await merchant.get(`/api/builder/sites/${siteId}/pages/${homeId}`)).json.tree;
  const turn = (text: string, opts: { session?: string; context?: Record<string, unknown> } = {}) =>
    merchant.postRaw("/api/agents/brand/chat", {
      ...(opts.session ? { sessionId: opts.session } : {}),
      context: { siteId, pageId: homeId, ...(opts.context ?? {}) },
      message: userMessage(text),
    });
  const lease = async () => (await sql`select agent_lock_session_id from site_designs where site_id = ${siteId}`)[0].agent_lock_session_id;
  /** The lease goes back as the stream closes; give the release a moment to land. */
  async function leaseReleased() {
    for (let i = 0; i < 20 && (await lease()) !== null; i++) await new Promise((r) => setTimeout(r, 150));
    return (await lease()) === null;
  }

  beforeAll(async () => {
    const { email } = await signUpMerchant(merchant, "brand");
    cleanup.merchantEmails.push(email);
    const me = (await merchant.get("/api/me")).json;
    orgId = me.org.id;
    userId = me.user.id;
    const store = await createTestStore(cleanup, "brand", { orgId });
    siteId = store.site.id;
    slug = store.slug;

    const directory = await merchant.get("/api/agents");
    if (!directory.json.configured) {
      throw new Error("Start the dev server with MARKII_AGENT_MOCK_MODEL=1 — this suite must not spend real tokens.");
    }

    expect((await act("builder.startDesign", { siteId })).status).toBe(200);
    const summary = (await merchant.get(`/api/builder/sites/${siteId}`)).json;
    homeId = summary.pages[0].id;
    headingId = (await homeTree()).children[0].children[0].id;
  }, 180_000);

  afterAll(async () => cleanup.run(), 120_000);

  it("is listed as an agent that lives in the site editor", async () => {
    const res = await merchant.get("/api/agents");
    const brand = res.json.agents.find((a: any) => a.id === "brand");
    expect(brand).toMatchObject({ surface: "editor", beta: true });
  });

  it("refuses a turn that names no site, and a site outside the org", async () => {
    const none = await merchant.postRaw("/api/agents/brand/chat", { message: userMessage("hi") });
    expect(none.status).toBe(400);
    const foreign = await merchant.postRaw("/api/agents/brand/chat", { context: { siteId: 999_999_999 }, message: userMessage("hi") });
    expect(foreign.status).toBe(404);
  });

  it("edits the draft for real — as the merchant's agent — and the storefront does not change", async () => {
    const res = await turn(
      mock({
        toolCalls: [{ toolName: "builder_setProps", input: { pageId: homeId, nodeId: headingId, props: { text: "Agent headline" } } }],
        text: "I changed the headline in your draft.",
      }),
    );
    expect(res.status, res.text.slice(0, 300)).toBe(200);
    sessionId = res.headers.get("x-agent-session-id")!;
    expect(sessionId).toMatch(/^as_/);
    expect(res.text).toContain('"status":"applied"');

    expect((await homeTree()).children[0].children[0].props.text).toBe("Agent headline");

    const [audit] = await sql`select actor_type, actor_id, ok from action_invocations
                              where org_id = ${orgId} and action_id = 'builder.setProps' order by occurred_at desc limit 1`;
    // An agent, named through the person it acted for — never an unattributable id.
    expect(audit).toMatchObject({ actor_type: "agent", actor_id: userId, ok: true });

    const live = await shopper.getRaw(`/_sites/${slug}`);
    expect(live.text).not.toContain("Agent headline");

    expect(await leaseReleased(), "the turn kept the editor locked after it ended").toBe(true);

    const [session] = await sql`select site_id from agent_sessions where id = ${sessionId}`;
    expect(session.site_id).toBe(siteId);
    const listed = await merchant.get(`/api/agents/sessions?agent=brand&siteId=${siteId}`);
    expect(listed.json.items.map((s: any) => s.id)).toContain(sessionId);
  });

  it("lets the merchant undo the agent's edit like their own", async () => {
    const [row] = await sql`select id from action_invocations where org_id = ${orgId} and action_id = 'builder.setProps'
                            and actor_type = 'agent' order by occurred_at desc limit 1`;
    const undone = await act("builder.setProps/undo", { invocationId: row.id });
    expect(undone.status, JSON.stringify(undone.json)).toBe(200);
    expect((await homeTree()).children[0].children[0].props.text).not.toBe("Agent headline");
  });

  /** The feature the owner asked for in so many words: the agent sees every edit made by hand. */
  it("tells the agent about edits the merchant made since it last spoke, and what is selected", async () => {
    const edited = await act("builder.setProps", { siteId, pageId: homeId, nodeId: headingId, props: { text: "Merchant headline" } });
    expect(edited.status).toBe(200);

    const res = await turn(mock({ text: "{{instructions}}" }), { session: sessionId, context: { selectedNodeId: headingId, breakpoint: "sm" } });
    expect(res.status, res.text.slice(0, 300)).toBe(200);
    const told = streamedText(res.text);

    // The draft as it is now, read from the database — not from the transcript.
    expect(told).toContain("## The draft right now");
    expect(told).toContain('"text":"Merchant headline"');
    expect(told).toMatch(new RegExp(`${headingId} heading .*← SELECTED`));
    expect(told).toContain(`Selected block: ${headingId} (heading)`);
    expect(told).toContain("Previewing at: sm breakpoint");

    // And the change itself, attributed — the merchant's edit and their undo, not the agent's own edit.
    const changes = told.slice(told.indexOf("## Changed since your last reply"));
    expect(changes).toContain("the merchant (the person you are talking to): setProps");
    expect(changes).toContain('"Merchant headline"');
    expect(changes).toContain("(an undo)");
    expect(changes.match(/setProps/g)?.length).toBe(2);
    expect(await leaseReleased()).toBe(true);
  });

  it("holds the editor while a turn runs: a person's edit is refused, and Stop hands it back", async () => {
    // A turn mid-flight, as acquireAgentLease leaves it.
    await sql`update site_designs set agent_lock_session_id = ${sessionId}, agent_lock_expires_at = ${new Date(Date.now() + 60_000)}
              where site_id = ${siteId}`;
    const session = await merchant.get("/api/me");
    expect(session.status, "the session must be live for a refusal to mean anything").toBe(200);

    const refused = await act("builder.setProps", { siteId, pageId: homeId, nodeId: headingId, props: { text: "Mine" } });
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe("AGENT_EDITING");

    // A second turn cannot start against the same draft either.
    const second = await turn(mock({ text: "hi" }), { session: sessionId });
    expect(second.status).toBe(409);
    expect(JSON.parse(second.text).error.details.reason).toBe("turn_in_progress");

    const stopped = await act("builder.stopAgent", { siteId });
    expect(stopped.status, JSON.stringify(stopped.json)).toBe(200);
    expect(stopped.json.result).toEqual({ stopped: true, sessionId });
    expect(await lease()).toBeNull();

    const mine = await act("builder.setProps", { siteId, pageId: homeId, nodeId: headingId, props: { text: "Mine" } });
    expect(mine.status).toBe(200);

    const again = await act("builder.stopAgent", { siteId });
    expect(again.json.result).toEqual({ stopped: false, sessionId: null });
  });

  it("tells the next turn it was stopped, and which of its edits landed first", async () => {
    const res = await turn(mock({ text: "{{instructions}}" }), { session: sessionId });
    expect(res.status, res.text.slice(0, 300)).toBe(200);
    const told = streamedText(res.text);
    expect(told).toContain("## Your last turn was stopped");
    // The previous turn (the echo above) made no edits before the stop.
    expect(told).toContain("after 0 of your edit(s) had been applied");
    expect(told).toContain('"Mine"');
    expect(await leaseReleased()).toBe(true);
  });

  it("refuses a turn while another conversation holds the editor", async () => {
    await sql`update site_designs set agent_lock_session_id = 'as_otherturn0000000000', agent_lock_expires_at = ${new Date(Date.now() + 60_000)}
              where site_id = ${siteId}`;
    const res = await turn(mock({ text: "hi" }), { session: sessionId });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.text).error.details.reason).toBe("agent_holds_lease");
    await sql`update site_designs set agent_lock_session_id = null, agent_lock_expires_at = null where site_id = ${siteId}`;
  });

  it("cannot publish: the tool does not exist, and the registry refuses an agent anyway", async () => {
    const res = await turn(
      mock({ toolCalls: [{ toolName: "builder_publish", input: { note: "ship it" } }], text: "Done." }),
      { session: sessionId },
    );
    expect(res.status).toBe(200);
    const published = await sql`select id from action_invocations where org_id = ${orgId} and action_id = 'builder.publish' and ok`;
    expect(published).toHaveLength(0);
    expect(await leaseReleased()).toBe(true);
  });
});
