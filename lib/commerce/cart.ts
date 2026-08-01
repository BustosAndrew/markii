import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { badRequest, conflict, notFound } from "../api";
import { cartLines, carts, db, sites, type Cart, type Site } from "../db";
import { priceCart, productOnSite, unitPriceOf, type PricedCart } from "./pricing";
import { variants } from "../db";

/**
 * Cart service (§18.4).
 *
 * Every function here takes the **store** as well as the cart, and every lookup
 * is scoped by it. A cart token is a bearer credential with no session behind
 * it, so "the token is valid" is not the same question as "this cart belongs to
 * the store being asked" — and answering only the first would let one
 * storefront read and mutate another's carts.
 */

/** Carts live long enough to come back to tomorrow, not long enough to hoard stock. */
export const CART_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * 256 bits from a CSPRNG. This token is the shopper's only credential — it
 * protects an email address and a shipping address — so it is never derived
 * from the row id, a timestamp, or anything else enumerable.
 */
function newCartToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function loadStore(slug: string): Promise<Site> {
  const [site] = await db.select().from(sites).where(eq(sites.slug, slug)).limit(1);
  if (!site) throw notFound("Store");
  return site;
}

/** A store that is not accepting orders says so once, here. */
export function assertPurchasable(site: Site): void {
  if (site.status === "paused") throw conflict("This store is currently paused");
  if (!site.purchasesEnabled) throw conflict("Purchases are disabled on this store");
}

export async function createCart(site: Site): Promise<Cart> {
  const [cart] = await db
    .insert(carts)
    .values({
      token: newCartToken(),
      siteId: site.id,
      expiresAt: new Date(Date.now() + CART_TTL_MS),
    })
    .returning();
  return cart;
}

/** Loads an open cart by token, scoped to the store that asked for it. */
export async function loadCart(site: Site, token: string): Promise<Cart> {
  const [cart] = await db
    .select()
    .from(carts)
    .where(and(eq(carts.token, token), eq(carts.siteId, site.id)))
    .limit(1);
  if (!cart) throw notFound("Cart");
  if (cart.status === "converted") throw conflict("This cart has already been checked out");
  if (cart.expiresAt < new Date()) throw conflict("This cart has expired");
  return cart;
}

async function touch(cartId: number): Promise<Cart> {
  const [row] = await db
    .update(carts)
    .set({ updatedAt: new Date() })
    .where(eq(carts.id, cartId))
    .returning();
  return row;
}

/**
 * Adds an item, or raises the quantity if it is already in the cart.
 *
 * The currency is fixed by the first item and enforced for the rest. Refusing a
 * mixed-currency cart is the same judgement as leaving `usage_records.fx_rate`
 * null: there is no exchange rate available, and a quietly converted total
 * would be a made-up price.
 */
export async function addLine(
  site: Site,
  cart: Cart,
  input: { productId: number; variantId?: number | null; quantity: number; addOnIds?: number[] },
): Promise<Cart> {
  const product = await productOnSite(site.id, input.productId);
  if (!product) throw notFound("Product");
  if (!product.enabled) throw conflict(`"${product.name}" is not for sale`);

  let variant = null;
  if (input.variantId != null) {
    const [v] = await db
      .select()
      .from(variants)
      .where(and(eq(variants.id, input.variantId), eq(variants.productId, product.id)))
      .limit(1);
    if (!v) throw notFound("Variant");
    variant = v;
  }

  const existingLines = await db.select().from(cartLines).where(eq(cartLines.cartId, cart.id));
  if (existingLines.length === 0 && cart.currency !== product.currency) {
    await db
      .update(carts)
      .set({ currency: product.currency })
      .where(eq(carts.id, cart.id));
  } else if (existingLines.length > 0 && product.currency !== cart.currency) {
    throw badRequest(
      `This cart is in ${cart.currency}; "${product.name}" is priced in ${product.currency}. ` +
        `Start a separate cart — Markii will not convert between currencies at checkout.`,
    );
  }

  const unitPriceMinorAtAdd = unitPriceOf(product, variant);
  const match = existingLines.find(
    (l) => l.productId === product.id && l.variantId === (input.variantId ?? null),
  );

  if (match) {
    await db
      .update(cartLines)
      .set({ quantity: match.quantity + input.quantity, updatedAt: new Date() })
      .where(eq(cartLines.id, match.id));
  } else {
    await db.insert(cartLines).values({
      cartId: cart.id,
      productId: product.id,
      variantId: input.variantId ?? null,
      quantity: input.quantity,
      addOnIds: input.addOnIds ?? [],
      unitPriceMinorAtAdd,
    });
  }
  return touch(cart.id);
}

/** Sets a line's quantity; zero removes it. */
export async function setLineQuantity(
  cart: Cart,
  lineId: number,
  quantity: number,
): Promise<Cart> {
  const [line] = await db
    .select()
    .from(cartLines)
    .where(and(eq(cartLines.id, lineId), eq(cartLines.cartId, cart.id)))
    .limit(1);
  if (!line) throw notFound("Cart line");

  if (quantity <= 0) {
    await db.delete(cartLines).where(eq(cartLines.id, line.id));
  } else {
    await db
      .update(cartLines)
      .set({ quantity, updatedAt: new Date() })
      .where(eq(cartLines.id, line.id));
  }
  return touch(cart.id);
}

export async function setCartContact(
  cart: Cart,
  input: {
    email?: string | null;
    shippingAddress?: Cart["shippingAddress"];
    shippingRateId?: string | null;
  },
): Promise<Cart> {
  const patch: Partial<typeof carts.$inferInsert> = { updatedAt: new Date() };
  if (input.email !== undefined) patch.email = input.email?.toLowerCase() ?? null;
  if (input.shippingAddress !== undefined) patch.shippingAddress = input.shippingAddress;
  if (input.shippingRateId !== undefined) patch.shippingRateId = input.shippingRateId;

  const [row] = await db.update(carts).set(patch).where(eq(carts.id, cart.id)).returning();
  return row;
}

/**
 * The wire shape for a cart (§18.4).
 *
 * Money components carry their state alongside the number so a storefront
 * cannot render an uncalculated tax as "$0.00 tax". `totalState` is the one
 * field a checkout button must read: `provisional` means this is not yet an
 * amount anyone can be charged.
 */
export function serializeCart(cart: Cart, priced: PricedCart) {
  return {
    token: cart.token,
    storeId: cart.siteId,
    status: cart.status,
    customerId: cart.customerId,
    email: cart.email,
    discountCodes: cart.discountCodes,
    shippingAddress: cart.shippingAddress ?? null,
    shippingRateId: cart.shippingRateId,
    currency: priced.currency,
    lines: priced.lines,
    subtotalMinor: priced.subtotalMinor,
    discount: priced.discount,
    tax: priced.tax,
    shipping: priced.shipping,
    shippingRates: priced.shippingRates,
    shippingState: priced.shippingState,
    discounts: priced.discounts,
    rejectedCodes: priced.rejectedCodes,
    totalMinor: priced.totalMinor,
    totalState: priced.totalState,
    issues: priced.issues,
    expiresAt: cart.expiresAt.toISOString(),
    updatedAt: cart.updatedAt.toISOString(),
  };
}

/** Loads, prices, and serializes in one step — what every cart route returns. */
export async function cartResponse(cart: Cart) {
  const priced = await priceCart(cart);
  return serializeCart(cart, priced);
}
