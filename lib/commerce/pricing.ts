import { and, eq, inArray, sql } from "drizzle-orm";
import {
  cartLines,
  db,
  inventoryLedger,
  products,
  variants,
  type Cart,
  type CheckoutLineSnapshot,
  type Product,
  type Variant,
} from "../db";
import { allocate } from "./allocation";
import { evaluateDiscounts, type DiscountEvaluation } from "./discounts";
import { selectedRate, type QuotedRate, type ShippingQuote } from "./shipping";
import { calculateTax, type TaxableLine } from "./tax";

/**
 * Server-side cart pricing (§18.4).
 *
 * **This module is the only place a cart total is produced.** `docs/BACKEND.md`
 * §4 makes it non-negotiable: prices, discounts, tax, and totals are recomputed
 * server-side and a client-supplied amount is never trusted. Nothing here reads
 * a request body — every input comes from the catalog.
 *
 * The second rule it enforces is the no-fabrication one. Discounts (§18.5) and
 * tax and shipping (§18.6) are not built. A zero in those fields would read as
 * "no tax is due", which is a claim this code cannot make, so each carries an
 * explicit {@link ComponentState} and the caller must surface it. A total that
 * omits an uncalculated component is `provisional`, never `final`.
 */

/**
 * Stripe's product tax code for goods that are not taxed.
 *
 * Named rather than inlined because it is the one tax code this codebase ever
 * chooses on a merchant's behalf, and it is chosen only to carry a decision the
 * merchant already made (`variants.taxable: false`) into the vocabulary Stripe
 * understands. Every other code comes from the variant or the store's default.
 */
const STRIPE_NON_TAXABLE_CODE = "txcd_00000000";

/** Why a money component is what it is. Callers must render this, not just the number. */
export type ComponentState =
  /** Calculated from real configuration. */
  | "calculated"
  /** Genuinely zero — nothing to charge. */
  | "none"
  /** The engine that would produce this has not been built or configured yet. */
  | "not_configured";

export type MoneyComponent = { amountMinor: number; state: ComponentState; note?: string };

/** Something the shopper has to be told about a line before they pay. */
export type LineIssue =
  | { code: "price_changed"; wasMinor: number; nowMinor: number }
  | { code: "unavailable"; reason: string }
  | { code: "insufficient_stock"; available: number; requested: number };

export type PricedLine = {
  id: number;
  productId: number;
  variantId: number | null;
  title: string;
  /** Kept apart from `title` so the order snapshot can show them separately (§18.7). */
  variantTitle: string | null;
  sku: string | null;
  quantity: number;
  unitPriceMinor: number;
  addOns: { productId: number; name: string; unitPriceMinor: number; mandatory: boolean }[];
  /** `(unit + add-ons) × quantity`. */
  lineTotalMinor: number;
  currency: string;
  issues: LineIssue[];
};

export type PricedCart = {
  currency: string;
  lines: PricedLine[];
  subtotalMinor: number;
  discount: MoneyComponent;
  tax: MoneyComponent;
  shipping: MoneyComponent;
  /** Rates the shopper may pick from, so the cart and the rate list never disagree. */
  shippingRates: QuotedRate[];
  shippingState: ShippingQuote["state"];
  /** What applied and, crucially, what did not and why (§18.5). */
  discounts: DiscountEvaluation["applied"];
  rejectedCodes: DiscountEvaluation["rejected"];
  totalMinor: number;
  /**
   * `final` only when every component is `calculated` or `none`. A provisional
   * total must never be presented to a shopper as the amount they will pay.
   */
  totalState: "final" | "provisional";
  /**
   * Stripe's `taxcalc_…` when Stripe Tax produced `tax`, else null (§18.6).
   *
   * Frozen onto the checkout session, and from there turned into the merchant's
   * Stripe Tax transaction once the payment succeeds. It travels with the quote
   * because the cart's own cached calculation moves the moment the shopper edits
   * their basket, and a transaction created from the wrong one files tax against
   * an order that was never placed.
   */
  taxCalculationId: string | null;
  /** Blocking problems — a cart with any of these cannot open a checkout. */
  issues: LineIssue[];
};

/**
 * Available-to-sell for a variant: on hand, minus what in-flight checkouts hold.
 *
 * Read-only and unlocked — fine for displaying a cart, **not** for deciding
 * whether a sale may proceed. That decision reads under a row lock inside a
 * transaction; see `lib/commerce/reservations.ts`.
 */
