import { describe, expect, it } from "vitest";
import { boolParam, enumParam } from "./api";

/**
 * The query-filter helpers, which decide what a list route does with input it
 * does not recognise.
 *
 * The rule they share: **an unrecognised filter value is a 400, never a silent
 * no-op**. Dropping it answers a question nobody asked with a list that looks
 * like the answer, and a person reading that screen cannot tell the difference.
 */

const sp = (qs: string) => new URLSearchParams(qs);

describe("boolParam", () => {
  it("reads true and false", () => {
    expect(boolParam(sp("ok=true"), "ok")).toBe(true);
    expect(boolParam(sp("ok=false"), "ok")).toBe(false);
  });

  it("is undefined when the param is absent — no filter, not false", () => {
    expect(boolParam(sp(""), "ok")).toBeUndefined();
  });

  /** `buildQuery` drops empty params, so an empty one means the filter is off. */
  it("treats an empty value as no filter", () => {
    expect(boolParam(sp("ok="), "ok")).toBeUndefined();
  });

  /**
   * The regression this replaced. `v === "true"` made every one of these
   * silently `false`, so `?enabled=yes` returned the *disabled* products — the
   * opposite of the request, presented as a real answer.
   */
  it.each(["yes", "1", "TRUE", "no", "0", "tru"])(
    "refuses %s rather than reading it as false",
    (value) => {
      expect(() => boolParam(sp(`ok=${value}`), "ok")).toThrowError(/invalid ok/);
    },
  );

  it("names the parameter and the allowed values in the refusal", () => {
    expect(() => boolParam(sp("enabled=yes"), "enabled")).toThrowError(
      /invalid enabled: expected true or false/,
    );
  });
});

describe("enumParam", () => {
  const tiers = ["read", "low", "medium", "high"] as const;

  it("returns an allowed value", () => {
    expect(enumParam(sp("riskTier=high"), "riskTier", tiers)).toBe("high");
  });

  it("is undefined when absent or empty", () => {
    expect(enumParam(sp(""), "riskTier", tiers)).toBeUndefined();
    expect(enumParam(sp("riskTier="), "riskTier", tiers)).toBeUndefined();
  });

  it("refuses a value outside the set and lists what was allowed", () => {
    expect(() => enumParam(sp("riskTier=wizard"), "riskTier", tiers)).toThrowError(
      /invalid riskTier: expected one of read, low, medium, high/,
    );
  });
});
