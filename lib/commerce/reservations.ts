import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { conflict } from "../api";
import {
  cartLines,
  checkoutSessions,
  db,
  inventoryLedger,
  inventoryReservations,
  locations,
  products,
  variants,
} from "../db";

/**
 * Inventory reservation for in-flight checkouts (§18.4).
 *
 * `docs/BACKEND.md` §4 names the hazard exactly: "Concurrent checkout of the
 * last unit is a real race — solve it with a database transaction or
 * constraint, not an application-level read-then-write." So every decision here
 * is made inside one transaction, and the level is read **after** taking a row
 * lock on the variant. Two checkouts racing for one unit serialise on that lock;
 * the second sees the first's committed stock and is refused.
 *
 * Movements are still recorded in `inventory_ledger` — reserve appends
 * `+committedDelta`, release appends its inverse, and a completed sale converts
 * the hold into an actual `-availableDelta`. The ledger remains the answer to
 * "why is this number 3?"; `inventory_reservations` only tracks which session
 * holds what, so release and expiry are indexed lookups rather than a replay.
 */

/** How long stock is held for an unpaid checkout before the sweeper takes it back. */
export const RESERVATION_TTL_MS = 15 * 60 * 1000;

export type ReservationRequest = { variantId: number; quantity: number };

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Level for a variant read under the caller's lock. Committed stock is not available. */
async function lockedLevel(tx: Tx, variantId: number) {
  const [row] = await tx
    .select({
      available: sql<string>`coalesce(sum(${inventoryLedger.availableDelta}), 0)`,
      committed: sql<string>`coalesce(sum(${inventoryLedger.committedDelta}), 0)`,
    })
    .from(inventoryLedger)
    .where(eq(inventoryLedger.variantId, variantId));
  const available = Number(row?.available ?? 0);
  const committed = Number(row?.committed ?? 0);
  return { available, committed, ats: available - committed };
}

/**
 * The store's default stock location, or its first. Reservations need somewhere
 * to sit, so a variant-backed product on a store with no location cannot be
 * sold — which callers must discover *before* taking money, not after.
 */
export async function locationForVariant(variantId: number, tx: Tx | typeof db = db) {
  const [row] = await tx
    .select({ id: locations.id })
    .from(locations)
    .innerJoin(products, eq(products.siteId, locations.siteId))
    .innerJoin(variants, eq(variants.productId, products.id))
    .where(eq(variants.id, variantId))
    .orderBy(sql`${locations.isDefault} desc`, locations.id)
    .limit(1);
  return row?.id ?? null;
}

/**
 * Holds stock for a checkout session, or refuses the whole thing.
 *
 * **All or nothing.** A partial reservation would authorize a payment for items
 * the merchant cannot ship. Because it runs in one transaction, a refusal
 * leaves no holds behind.
 *
 * Variant-less products (everything predating §18.1) carry no ledger, so there
 * is nothing to reserve; they are checked against `products.stock` by the
 * pricing layer and decremented at completion. That gap is exactly why variants
 * are the direction of travel, and it is narrowed by migrating products, not by
 * inventing a ledger they never had.
 */
export async function reserveForSession(
  tx: Tx,
  sessionId: string,
  requests: ReservationRequest[],
  expiresAt: Date,
): Promise<void> {
  if (requests.length === 0) return;

  // Deterministic order across concurrent checkouts. Two sessions holding two
  // variants in opposite orders would deadlock; ascending id makes that
  // impossible rather than unlikely.
  const ordered = [...requests].sort((a, b) => a.variantId - b.variantId);

  for (const req of ordered) {
    /**
     * The lock, and the reason this is not a read-then-write. `FOR UPDATE` on
     * the variant row serialises every checkout touching it, so the level read
     * on the next line cannot be stale by the time the hold is written.
     */
    const [locked] = await tx
      .select({ id: variants.id, policy: variants.inventoryPolicy, title: variants.title })
      .from(variants)
      .where(eq(variants.id, req.variantId))
      .limit(1)
      .for("update");
    if (!locked) throw conflict(`Variant ${req.variantId} no longer exists`);

    const level = await lockedLevel(tx, req.variantId);
    // `continue` is a merchant's explicit choice to oversell, so it is honoured.
    if (locked.policy === "deny" && level.ats < req.quantity) {
      throw conflict(
        `Only ${Math.max(level.ats, 0)} left of "${locked.title}" — ${req.quantity} requested`,
      );
    }

    const locationId = await locationForVariant(req.variantId, tx);
    if (locationId == null) {
      throw conflict(`"${locked.title}" has no stock location configured`);
    }

    await tx.insert(inventoryReservations).values({
      checkoutSessionId: sessionId,
      variantId: req.variantId,
      locationId,
      quantity: req.quantity,
      expiresAt,
    });
    await tx.insert(inventoryLedger).values({
      variantId: req.variantId,
      locationId,
      committedDelta: req.quantity,
      reason: `reserved for checkout ${sessionId}`,
      actorType: "system",
    });
  }
}

