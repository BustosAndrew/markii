import "server-only";

import { and, asc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { carts, cartLines, db, products, sites, variants } from "../db";
import { storefrontUrl } from "../queries";
import { sendMerchantMail } from "./index";
import { abandonedCart, type AbandonedCartItem } from "./templates";

/**
 * Abandoned-cart recovery (§24, D27 — "abandoned cart ships free").
 *
 * The engine is trivial; the **selection rules** are the feature, and each one
 * exists to stop a specific way this becomes spam.
 */

/**
 * Long enough that a shopper who wandered off mid-purchase has genuinely
 * stopped, rather than gone to find their card. Mailing someone who is still on
 * the page is the fastest way to make a store look broken.
 */
export const QUIET_FOR_MS = 60 * 60_000;

/**
 * And not older than this. A day-late reminder is unwelcome, but the real reason
 * for a ceiling is the **first run**: without it, switching the feature on would
 * mail every abandoned cart in the table's history at once — the single worst
 * thing that can happen to a sending domain.
 */
export const STALE_AFTER_MS = 24 * 60 * 60_000;

/** Bounded per run so one enormous store cannot starve the rest of the sweep. */
const BATCH = 200;

export type SweepResult = {
  considered: number;
  sent: number;
  skipped: number;
  failed: number;
  problems: string[];
};

type Candidate = {
  cartId: number;
  token: string;
  email: string;
  currency: string;
  siteId: number;
};

/**
 * Carts that have gone quiet and can still be recovered.
 *
 * Every clause is load-bearing:
 * - **the site opted in** — this mail leaves from the merchant's domain;
 * - **`status = 'open'`** — a converted cart was bought, not abandoned;
 * - **an address** — obvious, but it is also the shopper's only act of consent;
 * - **never mailed** — one per cart, ever;
 * - **inside the window** — see the two constants above;
 * - **not expired** — the link in the mail *is* the cart, and a link that
 *   restores nothing is worse than no email at all.
 */
async function candidates(now: Date): Promise<Candidate[]> {
  return db
    .select({
      cartId: carts.id,
      token: carts.token,
      email: carts.email,
      currency: carts.currency,
      siteId: carts.siteId,
    })
    .from(carts)
    .innerJoin(sites, eq(sites.id, carts.siteId))
    .where(
      and(
        eq(sites.abandonedCartEmails, true),
        eq(carts.status, "open"),
        sql`${carts.email} is not null`,
        isNull(carts.abandonedMailSentAt),
        lt(carts.updatedAt, new Date(now.getTime() - QUIET_FOR_MS)),
        gt(carts.updatedAt, new Date(now.getTime() - STALE_AFTER_MS)),
        gt(carts.expiresAt, now),
      ),
    )
    .orderBy(asc(carts.updatedAt))
    .limit(BATCH) as Promise<Candidate[]>;
}

/**
 * Sends one reminder per abandoned cart.
 *
 * **Claims the cart before sending, not after.** The marker is written first so
 * a crash mid-send costs one missed email rather than a duplicate on the next
 * hourly pass — and the claim is conditional (`is null`), so two overlapping
 * runs cannot both take the same cart. Losing a reminder is a small failure;
 * mailing the same person hourly is how a domain gets blocked.
 */
export async function sweepAbandonedCarts(now: Date = new Date()): Promise<SweepResult> {
  const result: SweepResult = { considered: 0, sent: 0, skipped: 0, failed: 0, problems: [] };
  const found = await candidates(now);
  result.considered = found.length;

  for (const c of found) {
    try {
      const lines = await db
        .select({
          quantity: cartLines.quantity,
          unitPriceMinor: cartLines.unitPriceMinorAtAdd,
          productName: products.name,
          variantName: variants.title,
        })
        .from(cartLines)
        .innerJoin(products, eq(products.id, cartLines.productId))
        .leftJoin(variants, eq(variants.id, cartLines.variantId))
        .where(eq(cartLines.cartId, c.cartId));

      /**
       * An empty cart is not an abandoned one. It happens — a shopper adds an
       * item, enters their address, then removes it — and "you left something
       * behind" listing nothing would be absurd.
       */
      if (lines.length === 0) {
        result.skipped++;
        continue;
      }

      const [site] = await db.select().from(sites).where(eq(sites.id, c.siteId)).limit(1);
      if (!site) {
        result.skipped++;
        continue;
      }

      const claimed = await db
        .update(carts)
        .set({ abandonedMailSentAt: now, status: "abandoned" })
        .where(and(eq(carts.id, c.cartId), isNull(carts.abandonedMailSentAt)))
        .returning({ id: carts.id });
      if (claimed.length === 0) {
        // Another run took it between the select and here.
        result.skipped++;
        continue;
      }

      const items: AbandonedCartItem[] = lines.map((l) => ({
        name: l.variantName ? `${l.productName} — ${l.variantName}` : l.productName,
        quantity: l.quantity,
        unitPriceMinor: l.unitPriceMinor,
      }));
      const subtotalMinor = items.reduce((sum, i) => sum + i.unitPriceMinor * i.quantity, 0);

      const email = abandonedCart({
        storeName: site.name,
        items,
        subtotalMinor,
        currency: c.currency,
        /**
         * The token restores the cart, so this link is a bearer credential for
         * it — the same shape as a digital-delivery grant. It goes only to the
         * address the shopper typed into that cart.
         */
        recoverUrl: `${storefrontUrl(site)}/cart?recover=${encodeURIComponent(c.token)}`,
        supportEmail: null,
      });

      const sent = await sendMerchantMail(site.orgId, {
        to: c.email,
        subject: email.subject,
        html: email.html,
        text: email.text,
        template: "abandoned_cart",
        siteId: site.id,
      });

      if (sent.sent) {
        result.sent++;
      } else {
        /**
         * Counted as failed but **not un-claimed**. A refusal is usually
         * suppression — the address already bounced or complained — and
         * retrying next hour would be precisely the wrong response to it.
         */
        result.failed++;
        result.problems.push(`cart ${c.cartId}: ${sent.reason ?? "send refused"}`);
      }
    } catch (e) {
      result.failed++;
      result.problems.push(`cart ${c.cartId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}
