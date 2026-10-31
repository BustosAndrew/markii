import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../api";
import "./index";
import { invokeAction } from "./invoke";
import { allActions, defineAction, describeAction, getAction, setAuthorizationResolver } from "./registry";
import type { Actor, RecordedInvocation } from "./types";
import { z } from "zod";
import { assertMayWrite } from "../builder/store";
import type { SiteDesign } from "../db";

/**
 * The builder's actions and D51's one exception to "agents never execute".
 *
 * The exception is the part that most needs pinning: it is what lets the
 * brand agent write, so it must stay exactly the set of draft edits — nothing
 * that publishes, restores, discards or deletes — and widening it must be a
 * deliberate, reviewed change to this test.
 */

afterEach(() => setAuthorizationResolver(async () => false));

const agent: Actor = { type: "agent", id: "agent:brand", orgId: "org_1", onBehalfOfUserId: "usr_1", sessionId: "as_aaaaaaaaaaaaaaaaaaaa" };
const user: Actor = { type: "user", id: "usr_1", orgId: "org_1" };

describe("which builder actions an agent may run itself (D51)", () => {
  it("is exactly the draft edits", () => {
    const executable = allActions()
      .filter((d) => d.agentExecution === "draft")
      .map((d) => d.id)
      .sort();
    expect(executable).toEqual([
      "builder.addBlock",
      "builder.createPage",
      "builder.duplicateNode",
      "builder.insertNodes",
      "builder.insertPreset",
      "builder.moveNode",
      "builder.removeNodes",
      "builder.setProps",
      "builder.setStyles",
      "builder.setTheme",
      "builder.setThemeTokens",
      "builder.updatePage",
    ]);
  });

  it("never includes anything that changes what shoppers see, or is irreversible", () => {
    for (const id of ["builder.publish", "builder.discardDraft", "builder.restoreVersion", "builder.deletePage", "builder.restorePage", "builder.startDesign"]) {
      expect(getAction(id)?.agentExecution, id).toBeUndefined();
    }
    expect(getAction("builder.publish")?.riskTier).toBe("high");
  });

  it("every agent-executable action is low risk, step-up free and undoable", () => {
    for (const d of allActions().filter((x) => x.agentExecution === "draft")) {
      expect(d.riskTier, d.id).toBe("low");
      expect(d.requiresStepUp ?? false, d.id).toBe(false);
      expect(d.undoable, d.id).toBe(true);
    }
  });

  it("advertises the flag in the registry listing", () => {
    expect(describeAction(getAction("builder.setProps")!).agentMayExecute).toBe(true);
    expect(describeAction(getAction("builder.publish")!).agentMayExecute).toBe(false);
    expect(describeAction(getAction("catalog.updateProduct")!).agentMayExecute).toBe(false);
  });

  it("refuses the flag anywhere else, at module load", () => {
    const base = { description: "x", input: z.object({}), permission: "cms.write", async run() {} };
    expect(() => defineAction({ ...base, id: "catalog.sneakyEdit", riskTier: "low", agentExecution: "draft" })).toThrow(/only builder/);
    expect(() => defineAction({ ...base, id: "builder.sneakyPublish", riskTier: "high", agentExecution: "draft" })).toThrow(/low-risk/);
    expect(() =>
      defineAction({ ...base, id: "builder.sneakyStepUp", riskTier: "low", requiresStepUp: true, agentExecution: "draft" }),
    ).toThrow(/low-risk/);
  });
});

describe("the agent gate in invokeAction", () => {
  it("still refuses an agent on a builder action outside the draft set, before the database", async () => {
    setAuthorizationResolver(async () => true);
    for (const id of ["builder.deletePage", "builder.discardDraft", "builder.restoreVersion"]) {
      const e = await invokeAction(id, { siteId: 1, pageId: 1, version: 1 }, { actor: agent }).catch((x) => x);
      expect(e, id).toBeInstanceOf(ApiError);
      expect((e as ApiError).code, id).toBe("HUMAN_APPROVAL_REQUIRED");
    }
  });

  it("refuses an agent publishing — high tier, whoever asks", async () => {
    setAuthorizationResolver(async () => true);
    const e = await invokeAction("builder.publish", { siteId: 1 }, { actor: agent }).catch((x) => x);
    expect((e as ApiError).code).toBe("HUMAN_APPROVAL_REQUIRED");
  });

  it("still refuses an agent on every non-builder action", async () => {
    setAuthorizationResolver(async () => true);
    const e = await invokeAction("catalog.updateProduct", { productId: 1, name: "x" }, { actor: agent }).catch((x) => x);
    expect((e as ApiError).code).toBe("HUMAN_APPROVAL_REQUIRED");
  });
});

