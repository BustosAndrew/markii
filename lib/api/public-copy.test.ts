import { describe, expect, it } from "vitest";
import { sanitizePublicCopy, sanitizePublicValue } from "./public-copy";

/**
 * The copy rule: strip internal planning refs, repo paths and credential hints
 * from anything shown to merchants, shoppers, or agents.
 *
 * This had no tests, and one of the things it claimed to strip it never did —
 * see the section-reference cases below. Every sanitized error on the HTTP
 * surface goes through here, so a hole is a hole everywhere at once.
 */

describe("section references", () => {
  /**
   * **The regression.** These sat inside a `\b(...)\b` group where they could
   * not match: `§` is a non-word character, so a leading word boundary before
   * it never holds. Only the `API §22` spelling worked.
   */
  it("strips a bare section reference", () => {
    expect(sanitizePublicCopy("Refused, see §6 for why")).not.toContain("§6");
  });

  it("strips a section reference with a rule number", () => {
    const out = sanitizePublicCopy("Blocked by §22 rule 3 on this store");
    expect(out).not.toContain("§22");
    expect(out).not.toContain("rule 3");
  });

  it("strips a decimal section reference", () => {
    expect(sanitizePublicCopy("Covered in §18.4 of the contract")).not.toContain("§18.4");
  });

  it("still strips the API-prefixed spelling that always worked", () => {
    expect(sanitizePublicCopy("Defined in API §22 here")).not.toMatch(/API\s*§|§22/);
  });

  it("leaves the surrounding sentence readable", () => {
    expect(sanitizePublicCopy("Refused, see §6 for why")).toBe("Refused, see for why");
  });

  /** A section mark that is not a reference must survive — it is ordinary text. */
  it("leaves a lone section mark alone", () => {
    expect(sanitizePublicCopy("Priced per § of fabric")).toContain("§");
  });
});

describe("repo and planning references", () => {
  it.each([
    ["docs/BACKEND.md", "Set it up, see docs/BACKEND.md now"],
    ["CLAUDE.md", "Described in CLAUDE.md today"],
    ["Phase B", "Arrives in Phase B soon"],
    ["D45", "Decided by D45 last month"],
  ])("strips %s", (needle, input) => {
    expect(sanitizePublicCopy(input)).not.toContain(needle);
  });

  it("strips a path and a section together", () => {
    const out = sanitizePublicCopy("see docs/BACKEND.md §6 now");
    expect(out).not.toContain("docs/BACKEND.md");
    expect(out).not.toContain("§6");
  });
});

describe("credential and ops hints", () => {
  it.each([
    "STRIPE_SECRET_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "DATABASE_URL",
    "CRON_SECRET",
    "AWS_SECRET_ACCESS_KEY",
  ])("strips %s", (name) => {
    expect(sanitizePublicCopy(`Missing ${name} on this deployment`)).not.toContain(name);
  });

  it("strips a source path", () => {
    expect(sanitizePublicCopy("Thrown from lib/payments/stripe.ts here")).not.toContain(
      "lib/payments/stripe.ts",
    );
  });

  it("strips an env file name", () => {
    expect(sanitizePublicCopy("Add it to .env.local please")).not.toContain(".env.local");
  });

  /**
   * A tip that was only ever "set THIS_VAR" collapses to noise once the name is
   * gone, so the whole sentence is replaced rather than left as a fragment.
   */
  it("replaces a config tip that is left meaningless", () => {
    expect(sanitizePublicCopy("Set STRIPE_SECRET_KEY to enable this")).toMatch(
      /additional platform configuration/i,
    );
  });
});

describe("sanitizePublicValue", () => {
  it("reaches into nested objects and arrays", () => {
    const cleaned = sanitizePublicValue({
      message: "see docs/PLAN.md",
      nested: { hint: "needs DATABASE_URL" },
      list: ["Phase C", "fine"],
    });
    const json = JSON.stringify(cleaned);

    expect(json).not.toContain("docs/PLAN.md");
    expect(json).not.toContain("DATABASE_URL");
    expect(json).not.toContain("Phase C");
    expect(json).toContain("fine");
  });

  it("passes non-strings through unchanged", () => {
    expect(sanitizePublicValue({ n: 42, ok: true, nothing: null })).toEqual({
      n: 42,
      ok: true,
      nothing: null,
    });
  });

  it("leaves ordinary merchant copy untouched", () => {
    const text = "That product is out of stock. Try a smaller quantity.";
    expect(sanitizePublicCopy(text)).toBe(text);
  });
});
