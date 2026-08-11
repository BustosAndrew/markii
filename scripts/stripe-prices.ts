/**
 * Creates the Stripe Products and Prices that subscription billing needs (§17).
 *
 * Run: `pnpm stripe:prices`        (report what exists and what is missing)
 *      `pnpm stripe:prices --apply` (create the missing ones)
 *
 * **Why a script rather than six dashboard clicks.** The amounts are derived
 * from `lib/plans.ts` through the *same* `price-catalog` module `resolvePrice`
 * verifies against, so a Price this creates cannot be one the app then refuses.
 * Typing them by hand invites exactly one mistake — `markii_starter_year` at
 * `1500` instead of `18000`, because `docs/PRICING.md` quotes annual plans per
 * *month* — and that mistake underbills by a factor of twelve while looking
 * entirely reasonable in the Stripe dashboard.
 *
 * **Refuses a live account unless asked twice.** The numbers were signed off on
 * 2026-08-10, so `--allow-live` is now a legitimate thing to pass — but the
 * guard stays, because creating a live Price is a different act from creating a
 * test one. A test Price archives freely; a live Price is what real merchants
 * are charged against, and a mistake there is a refund conversation. The flag
 * exists so that step is deliberate rather than a consequence of which key
 * happened to be in `.env.local`.
 *
 * Idempotent, and re-running is the normal way to verify: an existing Price with
 * the right amount and interval is reported and left alone. One that disagrees
 * is **reported, never edited** — Stripe amounts are immutable, so fixing it
 * means archiving and re-creating, which is a decision about money that should
 * not happen as a side effect of running a script.
 */
import { PLAN_IDS, type PlanId } from "../lib/db/schema";
import {
  expectedUnitAmountMinor,
  priceLookupKey,
  productIdFor,
  type BillingInterval,
} from "../lib/billing/price-catalog";

const API = "https://api.stripe.com/v1";
const API_VERSION = "2025-03-31.basil";
const INTERVALS: BillingInterval[] = ["month", "year"];
const CURRENCY = "usd";

const apply = process.argv.includes("--apply");
const allowLive = process.argv.includes("--allow-live");

type StripeError = { error?: { message?: string; code?: string } };

async function call<T>(
  path: string,
  init?: { method?: string; body?: URLSearchParams; idempotencyKey?: string },
): Promise<{ ok: true; data: T } | { ok: false; status: number; message: string }> {
  const secret = process.env.STRIPE_SECRET_KEY!;
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        authorization: `Bearer ${secret}`,
        "Stripe-Version": API_VERSION,
        ...(init?.body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        ...(init?.idempotencyKey ? { "Idempotency-Key": init.idempotencyKey } : {}),
      },
      body: init?.body?.toString(),
    });
  } catch (e) {
    return { ok: false, status: 0, message: e instanceof Error ? e.message : "network error" };
  }
  const json = (await res.json().catch(() => ({}))) as T & StripeError;
  if (!res.ok) {
    return { ok: false, status: res.status, message: json.error?.message ?? `HTTP ${res.status}` };
  }
  return { ok: true, data: json };
}

/** Find-or-create the plan's Product. The id is set explicitly so this is idempotent. */
async function ensureProduct(planId: PlanId): Promise<{ ok: boolean; note: string }> {
  const id = productIdFor(planId);

  const existing = await call<{ id: string; active: boolean }>(`/products/${id}`);
  if (existing.ok) {
    return { ok: true, note: existing.data.active ? "exists" : "exists (INACTIVE — reactivate it)" };
  }
  if (existing.status !== 404) {
    return { ok: false, note: `could not read: ${existing.message}` };
  }
  if (!apply) return { ok: true, note: "MISSING — would create" };

  const created = await call<{ id: string }>("/products", {
    method: "POST",
    body: new URLSearchParams({
      id,
      name: `Markii ${planId[0].toUpperCase()}${planId.slice(1)}`,
      "metadata[markii_plan]": planId,
    }),
    idempotencyKey: `markii_product_${id}`,
  });
  return created.ok ? { ok: true, note: "created" } : { ok: false, note: created.message };
}

type PriceRow = {
  id: string;
  unit_amount: number | null;
  currency: string;
  active: boolean;
  recurring?: { interval?: string } | null;
};