describe("the edit lease (owner, 2026-10-31: the agent holds the pen while it works)", () => {
  const future = new Date(Date.now() + 60_000);
  const past = new Date(Date.now() - 1_000);
  const design = (sessionId: string | null, expiresAt: Date | null) =>
    ({ agentLockSessionId: sessionId, agentLockExpiresAt: expiresAt }) as SiteDesign;
  const refusal = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      return e as ApiError;
    }
    return null;
  };

  it("refuses everyone but the holding agent while it is active", () => {
    const leased = design("as_aaaaaaaaaaaaaaaaaaaa", future);
    expect(refusal(() => assertMayWrite(leased, user))?.code).toBe("AGENT_EDITING");
    expect(refusal(() => assertMayWrite(leased, { type: "token", id: "tok_1", orgId: "org_1" }))?.code).toBe("AGENT_EDITING");
    expect(refusal(() => assertMayWrite(leased, agent))).toBeNull();
    expect(refusal(() => assertMayWrite(leased, { ...agent, sessionId: "as_bbbbbbbbbbbbbbbbbbbb" } as Actor))?.code).toBe("AGENT_EDITING");
  });

  it("lets people write once it is released or expired, and stops a stopped agent", () => {
    expect(refusal(() => assertMayWrite(design(null, null), user))).toBeNull();
    expect(refusal(() => assertMayWrite(design("as_aaaaaaaaaaaaaaaaaaaa", past), user))).toBeNull();
    // A turn that was stopped no longer holds the lease, so its next write is refused.
    expect(refusal(() => assertMayWrite(design(null, null), agent))?.code).toBe("AGENT_EDITING");
    expect(refusal(() => assertMayWrite(design("as_aaaaaaaaaaaaaaaaaaaa", past), agent))?.code).toBe("AGENT_EDITING");
  });
});