export async function availableToSell(variantId: number): Promise<number> {
  const [row] = await db
    .select({
      available: sql<string>`coalesce(sum(${inventoryLedger.availableDelta}), 0)`,
      committed: sql<string>`coalesce(sum(${inventoryLedger.committedDelta}), 0)`,
    })
    .from(inventoryLedger)
    .where(eq(inventoryLedger.variantId, variantId));
  return Number(row?.available ?? 0) - Number(row?.committed ?? 0);
}

/**
 * What one unit of a line costs right now.
 *
 * Variant price wins when there is a variant; otherwise the product's own price.
 * That fallback exists in exactly one function so it cannot drift between the
 * cart, the checkout quote, and the order — three places that disagreeing about
 * price is how a shopper gets charged something they were never shown.
 */
export function unitPriceOf(product: Product, variant: Variant | null): number {
  return variant ? variant.priceMinor : product.priceCents;
}

/**
 * Prices a cart from the current catalog.
 *
 * Stock is checked but **not reserved** — reservation happens at payment
 * authorization (`lib/commerce/reservations.ts`), not while browsing. Holding
 * stock for every open cart would let anyone empty a store without paying.
 */
export async function priceCart(cart: Cart): Promise<PricedCart> {
  const rows = await db.select().from(cartLines).where(eq(cartLines.cartId, cart.id));

  const productIds = new Set<number>();
  for (const l of rows) {
    productIds.add(l.productId);
    for (const id of l.addOnIds) productIds.add(id);
  }
  const prods = productIds.size
    ? await db.select().from(products).where(inArray(products.id, [...productIds]))
    : [];
  const variantIds = rows.map((l) => l.variantId).filter((v): v is number => v != null);
  const vars = variantIds.length
    ? await db.select().from(variants).where(inArray(variants.id, variantIds))
    : [];

  const byProduct = new Map(prods.map((p) => [p.id, p]));
  const byVariant = new Map(vars.map((v) => [v.id, v]));

  const priced: PricedLine[] = [];
  for (const line of rows) {
    const product = byProduct.get(line.productId);
    const variant = line.variantId != null ? byVariant.get(line.variantId) : null;
    const issues: LineIssue[] = [];

    if (!product || !product.enabled) {
      // The line stays visible at zero rather than vanishing: an item silently
      // disappearing from a cart is worse than one marked unavailable.
      priced.push({
        id: line.id,
        productId: line.productId,
        variantId: line.variantId,
        title: product?.name ?? "Unavailable item",
        variantTitle: null,
        sku: product?.sku ?? null,
        quantity: line.quantity,
        unitPriceMinor: 0,
        addOns: [],
        lineTotalMinor: 0,
        currency: cart.currency,
        issues: [{ code: "unavailable", reason: product ? "no longer for sale" : "removed" }],
      });
      continue;
    }
    if (line.variantId != null && !variant) {
      priced.push({
        id: line.id,
        productId: line.productId,
        variantId: line.variantId,
        title: product.name,
        variantTitle: null,
        sku: product.sku,
        quantity: line.quantity,
        unitPriceMinor: 0,
        addOns: [],
        lineTotalMinor: 0,
        currency: cart.currency,
        issues: [{ code: "unavailable", reason: "this option is no longer offered" }],
      });
      continue;
    }

    const unitPriceMinor = unitPriceOf(product, variant ?? null);
    if (unitPriceMinor !== line.unitPriceMinorAtAdd) {
      issues.push({
        code: "price_changed",
        wasMinor: line.unitPriceMinorAtAdd,
        nowMinor: unitPriceMinor,
      });
    }

    // Mandatory add-ons are part of the item, whether or not the client asked
    // for them. Leaving one out would quote a price that cannot be fulfilled.
    const chosen = new Set(line.addOnIds);
    for (const a of product.addOns) if (a.mandatory) chosen.add(a.productId);
    const addOns = [...chosen]
      .map((id) => {
        const spec = product.addOns.find((a) => a.productId === id);
        const p = byProduct.get(id);
        if (!spec || !p || !p.enabled) return null;
        return {
          productId: id,
          name: p.name,
          unitPriceMinor: p.priceCents,
          mandatory: spec.mandatory,
        };
      })
      .filter((a): a is NonNullable<typeof a> => a !== null);

    const perUnit = unitPriceMinor + addOns.reduce((s, a) => s + a.unitPriceMinor, 0);

    const stock = variant ? await availableToSell(variant.id) : product.stock;
    const policy = variant?.inventoryPolicy ?? "deny";
    if (policy === "deny" && stock < line.quantity) {
      issues.push({ code: "insufficient_stock", available: stock, requested: line.quantity });
    }

    priced.push({
      id: line.id,
      productId: line.productId,
      variantId: line.variantId,
      title: variant ? `${product.name} — ${variant.title}` : product.name,
      variantTitle: variant?.title ?? null,
      sku: variant?.sku ?? product.sku,
      quantity: line.quantity,
      unitPriceMinor,
      addOns,
      lineTotalMinor: perUnit * line.quantity,
      currency: product.currency,
      issues,
    });
  }

  const subtotalMinor = priced.reduce((s, l) => s + l.lineTotalMinor, 0);

  /**
   * §18.5. Codes on the cart plus any automatic discounts, evaluated against the
   * catalog. A rejected code carries **why** — an expired code, a below-minimum
   * cart, and a typo are three different problems and only one is the shopper's
   * fault.
   */
  const evaluation = await evaluateDiscounts({
    siteId: cart.siteId,
    codes: cart.discountCodes,
    lines: priced.map((l) => ({ productId: l.productId, lineTotalMinor: l.lineTotalMinor })),
    subtotalMinor,
    customerId: cart.customerId,
  });

  const discount: MoneyComponent =
    evaluation.applied.length > 0
      ? {
          amountMinor: evaluation.totalDiscountMinor,
          state: "calculated",
          note: evaluation.applied.map((a) => a.code ?? a.title).join(", "),
        }
      : { amountMinor: 0, state: "none" };

  /**
   * §18.6. Shipping is quoted from the merchant's own zones and rates. Each
   * unquotable case keeps its own state and reason — "no zones configured", "we
   * do not ship there", and "nothing here needs shipping" are three different
   * situations, and only the last one is genuinely free.
   */
  const { rate, quote } = await selectedRate({
    siteId: cart.siteId,
    cartId: cart.id,
    address: cart.shippingAddress ?? null,
    subtotalMinor,
    shippingRateId: cart.shippingRateId,
  });

  let shipping: MoneyComponent;
  if (quote.state === "not_required") {
    shipping = { amountMinor: 0, state: "none", note: "Nothing in this cart requires shipping." };
  } else if (rate) {
    /**
     * A `free_shipping` discount zeroes the rate rather than removing it: the
     * shopper still picks a service, and the merchant's records still show which
     * one was used and what it would have cost.
     */
    shipping = evaluation.freeShipping
      ? {
          amountMinor: 0,
          state: "calculated",
          note: `${rate.name} (${rate.zoneName}) — free shipping applied`,
        }
      : {
          amountMinor: rate.priceMinor,
          state: "calculated",
          note: `${rate.name} (${rate.zoneName})`,
        };
  } else if (quote.state === "quoted") {
    // Rates exist and the shopper simply has not picked one yet. Not a
    // misconfiguration — but not a chargeable total either.
    shipping = {
      amountMinor: 0,
      state: "not_configured",
      note: `Select a shipping rate: ${quote.rates.map((r) => r.name).join(", ")}.`,
    };
  } else {
    shipping = { amountMinor: 0, state: "not_configured", note: quote.reason };
  }

  /**
   * §18.6. Tax comes from the store's own settings. A store that has configured
   * nothing gets `none` with its listed prices treated as tax-inclusive — the
   * D33 default, now an explicit setting rather than a hardcoded assumption.
   *
   * Shipping is included in the taxable base only when tax is actually being
   * added; most jurisdictions tax delivery charges, and leaving it out would
   * under-collect on every shipped order.
   *
   * **Stripe Tax needs the lines, not the base.** Whether a jurisdiction taxes
   * delivery, and at what rate a given kind of good is taxed, are decisions
   * Stripe makes per line — so the taxable base a manual rate multiplies is
   * exactly the information Stripe cannot work from. Both are passed; the
   * provider decides which it reads.
   *
   * **The lines go over net of discount**, apportioned with the same
   * largest-remainder allocation an order's lines get at completion (§18.7).
   * Tax is charged on what the shopper actually pays, so quoting list prices
   * would over-collect on every discounted order — and reusing `allocate` is
   * what keeps the tax base and the order's own line allocations from
   * disagreeing by a penny.
   */
  const discountShares = allocate(
    discount.amountMinor,
    priced.map((l) => l.lineTotalMinor),
  );

  /**
   * `variants.taxable: false` is the merchant's own statement that a variant is
   * not taxed, so it is sent as Stripe's non-taxable product code rather than
   * dropped from the calculation — a line Stripe never sees is also a line
   * missing from the transaction that backs the merchant's filing.
   *
   * The manual path has no equivalent: one rate over one base has nowhere to
   * express a per-line exemption, and it has never honoured this flag. That
   * asymmetry is real and documented in `docs/API.md` §18.6 rather than papered
   * over here.
   */
  const taxableLines: TaxableLine[] = priced.map((l, i) => {
    const variant = l.variantId != null ? byVariant.get(l.variantId) : null;
    return {
      reference: `line:${l.id}`,
      amountMinor: l.lineTotalMinor - discountShares[i],
      quantity: l.quantity,
      taxCode: variant && !variant.taxable ? STRIPE_NON_TAXABLE_CODE : (variant?.taxCode ?? null),
    };
  });

  const taxResult = await calculateTax({
    siteId: cart.siteId,
    cartId: cart.id,
    address: cart.shippingAddress ?? null,
    taxableBaseMinor: subtotalMinor - discount.amountMinor + shipping.amountMinor,
    lines: taxableLines,
    shippingMinor: shipping.amountMinor,
    currency: cart.currency,
  });
  const tax: MoneyComponent = {
    amountMinor: taxResult.amountMinor,
    state: taxResult.state,
    note: taxResult.note,
  };

  /**
   * `totalState` answers one question: **is this an amount someone can safely be
   * charged?** It is not a summary of whether every component computed.
   *
   * An unapplied discount does not make it unsafe. The shopper pays the list
   * price — the correct price for the goods — and has been told plainly that
   * their code did nothing. Blocking checkout there would refuse a valid sale
   * over a code the store never offered, which is how a shopper who typed a
   * guess gets locked out of buying.
   *
   * An uncalculated shipping cost is different in kind. The cost is real and
   * someone pays it; charging zero means the merchant does, silently, without
   * agreeing to it. That is the case worth refusing over.
   *
   * Tax joins it once a store has opted in. A merchant who selected a tax
   * provider is telling us they collect tax; completing a sale without it
   * leaves them owing money they never charged. A store on `provider: "none"`
   * returns `none`, not `not_configured`, and is unaffected.
   */
  const totalState =
    shipping.state === "not_configured" || tax.state === "not_configured"
      ? "provisional"
      : "final";

  return {
    currency: cart.currency,
    lines: priced,
    subtotalMinor,
    discount,
    tax,
    shipping,
    shippingRates: quote.state === "quoted" ? quote.rates : [],
    shippingState: quote.state,
    discounts: evaluation.applied,
    rejectedCodes: evaluation.rejected,
    totalMinor:
      subtotalMinor - discount.amountMinor + tax.amountMinor + shipping.amountMinor,
    totalState,
    taxCalculationId: taxResult.calculationId ?? null,
    issues: priced.flatMap((l) => l.issues.filter((i) => i.code !== "price_changed")),
  };
}

