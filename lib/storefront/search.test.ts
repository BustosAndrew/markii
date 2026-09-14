import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_QUERY_LENGTH,
  clampLimit,
  likePattern,
  normalizeQuery,
} from "./search";

/**
 * The pure edges of storefront search. Ranking and isolation are asserted
 * against a real database in `tests/integration/storefront-search.test.ts` —
 * a `tsvector` cannot be faked usefully here.
 */

describe("normalizeQuery", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeQuery("  leather   wallet \n")).toBe("leather wallet");
  });

  it("treats nothing-to-search-for as an empty query, not a query for whitespace", () => {
    expect(normalizeQuery(null)).toBe("");
    expect(normalizeQuery(undefined)).toBe("");
    expect(normalizeQuery("   ")).toBe("");
  });

  it("caps a pasted wall of text rather than refusing it", () => {
    const long = "x".repeat(MAX_QUERY_LENGTH * 3);
    expect(normalizeQuery(long)).toHaveLength(MAX_QUERY_LENGTH);
  });
});

describe("clampLimit", () => {
  it("defaults when absent or unparsable", () => {
    expect(clampLimit(null)).toBe(DEFAULT_LIMIT);
    expect(clampLimit("")).toBe(DEFAULT_LIMIT);
    expect(clampLimit("lots")).toBe(DEFAULT_LIMIT);
  });

  it("clamps into [1, MAX_LIMIT]", () => {
    expect(clampLimit("0")).toBe(1);
    expect(clampLimit(-5)).toBe(1);
    expect(clampLimit("7")).toBe(7);
    expect(clampLimit(MAX_LIMIT * 10)).toBe(MAX_LIMIT);
  });
});

describe("likePattern", () => {
  it("wraps the term in wildcards", () => {
    expect(likePattern("wallet")).toBe("%wallet%");
  });

  /**
   * A shopper typing "100%" is searching for "100%", not for everything.
   * Unescaped, `%` and `_` are wildcards and the substring fallback would
   * return the whole catalogue with a straight face.
   */
  it("escapes LIKE metacharacters so they match themselves", () => {
    expect(likePattern("100%")).toBe("%100\\%%");
    expect(likePattern("a_b")).toBe("%a\\_b%");
    expect(likePattern("c:\\dir")).toBe("%c:\\\\dir%");
  });
});
