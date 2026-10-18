import { describe, expect, it } from "vitest";
import { z } from "zod";
import "../actions/index";
import { getAction } from "../actions/registry";
import type { DiffEntry } from "../db";
import { dashboardPageExists } from "../../tests/stubs/dashboard-routes";
import { assistantTools } from "./assistant/agent";
import { ASSISTANT_PROPOSABLE_ACTIONS } from "./assistant/allowlist";
import { helpTopics } from "./assistant/help";
import { CATALOG_PROPOSABLE_ACTIONS } from "./catalog/allowlist";
import { AGENT_MONTHLY_TOKEN_CAP, allowanceFor, usagePeriodEnd, usagePeriodStart } from "./config";
import { affectedCount, diffForModel, proposeToolName, sameDiff } from "./proposal-diff";

/**
 * Merchant agents (D47) — the parts that decide what an agent may touch,
 * whether an approval still means what the merchant read, and when the beta
 * stops spending.
 */

const d = (path: string, before: unknown, after: unknown, entityId = "7"): DiffEntry => ({
  entity: "product",
  entityId,
  path,
  before,
  after,
});

describe("the Catalog agent's write surface", () => {
  it("names only actions that exist", () => {
    for (const id of CATALOG_PROPOSABLE_ACTIONS) expect(getAction(id), id).toBeDefined();
  });

  /**
   * The allowlist is the enforcement, not the instructions. A model talked
   * into "update the payout address" has no tool that could even propose it.
   */
  it("reaches nothing outside the catalog and stock", () => {
    for (const id of CATALOG_PROPOSABLE_ACTIONS) {
      expect(id, id).toMatch(/^(catalog|inventory)\./);
      expect(getAction(id)!.permission, id).toBe("catalog.write");
    }
  });

  it("holds no action that moves money or grants access", () => {
    for (const id of CATALOG_PROPOSABLE_ACTIONS) {
      expect(getAction(id)!.requiresStepUp ?? false, id).toBe(false);
    }
  });

  /** Every proposal should be undoable once approved — the receipt's Undo is the safety net. */
  it("proposes only undoable actions", () => {
    for (const id of CATALOG_PROPOSABLE_ACTIONS) expect(getAction(id)!.undoable, id).toBe(true);
  });

  it("gives every propose tool a distinct name a model API accepts", () => {
    const names = CATALOG_PROPOSABLE_ACTIONS.map(proposeToolName);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-zA-Z0-9_]{1,64}$/);
  });

  /**
   * The tool's input schema is the action's own; it must survive conversion
   * to JSON Schema, which is what the model is sent. `z.coerce.date()` once
   * broke exactly this for the whole registry.
   */
  it("describes every proposable action as JSON Schema", () => {
    for (const id of CATALOG_PROPOSABLE_ACTIONS) {
      expect(() => z.toJSONSchema(getAction(id)!.input as z.ZodType), id).not.toThrow();
    }
  });
});

