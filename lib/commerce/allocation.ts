/**
 * Apportioning an order-level amount across lines (§18.7).
 *
 * Discounts apply to an order or a set of products; tax applies to a base.
 * Neither has a natural per-line value — but a refund does. "Refund two of the
 * three mugs" has to know what share of the £10-off code and the VAT belonged
 * to those two units, and there is no such number until one is chosen.
 *
 * So these are **allocations**, and the property that makes them safe is that
 * they sum **exactly** to the amount they divide. An allocation that loses a
 * penny to rounding is a refund that returns the wrong money, and refunding
 * every line of an order would then not add up to the order.
 *
 * Integer minor units throughout; no float arithmetic anywhere (D31).
 */

/**
 * Splits `amountMinor` across `weights` in proportion, losing nothing.
 *
 * Largest-remainder apportionment: floor each share, then hand the leftover
 * units to the lines with the largest fractional remainders. Ties break toward
 * the larger weight and then the lower index, so the same inputs always produce
 * the same split — a refund recomputed during a dispute must not disagree with
 * the one that was issued.
 *
 * `amountMinor` must be non-negative; weights must be non-negative.
 *
 * When every weight is zero there is no proportion to respect — a fully
 * discounted order with tax on shipping, say. The amount is then spread as
 * evenly as it divides, remainder to the earliest lines, rather than dropped:
 * money that vanishes here reappears as an order whose lines do not sum to it.
 */
export function allocate(amountMinor: number, weights: number[]): number[] {
  if (!Number.isInteger(amountMinor) || amountMinor < 0) {
    throw new Error(`allocate: amountMinor must be a non-negative integer, got ${amountMinor}`);
  }
  if (weights.some((w) => !Number.isInteger(w) || w < 0)) {
    throw new Error("allocate: weights must be non-negative integers");
  }
  if (weights.length === 0) {
    if (amountMinor !== 0) throw new Error("allocate: cannot split a non-zero amount across zero lines");
    return [];
  }
  if (amountMinor === 0) return weights.map(() => 0);

  const total = weights.reduce((s, w) => s + w, 0);

  if (total === 0) {
    const base = Math.floor(amountMinor / weights.length);
    const shares = weights.map(() => base);
    for (let i = 0; i < amountMinor - base * weights.length; i++) shares[i] += 1;
    return shares;
  }

  // Remainders compared as integers (`amount × weight mod total`) rather than as
  // fractions, so no float ever decides who gets the extra penny.
  const shares = weights.map((w) => Math.floor((amountMinor * w) / total));
  const remainders = weights.map((w) => (amountMinor * w) % total);
  let leftover = amountMinor - shares.reduce((s, n) => s + n, 0);

  const order = weights
    .map((w, i) => ({ i, w, r: remainders[i] }))
    .sort((a, b) => b.r - a.r || b.w - a.w || a.i - b.i);

  for (let k = 0; leftover > 0; k = (k + 1) % order.length) {
    shares[order[k].i] += 1;
    leftover -= 1;
  }
  return shares;
}

/**
 * The share of a line's allocated amount owed to the units this refund takes.
 *
 * Used when a partial refund takes 2 of 3 units: the line's tax and discount
 * were allocated to the line as a whole, so a slice of them has to be found.
 *
 * It takes `alreadyRefunded` rather than just the units in hand, and that is
 * the whole point. Slicing each refund independently and rounding down strands
 * money: a tax of 10 across 3 units refunded 2-then-1 pays 6 + 3 = 9, and the
 * last penny is never returned to anyone. Computing the cumulative share and
 * subtracting what was already paid makes the final refund pick up the residue,
 * so refunding every unit of a line — in any number of steps, in any order —
 * always returns exactly the line's amount.
 */
export function shareOfUnits(
  lineAmountMinor: number,
  alreadyRefunded: number,
  units: number,
  lineQuantity: number,
): number {
  if (lineQuantity <= 0) return 0;
  const cumulative = Math.min(alreadyRefunded + units, lineQuantity);
  const before = Math.floor((lineAmountMinor * Math.min(alreadyRefunded, lineQuantity)) / lineQuantity);
  const after = Math.floor((lineAmountMinor * cumulative) / lineQuantity);
  return after - before;
}
