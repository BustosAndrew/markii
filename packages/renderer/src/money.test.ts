import { describe, expect, it } from "vitest";
import { currencyExponent, decimalMinor, formatCents, parseDecimalToMinor } from "./money";

/**
 * `decimalMinor` is what writes money into a CSV a merchant hands their
 * accountant, so its failure mode is a wrong number in someone's books rather
 * than a wrong pixel. Two things are being pinned: the exponent comes from the
 * currency (D31), and the scaling never goes through a float.
 */
describe("decimalMinor", () => {
  it("scales by the currency's own exponent", () => {
    expect(decimalMinor(152300, "USD")).toBe("1523.00");
    expect(decimalMinor(152300, "USDC")).toBe("1523.00");
    // JPY and KRW have no minor unit — dividing by 100 would inflate a ¥1,523
    // order into ¥152,300 in whatever the merchant imports this into.
    expect(currencyExponent("JPY")).toBe(0);
    expect(decimalMinor(152300, "JPY")).toBe("152300");
    expect(decimalMinor(152300, "KRW")).toBe("152300");
  });

  it("pads amounts smaller than one major unit", () => {
    expect(decimalMinor(0, "USD")).toBe("0.00");
    expect(decimalMinor(5, "USD")).toBe("0.05");
    expect(decimalMinor(50, "USD")).toBe("0.50");
    expect(decimalMinor(0, "JPY")).toBe("0");
  });

  it("keeps the sign on a negative amount", () => {
    expect(decimalMinor(-5, "USD")).toBe("-0.05");
    expect(decimalMinor(-152300, "USD")).toBe("-1523.00");
    expect(decimalMinor(-7, "JPY")).toBe("-7");
  });

  it("is exact where float division is not", () => {
    // 820 / 100 is 8.200000000000001 in binary floating point; string scaling
    // has no such case, which is why the money rule forbids the division.
    expect(decimalMinor(820, "USD")).toBe("8.20");
    expect(decimalMinor(1_000_000_07, "USD")).toBe("1000000.07");
    expect(decimalMinor(999_999_999, "USD")).toBe("9999999.99");
  });

  it("emits no symbol or grouping separator", () => {
    // A `$` is not a digit and a `,` is a column break — this string goes into a
    // comma-separated file, not onto a screen.
    for (const currency of ["USD", "USDC", "JPY", "EUR"]) {
      expect(decimalMinor(1_234_567, currency)).not.toMatch(/[^\d.-]/);
    }
  });

  it("falls back to two places for a currency it cannot resolve", () => {
    expect(decimalMinor(150, "XYZ")).toBe("1.50");
  });
});

/**
 * The D49 bug, pinned from both ends: `*Cents` fields are the currency's own
 * minor unit — that is how checkout charges them — so display must divide by
 * the currency's exponent too. It divided by 100 for every currency, and a
 * ¥1,500 product read ¥15 while charging ¥1,500.
 */
describe("formatCents", () => {
  it("shows a price in the currency's own decimals", () => {
    expect(formatCents(1500, "JPY")).toBe("¥1,500");
    expect(formatCents(1999, "USD")).toBe("$19.99");
    expect(formatCents(5125, "KWD")).toMatch(/5\.125/);
  });

  it("still labels USDC amounts as USDC", () => {
    expect(formatCents(1234, "USDC")).toBe("12.34 USDC");
  });
});

describe("parseDecimalToMinor", () => {
  it("reads a typed price into the currency's own minor unit", () => {
    expect(parseDecimalToMinor("19.99", "USD")).toBe(1999);
    expect(parseDecimalToMinor("19.9", "USD")).toBe(1990);
    expect(parseDecimalToMinor("1500", "JPY")).toBe(1500);
    expect(parseDecimalToMinor("5.125", "KWD")).toBe(5125);
  });

  /** Rounding a price is the merchant's call; a form refuses instead. */
  it("refuses more decimals than the currency has, and anything not a plain amount", () => {
    for (const [value, currency] of [
      ["19.999", "USD"],
      ["1500.5", "JPY"],
      ["-1", "USD"],
      ["1e3", "USD"],
      ["$5", "USD"],
      ["", "USD"],
    ]) {
      expect(parseDecimalToMinor(value, currency), `${value} ${currency}`).toBeNull();
    }
  });

  it("round-trips with decimalMinor", () => {
    for (const [minor, currency] of [
      [1999, "USD"],
      [1500, "JPY"],
      [5125, "KWD"],
      [0, "USD"],
    ] as const) {
      expect(parseDecimalToMinor(decimalMinor(minor, currency), currency)).toBe(minor);
    }
  });
});
