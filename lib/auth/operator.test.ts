import { describe, expect, it } from "vitest";
import { isOperatorEmail, parseOperatorAllowlist } from "./operator";

/**
 * The allowlist behind `requireOperator` (G12). Who may suspend a store is
 * decided by this parse, so its edges are worth pinning: an entry that reads
 * as broader than intended is a merchant able to suspend other merchants.
 */
describe("parseOperatorAllowlist", () => {
  it("is null when unset or blank — nobody is an operator by default", () => {
    expect(parseOperatorAllowlist(undefined)).toBeNull();
    expect(parseOperatorAllowlist("")).toBeNull();
    expect(parseOperatorAllowlist("  , ,")).toBeNull();
  });

  it("separates exact addresses from @domain entries, case-folded", () => {
    const list = parseOperatorAllowlist(" Ops@Markii.Shop, @Ops.markii.shop ")!;
    expect([...list.emails]).toEqual(["ops@markii.shop"]);
    expect([...list.domains]).toEqual(["ops.markii.shop"]);
  });
});

describe("isOperatorEmail", () => {
  const list = parseOperatorAllowlist("one@markii.shop,@ops.markii.shop");

  it("matches an exact address regardless of case", () => {
    expect(isOperatorEmail("One@Markii.Shop", list)).toBe(true);
  });

  it("matches any address at an allowlisted domain", () => {
    expect(isOperatorEmail("anyone@ops.markii.shop", list)).toBe(true);
  });

  /** `@markii.shop` is every merchant fixture and, in production, no one special. */
  it("does not treat a parent domain as covered by a subdomain entry", () => {
    expect(isOperatorEmail("merchant@markii.shop", list)).toBe(false);
  });

  it("does not match a look-alike domain", () => {
    expect(isOperatorEmail("x@ops.markii.shop.evil.example", list)).toBe(false);
    expect(isOperatorEmail("x@notops.markii.shop", list)).toBe(false);
  });

  it("refuses everyone when there is no list", () => {
    expect(isOperatorEmail("one@markii.shop", null)).toBe(false);
  });

  it("refuses a missing address", () => {
    expect(isOperatorEmail(null, list)).toBe(false);
    expect(isOperatorEmail("", list)).toBe(false);
  });
});