describe("builder inverses read only their own record", () => {
  const record = (actionId: string, input: unknown, result: unknown, diff: RecordedInvocation["diff"] = []): RecordedInvocation => ({
    invocationId: "inv_1",
    actionId,
    input,
    result,
    diff,
  });
  const inverse = (r: RecordedInvocation) => getAction(r.actionId)!.inverse!(r);

  it("undoes an added block by removing it", () => {
    expect(inverse(record("builder.addBlock", { siteId: 1, pageId: 2 }, { nodeId: "n_aaaaaaaaaa" }))).toEqual({
      actionId: "builder.removeNodes",
      input: { siteId: 1, pageId: 2, nodeIds: ["n_aaaaaaaaaa"] },
      conflictCheck: "none",
    });
  });

  it("undoes a removal by putting the same subtrees back where they were", () => {
    const node = { id: "n_aaaaaaaaaa", type: "divider", props: {} };
    const inv = inverse(record("builder.removeNodes", { siteId: 1, pageId: 2, nodeIds: [node.id] }, { removed: [{ parentId: "n_rootrootro", index: 3, node }] }));
    expect(inv).toEqual({
      actionId: "builder.insertNodes",
      input: { siteId: 1, pageId: 2, placements: [{ parentId: "n_rootrootro", index: 3, node }] },
      conflictCheck: "none",
    });
    // And the inverse's input is valid for the action it names.
    expect(() => getAction("builder.insertNodes")!.input.parse(inv!.input)).not.toThrow();
  });

  it("undoes a prop change to the previous values, unsetting props that did not exist", () => {
    const inv = inverse(
      record("builder.setProps", { siteId: 1, pageId: 2, nodeId: "n_aaaaaaaaaa", props: {} }, {}, [
        { entity: "sitePage", entityId: "2", path: "nodes.n_aaaaaaaaaa.props.text", before: "Old", after: "New" },
        { entity: "sitePage", entityId: "2", path: "nodes.n_aaaaaaaaaa.props.caption", before: null, after: "Added" },
        { entity: "sitePage", entityId: "2", path: "nodes.n_aaaaaaaaaa.intent", before: null, after: "hero" },
      ]),
    );
    expect(inv).toEqual({
      actionId: "builder.setProps",
      input: { siteId: 1, pageId: 2, nodeId: "n_aaaaaaaaaa", props: { text: "Old" }, unset: ["caption"], intent: null },
    });
  });

  it("undoes styles, tokens, theme, moves and pages from their diffs", () => {
    expect(
      inverse(
        record("builder.setStyles", { siteId: 1, pageId: 2, nodeId: "n_aaaaaaaaaa", breakpoint: "md", styles: {} }, {}, [
          { entity: "sitePage", entityId: "2", path: "nodes.n_aaaaaaaaaa.styles.md.paddingY", before: null, after: "xl" },
        ]),
      )?.input,
    ).toEqual({ siteId: 1, pageId: 2, nodeId: "n_aaaaaaaaaa", breakpoint: "md", styles: { paddingY: null } });

    expect(
      inverse(
        record("builder.setThemeTokens", { siteId: 1, tokens: {} }, {}, [
          { entity: "siteDesign", entityId: "1", path: "draftTokens.accent", before: "#111111", after: "#C9184A" },
          { entity: "siteDesign", entityId: "1", path: "draftTokens.fontBody", before: null, after: "Inter" },
        ]),
      )?.input,
    ).toEqual({ siteId: 1, tokens: { accent: "#111111", fontBody: null } });

    expect(
      inverse(record("builder.setTheme", { siteId: 1, themeId: "noir" }, {}, [{ entity: "siteDesign", entityId: "1", path: "draftThemeId", before: "studio", after: "noir" }]))
        ?.input,
    ).toEqual({ siteId: 1, themeId: "studio" });

    expect(
      inverse(record("builder.moveNode", { siteId: 1, pageId: 2, nodeId: "n_aaaaaaaaaa", parentId: "n_bbbbbbbbbb" }, { from: { parentId: "n_cccccccccc", index: 4 } }))
        ?.input,
    ).toEqual({ siteId: 1, pageId: 2, nodeId: "n_aaaaaaaaaa", parentId: "n_cccccccccc", index: 4 });

    expect(inverse(record("builder.createPage", { siteId: 1, handle: "about", title: "About" }, { pageId: 9 }))?.actionId).toBe("builder.deletePage");
    expect(inverse(record("builder.deletePage", { siteId: 1, pageId: 9 }, {}))?.actionId).toBe("builder.restorePage");
  });

  it("every undoable builder action produces an inverse whose input its target accepts", () => {
    const samples: Record<string, RecordedInvocation> = {
      "builder.insertPreset": record("builder.insertPreset", { siteId: 1, pageId: 2 }, { nodeId: "n_aaaaaaaaaa" }),
      "builder.insertNodes": record("builder.insertNodes", { siteId: 1, pageId: 2 }, { inserted: [{ nodeId: "n_aaaaaaaaaa" }] }),
      "builder.duplicateNode": record("builder.duplicateNode", { siteId: 1, pageId: 2 }, { nodeId: "n_aaaaaaaaaa" }),
      "builder.updatePage": record("builder.updatePage", { siteId: 1, pageId: 2 }, {}, [{ entity: "sitePage", entityId: "2", path: "title", before: "Old", after: "New" }]),
      "builder.restorePage": record("builder.restorePage", { siteId: 1, pageId: 2 }, {}),
    };
    for (const [id, r] of Object.entries(samples)) {
      const inv = inverse(r)!;
      expect(() => getAction(inv.actionId)!.input.parse(inv.input), id).not.toThrow();
    }
  });
});
