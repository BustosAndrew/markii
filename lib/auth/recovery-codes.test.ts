import { describe, expect, it } from "vitest";
import { normalizeCode } from "./recovery-codes";

/**
 * MFA recovery codes (D40) — the pure half.
 *
 * `issueRecoveryCodes` and `consumeRecoveryCode` write to the database and
 * belong to the integration suite; what is testable here is the format, which is
 * where the human failure modes live. A recovery code is only ever typed by
 * someone locked out of their own store, reading it off paper, probably in a
 * hurry — so the parsing has to be forgiving in exactly the ways people are
 * sloppy, and unforgiving everywhere else.
 */

describe("normalizeCode", () => {
  it("accepts the formatting it hands out", () => {
    expect(normalizeCode("ABCDE-FGHJK-MNPQR-STVWX")).toBe("ABCDEFGHJKMNPQRSTVWX");
  });

  /** Dashes are cosmetic, so typing without them must still work. */
  it("accepts the same code with no dashes", () => {
    expect(normalizeCode("ABCDEFGHJKMNPQRSTVWX")).toBe("ABCDEFGHJKMNPQRSTVWX");
  });

  it("uppercases, so case is never a reason to be locked out", () => {
    expect(normalizeCode("abcde-fghjk-mnpqr-stvwx")).toBe("ABCDEFGHJKMNPQRSTVWX");
  });

  /** Copy-paste out of a document brings whitespace with it. */
  it("strips spaces and stray punctuation", () => {
    expect(normalizeCode("  ABCDE FGHJK\tMNPQR\nSTVWX  ")).toBe("ABCDEFGHJKMNPQRSTVWX");
    expect(normalizeCode("ABCDE—FGHJK–MNPQR-STVWX")).toBe("ABCDEFGHJKMNPQRSTVWX");
  });

  it("is idempotent, so normalizing twice cannot corrupt a code", () => {
    const once = normalizeCode("abcde-fghjk-mnpqr-stvwx");
    expect(normalizeCode(once)).toBe(once);
  });

  /**
   * The alphabet deliberately omits `I`, `L`, `O`, and `U`. This asserts they
   * are not silently *translated* into look-alikes — a code containing them is
   * wrong, and quietly turning `O` into `0` would accept a code that was never
   * issued.
   */
  it("does not map look-alike characters onto the alphabet", () => {
    expect(normalizeCode("O0OO0-11111-22222-33333")).toBe("O0OO0111112222233333");
    expect(normalizeCode("O0OO0-11111-22222-33333")).toContain("O");
  });

  it("leaves an empty or junk input empty rather than inventing a code", () => {
    expect(normalizeCode("")).toBe("");
    expect(normalizeCode("----")).toBe("");
    expect(normalizeCode("!@#$%")).toBe("");
  });
});