describe("the assistant", () => {
  const topics = helpTopics({ rootDomain: "markii.shop" });
  const auth = { org: { id: "org_test" } as never, role: "viewer" as const, storeIds: "all" as const };
  const turn = {
    agent: "assistant" as const,
    orgId: "org_test",
    userId: "user_test",
    sessionId: "as_test",
    actor: { type: "agent" as const, id: "agent:assistant", orgId: "org_test", onBehalfOfUserId: "user_test" },
  };

  /**
   * The allowlist is the enforcement. A model talked into "connect my payout
   * wallet" or "just create the shipping zone" has no tool that could even
   * propose it — see `assistant/allowlist.ts` for why creates cannot be added.
   */
  it("can propose nothing", () => {
    expect(ASSISTANT_PROPOSABLE_ACTIONS).toEqual([]);
    const names = Object.keys(assistantTools(turn, auth, { orgId: "org_test", storeIds: "all" }, topics));
    expect(names.filter((n) => n.startsWith("propose_"))).toEqual([]);
    expect(names.sort()).toEqual(["get_plans", "list_stores", "read_help", "setup_status", "store_health"]);
  });

  /** What the model is sent. `z.coerce.date()` once broke exactly this for the registry. */
  it("describes every tool's input as JSON Schema", () => {
    const tools = assistantTools(turn, auth, { orgId: "org_test", storeIds: "all" }, topics);
    for (const [name, t] of Object.entries(tools)) {
      expect(() => z.toJSONSchema(t.inputSchema as z.ZodType), name).not.toThrow();
    }
  });

  it("gives every help topic a distinct id a tool enum accepts", () => {
    const ids = topics.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z_]+$/);
  });

  /** A link the assistant repeats to a merchant is a claim; a 404 is a broken one. */
  it("links only to dashboard pages that exist", () => {
    for (const t of topics) {
      for (const link of t.links) expect(dashboardPageExists(link.href), `${t.id}: ${link.href}`).toBe(true);
    }
  });

  /**
   * Prices live in `lib/plans.ts` and reach the assistant through `get_plans`.
   * A dollar figure written into a help topic is a second copy that will go
   * stale the day pricing changes.
   */
  it("keeps prices out of the help topics", () => {
    for (const t of topics) expect(`${t.summary} ${t.body}`, t.id).not.toMatch(/\$\d/);
  });

  it("quotes plan prices from the plan catalog, formatted for the currency", async () => {
    const tools = assistantTools(turn, auth, { orgId: "org_test", storeIds: "all" }, topics);
    const result = (await tools.get_plans.execute!({}, { toolCallId: "t", messages: [], context: {} } as never)) as {
      plans: { plan: string; monthly: string; feeAboveThreshold: { physical: string; digital: string } }[];
    };
    const starter = result.plans.find((p) => p.plan === "starter")!;
    expect(starter.monthly).toBe("$19.00");
    expect(starter.feeAboveThreshold).toEqual({ physical: "1.5%", digital: "3%" });
  });
});

describe("sameDiff — whether an approval still means what the merchant read", () => {
  it("accepts the same changes in a different order", () => {
    expect(sameDiff([d("name", "A", "B"), d("priceCents", 100, 200)], [d("priceCents", 100, 200), d("name", "A", "B")])).toBe(true);
  });

  it("refuses when the before has moved — someone edited it since", () => {
    expect(sameDiff([d("priceCents", 100, 200)], [d("priceCents", 150, 200)])).toBe(false);
  });

  it("refuses when a field dropped out — it already holds the proposed value", () => {
    expect(sameDiff([d("name", "A", "B"), d("sku", null, "X")], [d("name", "A", "B")])).toBe(false);
  });

  it("refuses the same field on a different product", () => {
    expect(sameDiff([d("name", "A", "B", "7")], [d("name", "A", "B", "8")])).toBe(false);
  });

  it("treats null and absent as the same value, as the action records them", () => {
    expect(sameDiff([d("sku", undefined, "X")], [d("sku", null, "X")])).toBe(true);
  });
});

describe("proposal shapes", () => {
  it("counts entities, not fields", () => {
    expect(affectedCount([d("name", 1, 2, "7"), d("sku", 1, 2, "7"), d("name", 1, 2, "8")])).toBe(2);
  });

  it("clips long values for the model, saying how long they were", () => {
    const [entry] = diffForModel([d("description", null, "x".repeat(1_000))]);
    expect(String(entry.after)).toContain("(1000 characters)");
    expect(String(entry.after).length).toBeLessThan(500);
  });
});

describe("the beta allowance", () => {
  const now = new Date("2026-10-15T12:00:00Z");

  it("allows a turn while tokens remain and stops at the cap", () => {
    expect(allowanceFor(AGENT_MONTHLY_TOKEN_CAP - 1, now).allowed).toBe(true);
    expect(allowanceFor(AGENT_MONTHLY_TOKEN_CAP, now).allowed).toBe(false);
    expect(allowanceFor(AGENT_MONTHLY_TOKEN_CAP + 500, now).remainingTokens).toBe(0);
  });

  it("measures over the UTC calendar month and says when it resets", () => {
    expect(usagePeriodStart(now).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(usagePeriodEnd(now).toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(usagePeriodEnd(new Date("2026-12-31T23:59:00Z")).toISOString()).toBe(
      "2027-01-01T00:00:00.000Z",
    );
  });
});
