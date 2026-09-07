import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../api";
import "./index";
import { invokeAction } from "./invoke";
import { allActions, setAuthorizationResolver } from "./registry";
import type { Actor } from "./types";

/**
 * §22 rule 3 — a `high` action never auto-runs, whoever asks.
 *
 * The rule shipped with the registry and was enforced by nothing:
 * `describeAction` advertised `requiresHumanApproval` so an agent knew a gate
 * was coming, and then no gate came. For a browser session that was survivable
 * because the money-moving actions also demand a fresh second factor — but
 * **tokens are exempt from step-up**, so a token caller passed straight through
 * both.
 *
 * These tests run entirely in front of the database: every refusal here is
 * raised before `invokeAction` opens a transaction, which is what makes them
 * unit tests rather than integration ones.
 */

/** Grant every permission, so what these tests observe is the tier gate alone. */
function allowEverything() {
  setAuthorizationResolver(async () => true);
}

afterEach(() => {
  // Leave the resolver denying, which is its safe default outside a request.
  setAuthorizationResolver(async () => false);
});

const HIGH_ACTION = "customers.delete";
const LOW_ACTION = "billing.startPaymentMethodSetup";

function actor(type: Actor["type"]): Actor {
  const base = { id: `${type}_1`, orgId: "org_1" };
  return type === "agent"
    ? { type, ...base, onBehalfOfUserId: "usr_1" }
    : ({ type, ...base } as Actor);
}

async function invokeExpectingRefusal(actionId: string, a: Actor, dryRun = false) {
  try {
    await invokeAction(actionId, { customerId: 1 }, { actor: a, dryRun });
  } catch (e) {
    return e;
  }
  return null;
}

describe("the high-tier actions this gate protects", () => {
  /**
   * Pinned so the gate cannot be quietly emptied. If an action stops being
   * `high`, that is a decision someone should have to make deliberately.
   */
  it("still includes the destructive and money-moving ones", () => {
    const high = allActions()
      .filter((d) => d.riskTier === "high")
      .map((d) => d.id);

    expect(high).toContain("customers.delete");
    expect(high).toContain("orders.refund");
    expect(high).toContain("payments.connectRail");
    expect(high).toContain("billing.invoiceAssessments");
  });
});

describe("high-risk actions refuse non-human actors", () => {
  it.each(["token", "agent"] as const)("refuses a %s with HUMAN_APPROVAL_REQUIRED", async (type) => {
    allowEverything();
    const err = await invokeExpectingRefusal(HIGH_ACTION, actor(type));

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("HUMAN_APPROVAL_REQUIRED");
    expect((err as ApiError).status).toBe(403);
  });

  /**
   * The refusal has to say what to do instead, or an agent's only move is to
   * retry with a broader credential — the exact wrong lesson.
   */
  it("tells the caller to dry-run and hand the diff to a person", async () => {
    allowEverything();
    const err = (await invokeExpectingRefusal(HIGH_ACTION, actor("token"))) as ApiError;
    const details = err.details as { resolution: string; actorType: string; riskTier: string };

    expect(details.resolution).toMatch(/dryRun/);
    expect(details.actorType).toBe("token");
    expect(details.riskTier).toBe("high");
  });

  /**
   * Rule 2: the proposal flow is dry-run → diff → human approves. An agent must
   * still be able to *propose* a high-risk change; it just cannot approve one.
   * A gate that blocked dry runs would break the very workflow rule 3 assumes.
   */
  it("still allows a dry run, because that is the proposal path", async () => {
    allowEverything();
    const err = await invokeExpectingRefusal(HIGH_ACTION, actor("token"), true);

    // It may still fail for want of a real database or a real row — what it must
    // never be is the approval refusal.
    if (err instanceof ApiError) {
      expect(err.code).not.toBe("HUMAN_APPROVAL_REQUIRED");
    }
  });

  it("does not gate a low-risk action for a token", async () => {
    allowEverything();
    const err = await invokeExpectingRefusal(LOW_ACTION, actor("token"));

    if (err instanceof ApiError) {
      expect(err.code).not.toBe("HUMAN_APPROVAL_REQUIRED");
    }
  });
});

describe("actors that are exempt", () => {
  /**
   * **The billing sweep depends on this.** `billing.invoiceAssessments` is
   * `high` and runs at 03:00 on the first of the month with nobody awake to
   * approve it. A `system` actor is mintable from exactly one HTTP caller,
   * gated by `CRON_SECRET` (D41), and reads a clock rather than merchant
   * content — so it is not the actor rule 3 is aimed at.
   */
  it("lets a system actor through, or the monthly billing sweep stops", async () => {
    allowEverything();
    const err = await invokeExpectingRefusal("billing.invoiceAssessments", {
      type: "system",
      id: "cron:billing",
      orgId: "org_1",
    });

    if (err instanceof ApiError) {
      expect(err.code).not.toBe("HUMAN_APPROVAL_REQUIRED");
    }
  });

  /** A person *is* the human approval; the money-moving subset also steps up. */
  it("lets a user through", async () => {
    allowEverything();
    const err = await invokeExpectingRefusal(HIGH_ACTION, actor("user"));

    if (err instanceof ApiError) {
      expect(err.code).not.toBe("HUMAN_APPROVAL_REQUIRED");
    }
  });
});

describe("the permission check still comes first", () => {
  /**
   * Ordering matters: an unauthorized caller must not learn from the error
   * whether the action exists and is merely high-risk. Permission denial wins.
   */
  it("refuses an unpermitted token with FORBIDDEN, not the tier refusal", async () => {
    setAuthorizationResolver(async () => false);
    const err = (await invokeExpectingRefusal(HIGH_ACTION, actor("token"))) as ApiError;

    expect(err.code).toBe("FORBIDDEN");
  });
});