async function ensurePrice(
  planId: PlanId,
  interval: BillingInterval,
): Promise<{ ok: boolean; note: string }> {
  const lookupKey = priceLookupKey(planId, interval);
  const expected = expectedUnitAmountMinor(planId, interval);

  /** The same query `resolvePrice` makes, so this reports what the app will see. */
  const found = await call<{ data: PriceRow[] }>(
    `/prices?lookup_keys[]=${encodeURIComponent(lookupKey)}&active=true&limit=2`,
  );
  if (!found.ok) return { ok: false, note: `lookup failed: ${found.message}` };

  const rows = found.data.data ?? [];

  if (rows.length > 1) {
    // resolvePrice refuses this rather than picking by list order, so creating
    // another would make the situation worse.
    return { ok: false, note: `${rows.length} active prices share this key — archive the extras` };
  }

  if (rows.length === 1) {
    const price = rows[0];
    const problems: string[] = [];
    if (price.unit_amount !== expected) {
      problems.push(`charges ${price.unit_amount}, expected ${expected}`);
    }
    if (price.recurring?.interval !== interval) {
      problems.push(`recurs ${price.recurring?.interval ?? "not at all"}, expected ${interval}`);
    }
    if (price.currency?.toLowerCase() !== CURRENCY) {
      problems.push(`is ${price.currency?.toUpperCase()}, expected ${CURRENCY.toUpperCase()}`);
    }
    if (problems.length === 0) return { ok: true, note: `ok (${price.id})` };
    /**
     * Reported, not repaired. A Stripe Price's amount cannot be edited, so
     * "fixing" it means archiving and re-creating — and doing that silently
     * would change what merchants on that price are billed at next renewal.
     */
    return { ok: false, note: `MISMATCH — ${problems.join("; ")}. Archive and re-create it` };
  }

  if (!apply) return { ok: true, note: `MISSING — would create at ${expected} ${CURRENCY}/${interval}` };

  const created = await call<{ id: string }>("/prices", {
    method: "POST",
    body: new URLSearchParams({
      product: productIdFor(planId),
      lookup_key: lookupKey,
      unit_amount: String(expected),
      currency: CURRENCY,
      "recurring[interval]": interval,
      "metadata[markii_plan]": planId,
    }),
    idempotencyKey: `markii_price_${lookupKey}_${expected}`,
  });
  return created.ok
    ? { ok: true, note: `created ${created.data.id} at ${expected}` }
    : { ok: false, note: created.message };
}

function money(minor: number): string {
  return `$${(minor / 100).toFixed(2)}`;
}

async function main() {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    console.error(
      "✖ STRIPE_SECRET_KEY is not set.\n" +
        "  Add it to .env.local (test mode: sk_test_…).",
    );
    process.exit(1);
  }

  const isLive = !secret.startsWith("sk_test") && !secret.startsWith("rk_test");
  if (isLive && !allowLive) {
    console.error(
      "✖ STRIPE_SECRET_KEY is a LIVE key. Refusing without --allow-live.\n" +
        "  The plan prices are signed off (docs/PRICING.md §3, 2026-08-10), so this is a\n" +
        "  legitimate thing to do — but a live Price is what real merchants get charged\n" +
        "  against, and Stripe amounts cannot be edited afterwards. Re-run with --allow-live\n" +
        "  when you mean it.",
    );
    process.exit(1);
  }

  console.log(
    `\n  Stripe ${isLive ? "LIVE" : "TEST"} mode — ${apply ? "APPLYING" : "dry run (pass --apply to create)"}\n`,
  );

  let failures = 0;

  for (const planId of PLAN_IDS) {
    const product = await ensureProduct(planId);
    if (!product.ok) failures++;
    console.log(`  ${product.ok ? "·" : "✖"} product ${productIdFor(planId)} — ${product.note}`);

    for (const interval of INTERVALS) {
      const result = await ensurePrice(planId, interval);
      if (!result.ok) failures++;
      const expected = expectedUnitAmountMinor(planId, interval);
      console.log(
        `    ${result.ok ? "·" : "✖"} ${priceLookupKey(planId, interval).padEnd(22)} ` +
          `${money(expected).padStart(8)}/${interval.padEnd(5)} — ${result.note}`,
      );
    }
  }

  if (failures > 0) {
    console.error(`\n✖ ${failures} problem(s). Nothing downstream will work until they are fixed.\n`);
    process.exit(1);
  }

  console.log(
    apply
      ? "\n✔ All plan prices present and matching lib/plans.ts.\n"
      : "\n  Dry run complete. Re-run with --apply to create anything marked MISSING.\n",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
