import { describe, expect, it } from "vitest";
import "../actions/index";
import { allActions, describeAction } from "../actions/registry";
import { permissionsForRole } from "../auth/permissions";
import {
  actionIdFor,
  DRY_RUN_ARG,
  MCP_PROTOCOL_VERSION,
  negotiateProtocolVersion,
  splitDryRun,
  toolFor,
  toolNameFor,
  visibleTools,
} from "./tools";

/**
 * The registry → MCP tool translation (§22).
 *
 * This is the layer where a mistake is silent: a tool that is misnamed, missing
 * from a listing, or described without its approval requirement does not throw
 * anywhere — an agent simply does the wrong thing, and the audit log records a
 * refusal nobody understands.
 */

const described = (id: string) => {
  const def = allActions().find((d) => d.id === id);
  if (!def) throw new Error(`no such action: ${id}`);
  return describeAction(def);
};

describe("tool naming", () => {
  it("replaces dots, which many MCP clients reject in a tool name", () => {
    expect(toolNameFor("catalog.updateVariant")).toBe("catalog_updateVariant");
  });

  it("round-trips back to the action id", () => {
    expect(actionIdFor(toolNameFor("catalog.updateVariant"))).toBe("catalog.updateVariant");
  });

  /**
   * **The assumption the whole mapping rests on.** `actionIdFor` turns every
   * underscore back into a dot, so an action id containing one would be routed
   * to a different id than the one advertised — or collide with another tool.
   * Asserted rather than assumed, because the day someone adds
   * `catalog.set_options` this breaks silently.
   */
  it("holds because no action id contains an underscore", () => {
    const offenders = allActions()
      .map((d) => d.id)
      .filter((id) => id.includes("_"));
    expect(offenders).toEqual([]);
  });

  it("gives every registered action a distinct tool name", () => {
    const names = allActions().map((d) => toolNameFor(d.id));
    expect(new Set(names).size).toBe(names.length);
  });

  /** Whatever the ids become, the names must stay inside MCP's charset. */
  it("produces names matching the accepted character set", () => {
    for (const def of allActions()) {
      expect(toolNameFor(def.id)).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    }
  });
});

describe("protocol negotiation", () => {
  it("echoes a version it supports", () => {
    expect(negotiateProtocolVersion("2024-11-05")).toBe("2024-11-05");
  });

  it("falls back to its own version for anything unknown", () => {
    expect(negotiateProtocolVersion("1999-01-01")).toBe(MCP_PROTOCOL_VERSION);
    expect(negotiateProtocolVersion(undefined)).toBe(MCP_PROTOCOL_VERSION);
    expect(negotiateProtocolVersion(42)).toBe(MCP_PROTOCOL_VERSION);
  });
});

describe("the dry-run argument", () => {
  it("is advertised on every tool's schema", () => {
    const tool = toolFor(described("catalog.updateVariant"));
    const props = tool.inputSchema.properties as Record<string, unknown>;
    expect(props[DRY_RUN_ARG]).toMatchObject({ type: "boolean" });
  });

  it("is stripped from the input the action validates", () => {
    const { dryRun, input } = splitDryRun({ variantId: 7, [DRY_RUN_ARG]: true });
    expect(dryRun).toBe(true);
    expect(input).toEqual({ variantId: 7 });
  });

  it("defaults to a real invocation when absent", () => {
    expect(splitDryRun({ variantId: 7 })).toEqual({ dryRun: false, input: { variantId: 7 } });
  });

  /** Only a literal `true` proposes; a truthy string must not silently dry-run. */
  it("treats a non-boolean as not set", () => {
    expect(splitDryRun({ [DRY_RUN_ARG]: "true" }).dryRun).toBe(false);
  });

  it("survives missing or malformed arguments", () => {
    expect(splitDryRun(undefined)).toEqual({ dryRun: false, input: {} });
    expect(splitDryRun(null)).toEqual({ dryRun: false, input: {} });
  });
});

describe("tool descriptions carry what the agent must know before calling", () => {
  /**
   * An agent reads only the description when choosing. Omitting the approval
   * requirement means it learns by being refused, which wastes a call and
   * teaches it nothing about what to do next.
   */
  it("warns on a high-risk action and names the way forward", () => {
    const tool = toolFor(described("customers.delete"));
    expect(tool.description).toMatch(/high/i);
    expect(tool.description).toContain(DRY_RUN_ARG);
    expect(tool.annotations.destructiveHint).toBe(true);
  });

  it("warns when a fresh second factor will be demanded", () => {
    const tool = toolFor(described("payments.connectRail"));
    expect(tool.description).toMatch(/15 minutes/);
  });

  it("does not warn on a low-risk action", () => {
    const tool = toolFor(described("billing.startPaymentMethodSetup"));
    expect(tool.description).not.toMatch(/high/i);
    expect(tool.annotations.destructiveHint).toBe(false);
  });

  /**
   * Every registry action mutates (§22 rule 1), so this must not claim
   * otherwise. It becomes a real derivation the day read actions exist.
   */
  it("never claims a registry tool is read-only", () => {
    for (const def of allActions()) {
      expect(toolFor(describeAction(def)).annotations.readOnlyHint).toBe(false);
    }
  });
});

