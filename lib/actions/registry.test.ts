import { describe, expect, it } from "vitest";
import { z } from "zod";
import "./index";
import { allActions, defineAction, describeAction, getAction } from "./registry";

/**
 * The registry listing (`GET /api/actions`, §22).
 *
 * This endpoint is how an agent discovers Markii at all, so a single action
 * that cannot be described takes the whole catalogue down with it — which is
 * exactly what had been happening.
 */
describe("describeAction", () => {
  it("describes every registered action without throwing", () => {
    /**
     * **`GET /api/actions` was answering 500 for any caller holding
     * `commerce.write`** until 2026-08-18. `discounts.create` and
     * `discounts.update` accept `z.coerce.date()`, a `Date` has no JSON Schema
     * representation, and zod's default for an unrepresentable type is to
     * throw — so one field in one action emptied the registry for everyone who
     * could see it. Found by the undo tests, which read `undoable` off this
     * response.
     *
     * The route maps over every action, so this loop is the same failure.
     */
    expect(() => allActions().map(describeAction)).not.toThrow();
    expect(allActions().length).toBeGreaterThan(50);
  });

  it("expresses a date input as an ISO string rather than as anything at all", () => {
    const schema = describeAction(getAction("discounts.update")!).input as {
      properties: Record<string, { type?: string; format?: string; anyOf?: unknown[] }>;
    };

    const startsAt = JSON.stringify(schema.properties.startsAt);
    // `{}` is what `unrepresentable: "any"` alone produces, and it means
    // "anything goes" — an agent reading it would not know a date was wanted.
    // That is a confident wrong answer, which is worse than a loose type.
    expect(startsAt).toContain("date-time");
  });

  it("publishes the flags an agent needs before it invokes anything", () => {
    const described = describeAction(getAction("catalog.updateVariant")!);
    expect(described).toMatchObject({
      id: "catalog.updateVariant",
      permission: "catalog.write",
      undoable: true,
      requiresHumanApproval: false,
    });
  });

  it("refuses a definition that claims undo without an inverse", () => {
    expect(() =>
      defineAction({
        id: "test.claimsUndo",
        description: "Claims a way back it does not have.",
        input: z.object({}),
        permission: "catalog.write",
        riskTier: "low",
        undoable: true,
        run: async () => ({}),
      }),
    ).toThrow(/defines no inverse/);
  });

  it("refuses an inverse that is not declared undoable", () => {
    expect(() =>
      defineAction({
        id: "test.quietInverse",
        description: "Has a way back but does not say so.",
        input: z.object({}),
        permission: "catalog.write",
        riskTier: "low",
        inverse: () => ({ actionId: "test.quietInverse", input: {} }),
        run: async () => ({}),
      }),
      // Otherwise the registry and the audit table would report `false` for an
      // action that can in fact be undone, and no screen would offer it.
    ).toThrow(/does not declare undoable/);
  });
});