/**
 * Freezes a priced cart's lines onto a checkout session (§18.7).
 *
 * Only the fields an order needs, and only the ones that must not move: the
 * catalog is free to change after this, and what the shopper bought is not.
 * `subtotalMinor` here sums to the session's own `subtotalMinor` by
 * construction — both come from the same `PricedCart`.
 */
export function snapshotLines(priced: PricedCart): CheckoutLineSnapshot[] {
  return priced.lines.map((l) => ({
    productId: l.productId,
    variantId: l.variantId,
    title: l.title,
    variantTitle: l.variantTitle,
    sku: l.sku,
    quantity: l.quantity,
    unitPriceMinor: l.unitPriceMinor,
    subtotalMinor: l.lineTotalMinor,
    addOns: l.addOns.map((a) => ({
      productId: a.productId,
      name: a.name,
      unitPriceMinor: a.unitPriceMinor,
    })),
  }));
}

/**
 * The currency a product sells in, used to fix a cart's currency on first add.
 * Mixed-currency carts are refused rather than converted — see `usage_records`
 * for the same reasoning about inventing an FX rate.
 */
export async function productCurrency(productId: number): Promise<string | null> {
  const [row] = await db
    .select({ currency: products.currency })
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);
  return row?.currency ?? null;
}

/** A product on a given store, or null. Cart writes must never cross stores. */
export async function productOnSite(siteId: number, productId: number) {
  const [row] = await db
    .select()
    .from(products)
    .where(and(eq(products.id, productId), eq(products.siteId, siteId)))
    .limit(1);
  return row ?? null;
}
