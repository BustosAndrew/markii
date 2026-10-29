import { describe, expect, it } from "vitest";
import { usdcUnits, x402SettlesCurrency } from "./x402";

/**
 * USDC is pegged to the dollar and `usdcUnits` reads an amount as US cents.
 * With no FX source, only a USD (or USDC) price can be settled honestly — a
 * €19.99 product would otherwise be charged 19.99 USDC, and ¥1,500 15 USDC.
 */
describe("x402SettlesCurrency", () => {
  it("settles USD and USDC prices", () => {
    expect(x402SettlesCurrency("USD")).toBe(true);
    expect(x402SettlesCurrency("usdc")).toBe(true);
    expect(usdcUnits(1999)).toBe(19_990_000n);
  });

  it("refuses every other currency rather than settle at a rate nobody chose", () => {
    for (const c of ["EUR", "GBP", "JPY", "KWD"]) expect(x402SettlesCurrency(c), c).toBe(false);
  });
});
