import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApiError } from "../api";
import { isReportableToolError, rpcErrorPayload, toolErrorPayload } from "./errors";

/**
 * Error shaping for the MCP wire.
 *
 * **These tests exist because the integration guard cannot prove much on its
 * own.** Asserting that a real response happens not to contain `DATABASE_URL`
 * passes just as well when nothing is sanitized and nothing happened to leak.
 * Here the leaky error is constructed deliberately, so the stripping is
 * observed rather than assumed.
 */

/** An error carrying every kind of thing the copy rule strips. */
const leaky = () =>
  new ApiError(
    "CONFIGURATION_REQUIRED",
    503,
    "Stripe is unconfigured — set STRIPE_SECRET_KEY, see docs/BACKEND.md §6 and lib/payments/stripe.ts",
    {
      resolution: "Set SUPABASE_SERVICE_ROLE_KEY and DATABASE_URL in .env.local",
      nested: { hint: "described in CLAUDE.md, Phase B" },
      list: ["CRON_SECRET is unset", "harmless text"],
    },
  );

describe("toolErrorPayload", () => {
  it("strips env var names from the message", () => {
    const text = toolErrorPayload(leaky());
    expect(text).not.toContain("STRIPE_SECRET_KEY");
    expect(text).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(text).not.toContain("DATABASE_URL");
    expect(text).not.toContain("CRON_SECRET");
  });

  it("strips repo paths and internal planning references", () => {
    const text = toolErrorPayload(leaky());
    expect(text).not.toContain("docs/BACKEND.md");
    expect(text).not.toContain("lib/payments/stripe.ts");
    expect(text).not.toContain("CLAUDE.md");
    expect(text).not.toMatch(/§\d/);
  });

  /** Sanitizing must reach nested objects and arrays, not just the top level. */
  it("strips them out of nested details too", () => {
    const text = toolErrorPayload(leaky());
    expect(text).not.toContain(".env.local");
    expect(text).not.toContain("Phase B");
  });

  /** Stripping must not empty the response — the agent still needs the code. */
  it("keeps the error code and the harmless text", () => {
    const parsed = JSON.parse(toolErrorPayload(leaky()));
    expect(parsed.code).toBe("CONFIGURATION_REQUIRED");
    expect(JSON.stringify(parsed)).toContain("harmless text");
  });

  it("reports a validation failure field by field", () => {
    const schema = z.object({ variantId: z.number(), priceMinor: z.number() });
    const err = schema.safeParse({ variantId: "x", priceMinor: 1 }).error!;

    const parsed = JSON.parse(toolErrorPayload(err));
    expect(parsed.code).toBe("VALIDATION_ERROR");
    expect(parsed.issues[0].field).toBe("variantId");
    expect(parsed.issues[0].message).toBeTruthy();
  });

  it("names the root when an issue has no path", () => {
    const err = z.string().safeParse(42).error!;
    expect(JSON.parse(toolErrorPayload(err)).issues[0].field).toBe("(root)");
  });
});

describe("isReportableToolError", () => {
  it("accepts the two kinds an agent can act on", () => {
    expect(isReportableToolError(new ApiError("NOT_FOUND", 404, "nope"))).toBe(true);
    expect(isReportableToolError(z.string().safeParse(1).error!)).toBe(true);
  });

  /**
   * Anything else is a bug in the server, not a refusal the agent can fix — so
   * it must rethrow into the protocol path where the text is withheld.
   */
  it("rejects an unexpected error so it never becomes a tool result", () => {
    expect(isReportableToolError(new Error("connection terminated unexpectedly"))).toBe(false);
    expect(isReportableToolError("something")).toBe(false);
  });
});

describe("rpcErrorPayload", () => {
  it("sanitizes an ApiError and keeps its code", () => {
    const { message, data } = rpcErrorPayload(leaky());
    expect(message).not.toContain("STRIPE_SECRET_KEY");
    expect(data?.code).toBe("CONFIGURATION_REQUIRED");
    expect(JSON.stringify(data)).not.toContain("DATABASE_URL");
  });

  /**
   * **The regression this replaced.** The route returned
   * `e instanceof Error ? e.message : String(e)`, so a driver error naming
   * tables and columns went straight to the model.
   */
  it("withholds everything about an unrecognised error", () => {
    const dbError = new Error(
      'relation "action_invocations" does not exist at lib/db/index.ts, DATABASE_URL=postgres://u:p@h/db',
    );
    const { message, data } = rpcErrorPayload(dbError);

    expect(message).toBe("Something went wrong.");
    expect(message).not.toContain("action_invocations");
    expect(message).not.toContain("postgres://");
    expect(data).toBeUndefined();
  });

  it("withholds a thrown non-Error too", () => {
    expect(rpcErrorPayload("DATABASE_URL=secret").message).toBe("Something went wrong.");
  });
});