describe("listing is filtered by the same permission that would refuse the call", () => {
  it("hides tools the caller cannot invoke", async () => {
    const only = "catalog.write";
    const tools = await visibleTools(allActions(), describeAction, async (p) => p === only);
    const ids = tools.map((t) => actionIdFor(t.name));

    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(allActions().find((d) => d.id === id)?.permission).toBe(only);
    }
  });

  it("returns nothing for a caller with no permissions", async () => {
    expect(await visibleTools(allActions(), describeAction, async () => false)).toEqual([]);
  });

  /**
   * High-risk tools stay listed even though an agent cannot run them — it can
   * still dry-run them, and the description says how. Hiding them would make
   * the proposal flow undiscoverable.
   */
  it("still lists high-risk tools, since they can be proposed", async () => {
    const tools = await visibleTools(allActions(), describeAction, async () => true);
    expect(tools.map((t) => t.name)).toContain(toolNameFor("customers.delete"));
  });

  it("is sorted, so a client sees a stable order", async () => {
    const names = (await visibleTools(allActions(), describeAction, async () => true)).map(
      (t) => t.name,
    );
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("describes every registered action without throwing", async () => {
    const tools = await visibleTools(allActions(), describeAction, async () => true);
    expect(tools).toHaveLength(allActions().length);
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });
});

describe("read tools coexist with action tools", () => {
  /**
   * The two namespaces are populated from unrelated places — one from the
   * registry, one from a hand-written table — so nothing but this stops a
   * future action from shadowing a read tool. A collision would be silent:
   * `tools/call` checks reads first, so the action would simply stop being
   * reachable.
   */
  it("never collides with an action's tool name", async () => {
    const { readToolNames } = await import("./reads");
    const actionNames = new Set(allActions().map((d) => toolNameFor(d.id)));
    for (const name of readToolNames()) {
      expect(actionNames.has(name)).toBe(false);
    }
  });

  it("keeps every read tool under the read_ prefix, which is what guarantees that", async () => {
    const { readToolNames } = await import("./reads");
    for (const name of readToolNames()) expect(name).toMatch(/^read_[A-Za-z0-9_]+$/);
  });

  it("declares no action id starting with read_, the other half of the guarantee", () => {
    expect(allActions().filter((d) => toolNameFor(d.id).startsWith("read_"))).toEqual([]);
  });

  /** Only the read tools may claim to be read-only. */
  it("marks read tools readOnlyHint and non-destructive", async () => {
    const { readTools } = await import("./reads");
    for (const tool of readTools()) {
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.annotations.destructiveHint).toBe(false);
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("gives every read tool a distinct name", async () => {
    const { readToolNames } = await import("./reads");
    const names = readToolNames();
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("a scoped token narrows the toolset, which is the ergonomic answer too", () => {
  /**
   * A model choosing among 68 tools chooses worse than one choosing among 26,
   * and the fix is the same thing security already wants: mint the narrowest
   * role that can do the job. This pins that the scoping actually bites, so
   * nobody "simplifies" the permission filter and quietly hands every token the
   * full surface.
   */
  const countFor = async (role: Parameters<typeof permissionsForRole>[0]) => {
    const perms = new Set<string>(permissionsForRole(role));
    const writes = await visibleTools(allActions(), describeAction, async (p) => perms.has(p));
    return writes.length;
  };

  it("gives a read-only role no write tools at all", async () => {
    expect(await countFor("analyst")).toBe(0);
    expect(await countFor("viewer")).toBe(0);
  });

  it("gives a catalog manager markedly fewer than an administrator", async () => {
    const admin = await countFor("administrator");
    const catalog = await countFor("catalog_manager");

    expect(catalog).toBeGreaterThan(0);
    // Not a precise count — that moves whenever an action is added. The property
    // worth holding is that narrowing the role really does narrow the surface.
    expect(catalog).toBeLessThan(admin / 2);
  });

  it("gives an administrator every registered action", async () => {
    expect(await countFor("administrator")).toBe(allActions().length);
  });
});