/**
 * Gives held stock back — on expiry, failure, or abandonment.
 *
 * Idempotent by construction: only `held` rows are touched, and they are marked
 * in the same statement that reads them. A retried webhook cannot release twice
 * and hand the merchant free stock.
 */
export async function releaseForSession(tx: Tx, sessionId: string, reason: string): Promise<number> {
  const held = await tx
    .update(inventoryReservations)
    .set({ status: "released", resolvedAt: new Date() })
    .where(
      and(
        eq(inventoryReservations.checkoutSessionId, sessionId),
        eq(inventoryReservations.status, "held"),
      ),
    )
    .returning();

  for (const r of held) {
    await tx.insert(inventoryLedger).values({
      variantId: r.variantId,
      locationId: r.locationId,
      committedDelta: -r.quantity,
      reason: `released: ${reason}`,
      actorType: "system",
    });
  }
  return held.length;
}

/**
 * Turns a hold into a sale: the stock stops being reserved and actually leaves.
 *
 * One ledger row carries both halves — `-committed` and `-available` — so the
 * two can never be applied separately by a partial failure.
 */
export async function consumeForSession(tx: Tx, sessionId: string): Promise<number> {
  const held = await tx
    .update(inventoryReservations)
    .set({ status: "consumed", resolvedAt: new Date() })
    .where(
      and(
        eq(inventoryReservations.checkoutSessionId, sessionId),
        eq(inventoryReservations.status, "held"),
      ),
    )
    .returning();

  for (const r of held) {
    await tx.insert(inventoryLedger).values({
      variantId: r.variantId,
      locationId: r.locationId,
      availableDelta: -r.quantity,
      committedDelta: -r.quantity,
      reason: `sold via checkout ${sessionId}`,
      actorType: "system",
    });
  }
  return held.length;
}

/**
 * What a cart needs to reserve. Only lines with a variant appear — see
 * {@link reserveForSession} on why variant-less products are handled elsewhere.
 */
export async function reservationsForCart(cartId: number): Promise<ReservationRequest[]> {
  const rows = await db
    .select({ variantId: cartLines.variantId, quantity: cartLines.quantity })
    .from(cartLines)
    .where(eq(cartLines.cartId, cartId));

  const merged = new Map<number, number>();
  for (const r of rows) {
    if (r.variantId == null) continue;
    merged.set(r.variantId, (merged.get(r.variantId) ?? 0) + r.quantity);
  }
  return [...merged].map(([variantId, quantity]) => ({ variantId, quantity }));
}

/**
 * Releases stock held by checkouts that were never completed.
 *
 * Called opportunistically before a reservation attempt rather than only from a
 * cron: without it, a store that abandons carts faster than a scheduled sweep
 * runs will refuse sales for stock nobody is buying. Cheap because the sweep
 * index is `(status, expires_at)`.
 */
export async function sweepExpiredReservations(now = new Date()): Promise<number> {
  const stale = await db
    .select({ id: inventoryReservations.checkoutSessionId })
    .from(inventoryReservations)
    .where(
      and(
        eq(inventoryReservations.status, "held"),
        lt(inventoryReservations.expiresAt, now),
      ),
    )
    .limit(100);
  if (stale.length === 0) return 0;

  const sessionIds = [...new Set(stale.map((s) => s.id))];
  return db.transaction(async (tx) => {
    let released = 0;
    for (const id of sessionIds) released += await releaseForSession(tx, id, "checkout expired");
    await tx
      .update(checkoutSessions)
      .set({ status: "expired" })
      .where(
        and(
          inArray(checkoutSessions.id, sessionIds),
          inArray(checkoutSessions.status, ["requires_payment", "processing"]),
        ),
      );
    return released;
  });
}
