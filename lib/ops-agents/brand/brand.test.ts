import { describe, expect, it } from "vitest";
import { z } from "zod";
import "../../actions/index";
import { allActions, getAction } from "../../actions/registry";
import type { PageNode } from "../../builder/types";
import { AGENT_KINDS } from "../../db";
import { draftToolName, draftTools } from "../draft-tools";
import { BRAND_DRAFT_ACTIONS } from "./allowlist";
import { changeActor, describeChanges, outlineTree, previousTurnStart, type ChangeRow } from "./format";

/**
 * The brand agent (D51) — what it may write, and how it is told about the
 * draft it is writing into.
 */

const turn = {
  agent: "brand" as const,
  orgId: "org_test",
  userId: "usr_me",
  sessionId: "as_aaaaaaaaaaaaaaaaaaaa",
  actor: { type: "agent" as const, id: "usr_me", orgId: "org_test", onBehalfOfUserId: "usr_me", sessionId: "as_aaaaaaaaaaaaaaaaaaaa" },
};

describe("the brand agent's write surface", () => {
  it("is a registered agent kind", () => {
    expect(AGENT_KINDS).toContain("brand");
  });

  /**
   * The owner chose direct edits over approval cards (2026-10-31). What keeps
   * that safe is that every tool is a draft-only action — so the allowlist
   * must be exactly the registry's draft set, no more.
   */
  it("is exactly the registry's draft-only actions", () => {
    const drafts = allActions()
      .filter((d) => d.agentExecution === "draft")
      .map((d) => d.id)
      .sort();
    expect([...BRAND_DRAFT_ACTIONS].sort()).toEqual(drafts);
  });

  it("never includes publishing, discarding, restoring, deleting or stopping", () => {
    for (const id of ["builder.publish", "builder.discardDraft", "builder.restoreVersion", "builder.deletePage", "builder.restorePage", "builder.stopAgent"]) {
      expect(BRAND_DRAFT_ACTIONS as readonly string[], id).not.toContain(id);
    }
  });

  it("refuses to build a tool that would execute anything but a draft edit", () => {
    expect(() => draftTools(["builder.publish"], turn, 1)).toThrow(/not a draft-only action/);
    expect(() => draftTools(["catalog.updateProduct"], turn, 1)).toThrow(/not a draft-only action/);
  });

  /**
   * Bound to one site: `siteId` is supplied from the turn, so the model cannot
   * name another storefront even if something it read tells it to.
   */
  it("binds every tool to the turn's site — siteId is not an input the model can set", () => {
    const tools = draftTools(BRAND_DRAFT_ACTIONS, turn, 7);
    for (const id of BRAND_DRAFT_ACTIONS) {
      const t = tools[draftToolName(id)];
      expect(t, id).toBeDefined();
      const schema = z.toJSONSchema(t.inputSchema as z.ZodType, { io: "input" }) as { properties?: Record<string, unknown> };
      expect(Object.keys(schema.properties ?? {}), id).not.toContain("siteId");
    }
  });

  /** Several model APIs (and MCP clients) refuse `$ref`; the node schema is unrolled for exactly this. */
  it("describes every tool as self-contained JSON Schema", () => {
    const tools = draftTools(BRAND_DRAFT_ACTIONS, turn, 7);
    for (const [name, t] of Object.entries(tools)) {
      const json = JSON.stringify(z.toJSONSchema(t.inputSchema as z.ZodType, { io: "input" }));
      expect(json, name).not.toContain("$ref");
      expect(name).toMatch(/^[a-zA-Z0-9_]{1,64}$/);
    }
  });

  it("is a human-only action to stop the agent", () => {
    const stop = getAction("builder.stopAgent")!;
    expect(stop.agentExecution).toBeUndefined();
    expect(stop.permission).toBe("cms.write");
    expect(stop.undoable ?? false).toBe(false);
  });
});

const node = (id: string, type: string, props: Record<string, unknown> = {}, children?: PageNode[]): PageNode =>
  ({ id, type, props, ...(children ? { children } : {}) }) as PageNode;

describe("the draft as the agent reads it", () => {
  const tree = node("n_root000000", "root", {}, [
    node("n_sect000001", "section", {}, [node("n_head000001", "heading", { text: "Our story", level: 1 })]),
  ]);

  it("lists every node with the id the edit tools address it by", () => {
    const out = outlineTree(tree);
    expect(out).toContain("- n_root000000 root");
    expect(out).toContain("    - n_head000001 heading");
    expect(out).toContain('"text":"Our story"');
  });

  it("marks the block the merchant has selected", () => {
    expect(outlineTree(tree, { selectedId: "n_head000001" })).toMatch(/n_head000001 heading .*← SELECTED/);
  });

  it("stops at a budget and says where the rest is, rather than filling the context", () => {
    const big = node(
      "n_root000000",
      "root",
      {},
      Array.from({ length: 200 }, (_, i) => node(`n_t${String(i).padStart(9, "0")}`, "text", { markdown: "x".repeat(100) })),
    );
    const out = outlineTree(big, { maxChars: 2_000 });
    expect(out.length).toBeLessThan(2_200);
    expect(out).toMatch(/more node\(s\) not shown — call get_page/);
  });
});

describe("what changed since the agent last spoke", () => {
  const at = new Date("2026-11-02T10:32:00Z");
  const row = (over: Partial<ChangeRow>): ChangeRow => ({
    actionId: "builder.setProps",
    actorType: "user",
    actorId: "usr_me",
    diff: [{ entity: "sitePage", entityId: "12", path: "nodes.n_head000001.props.text", before: "Hi", after: "Our story" }],
    undoOf: null,
    occurredAt: at,
    ...over,
  });

  it("names the merchant as the person in the conversation, and others by name", () => {
    const names = new Map([["usr_ada", "Ada"]]);
    expect(changeActor(row({}), "usr_me", names)).toMatch(/the merchant/);
    expect(changeActor(row({ actorId: "usr_ada" }), "usr_me", names)).toBe("another staff member (Ada)");
    expect(changeActor(row({ actorType: "token", actorId: "tok_1" }), "usr_me", names)).toMatch(/API token or MCP client/);
  });

  it("states what changed, field by field, and marks undos", () => {
    const out = describeChanges([row({}), row({ undoOf: "inv_1" })], "usr_me", new Map());
    expect(out).toContain('10:32 UTC, the merchant (the person you are talking to): setProps — page #12 nodes.n_head000001.props.text: "Hi" → "Our story"');
    expect(out).toContain("setProps (an undo)");
  });

  it("caps a long history and says how much it left out", () => {
    const out = describeChanges(Array.from({ length: 35 }, () => row({})), "usr_me", new Map(), 30);
    expect(out.split("\n")).toHaveLength(31);
    expect(out).toMatch(/and 5 more change\(s\)/);
  });

  it("finds where the last turn began from the stamp on the previous user message", () => {
    const history = [
      { role: "user", metadata: { sentAt: "2026-11-02T10:00:00.000Z" } },
      { role: "assistant" },
      { role: "user", metadata: { sentAt: "2026-11-02T10:30:00.000Z" } },
      { role: "assistant" },
    ];
    expect(previousTurnStart(history)?.toISOString()).toBe("2026-11-02T10:30:00.000Z");
    expect(previousTurnStart([])).toBeNull();
    // A transcript from before stamps existed reports nothing rather than inventing a window.
    expect(previousTurnStart([{ role: "user" }, { role: "assistant" }])).toBeNull();
  });
});
