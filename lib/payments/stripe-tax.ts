import "server-only";

/**
 * Stripe Tax over the Connect account (§18.6, `docs/DECISIONS.md` G3).
 *
 * **Every call carries `Stripe-Account`, and that is the whole design.** Under
 * Connect Standard the merchant is the seller of record and the taxpayer (G2),
 * so the registrations that decide what is owed are *theirs*, the calculation is
 * billed to *their* Stripe account, and the transactions that back *their*
 * filings land in *their* Stripe Tax reports. A calculation run on Markii's
 * platform account would answer with Markii's registrations — a number about
 * the wrong company's tax position, presented to a shopper as their own.
 *
 * This is the same direction of money as `stripe-charges.ts` and the opposite of
 * `lib/billing/` (D4). Nothing here ever touches the platform account.
 *
 * **Markii still gives no tax advice.** This module asks Stripe what the
 * merchant's own configuration produces and reports the answer verbatim; it
 * never infers a rate, never falls back to one, and never turns a failure into a
 * zero — a fabricated zero is a claim about a liability nobody established.
 *
 * Hand-rolled over `fetch`, like every other Stripe surface in this codebase.
 */

const API = "https://api.stripe.com/v1";

/** Why a Stripe Tax call could not answer. The two need different people to fix. */
export type TaxFailureCode =
  /** Markii's side: no credentials, Stripe unreachable, an API error. */
  | "unavailable"
  /** The merchant's side: not connected, Stripe Tax not activated, no address. */
  | "configuration_required";

export type StripeTaxFailure = { ok: false; code: TaxFailureCode; reason: string };

/** One line as Stripe Tax sees it: an amount, already net of discount. */
export type StripeTaxLine = {
  /** Unique within the calculation. Ours is `line:{cartLineId}` or `preview`. */
  reference: string;
  /** The **whole** line, not the unit price. Minor units, unscaled (D31). */
  amountMinor: number;
  quantity: number;
  /** Stripe product tax code (`txcd_…`). Null lets Stripe use the account default. */
  taxCode: string | null;
};

export type TaxAddress = {
  line1?: string | null;
  city?: string | null;
  province?: string | null;
  postalCode?: string | null;
  /** ISO 3166-1 alpha-2. Stripe refuses a calculation without it. */
  country: string;
};

export type StripeTaxCalculation = {
  ok: true;
  /**
   * Stripe's `taxcalc_…`, or **null**.
   *
   * Null is not an error: Stripe returns no id when a calculation is not
   * eligible to become a transaction (an address too vague to file against, for
   * one). The tax figure is still correct and still chargeable — what is lost is
   * the ability to record it for the merchant's reporting, so callers must treat
   * a null id as "charge this, record nothing" rather than as a failure.
   */
  calculationId: string | null;
  /** Tax to **add** to the total. Zero on a tax-inclusive store. */
  taxAmountExclusiveMinor: number;
  /** Tax already **inside** the listed prices. Zero on a tax-exclusive store. */
  taxAmountInclusiveMinor: number;
  breakdown: { name: string; rateBps: number; amountMinor: number }[];
  /** When the calculation stops being convertible into a transaction (90 days). */
  expiresAt: Date | null;
};

type StripeError = { error?: { message?: string; code?: string; type?: string } };

function secret(): string | null {
  return process.env.STRIPE_SECRET_KEY ?? null;
}

/**
 * One form-encoded POST against a connected account.
 *
 * `Idempotency-Key` is optional because it is only *correct* on the calls that
 * create something. A retried calculation is free to produce a second
 * calculation object; a retried transaction must not produce a second entry in
 * the merchant's tax report.
 */
async function post<T>(
  path: string,
  accountId: string,
  body: URLSearchParams,
  idempotencyKey?: string,
): Promise<(T & { ok: true }) | StripeTaxFailure> {
  const key = secret();
  if (!key) {
    return { ok: false, code: "unavailable", reason: "Markii has no Stripe credentials configured." };
  }

  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Bearer ${key}`,
        "Stripe-Account": accountId,
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: body.toString(),
    });
  } catch (e) {
    return {
      ok: false,
      code: "unavailable",
      reason: e instanceof Error ? e.message : "Could not reach Stripe.",
    };
  }

  const json = (await res.json().catch(() => ({}))) as T & StripeError;
  if (!res.ok) return { ok: false, ...classify(json, res.status) };
  return { ...json, ok: true };
}

/**
 * Whose problem a Stripe error is.
 *
 * The distinction is not cosmetic: `configuration_required` sends the merchant
 * to their own Stripe dashboard to activate Stripe Tax or add a registration,
 * and `unavailable` sends nobody anywhere because it is ours. Getting it
 * backwards tells a merchant to fix something they cannot see.
 */
function classify(json: StripeError, status: number): { code: TaxFailureCode; reason: string } {
  const code = json.error?.code ?? "";
  const message = json.error?.message ?? `Stripe returned ${status}.`;

  /**
   * Stripe's own wording for these is better than anything written here — it
   * names the missing registration or the inactive account directly.
   */
  const merchantSide =
    status === 403 ||
    code === "tax_not_active" ||
    code === "customer_tax_location_invalid" ||
    code === "account_invalid" ||
    /stripe tax/i.test(message);

  return { code: merchantSide ? "configuration_required" : "unavailable", reason: message };
}

/** `8.25` (percent, as Stripe sends it) → `825` basis points. Never a float total. */
function bpsFrom(percentageDecimal: unknown): number {
  const pct = typeof percentageDecimal === "string" ? Number(percentageDecimal) : NaN;
  return Number.isFinite(pct) ? Math.round(pct * 100) : 0;
}

const TAX_TYPE_NAMES: Record<string, string> = {
  vat: "VAT",
  gst: "GST",
  hst: "HST",
  pst: "PST",
  qst: "QST",
  rst: "RST",
  jct: "JCT",
  igst: "IGST",
  sales_tax: "Sales tax",
  service_tax: "Service tax",
  amusement_tax: "Amusement tax",
  communications_tax: "Communications tax",
  lease_tax: "Lease tax",
  retail_delivery_fee: "Retail delivery fee",
};

export type BreakdownRow = {
  amount?: number;
  inclusive?: boolean;
  jurisdiction?: { display_name?: string; state?: string; country?: string; level?: string };
  tax_rate_details?: {
    percentage_decimal?: string;
    tax_type?: string;
    state?: string;
    country?: string;
    display_name?: string;
  };
};

/**
 * A line the shopper can read.
 *
 * Stripe names a jurisdiction and a tax type separately; a receipt saying
 * "California Sales tax" is legible and one saying "sales_tax" is not. The
 * fallbacks descend rather than invent — an unnamed jurisdiction becomes "Tax",
 * never a guessed one.
 */
function nameOf(row: BreakdownRow): string {
  const details = row.tax_rate_details ?? {};
  const place =
    row.jurisdiction?.display_name ??
    details.state ??
    row.jurisdiction?.state ??
    details.country ??
    row.jurisdiction?.country ??
    null;
  const type = details.tax_type ? (TAX_TYPE_NAMES[details.tax_type] ?? details.tax_type) : "Tax";
  return place ? `${place} ${type}` : type;
}

/**
 * Stripe's `tax_breakdown` in this codebase's shape.
 *
 * Exported because this is where a wrong number would reach a shopper's
 * receipt and a merchant's records, and it is the one part of the module that
 * can be tested without a Stripe account. Zero-amount rows are dropped: Stripe
 * returns a row per jurisdiction it considered, and listing "0% Colorado" on a
 * receipt for an order that was never taxed there is noise the shopper has to
 * decide is not a mistake.
 */
export function normalizeBreakdown(
  rows: BreakdownRow[],
): { name: string; rateBps: number; amountMinor: number }[] {
  return rows
    .filter((row) => (row.amount ?? 0) !== 0)
    .map((row) => ({
      name: nameOf(row),
      rateBps: bpsFrom(row.tax_rate_details?.percentage_decimal),
      amountMinor: row.amount ?? 0,
    }));
}

/**
 * Asks the merchant's Stripe account what tax this basket attracts.
 *
 * `taxBehavior` follows the store's `pricesIncludeTax`: `inclusive` means the
 * listed prices already contain the tax and Stripe extracts it, `exclusive`
 * means it is added. Sending the wrong one is not a rounding difference — it
 * either charges the shopper the tax twice or leaves the merchant paying it.
 *
 * Amounts pass through **unscaled**, exactly as `stripe-charges.ts` does: minor
 * units are what Stripe wants and what this codebase stores, and a `/100`
 * anywhere here would misquote a JPY store a hundredfold (D31).
 */
export async function createTaxCalculation(input: {
  accountId: string;
  currency: string;
  lines: StripeTaxLine[];
  shippingMinor: number;
  address: TaxAddress;
  pricesIncludeTax: boolean;
  /** The store's fallback code for lines that carry none of their own. */
  defaultTaxCode: string | null;
}): Promise<StripeTaxCalculation | StripeTaxFailure> {
  if (input.lines.length === 0) {
    return { ok: false, code: "unavailable", reason: "Nothing to calculate tax on." };
  }

  const behavior = input.pricesIncludeTax ? "inclusive" : "exclusive";
  const body = new URLSearchParams({
    currency: input.currency.toLowerCase(),
    "customer_details[address][country]": input.address.country.toUpperCase(),
    /**
     * The **shipping** address, stated explicitly. Stripe defaults to treating
     * an address as billing, and destination-based sales tax is owed where the
     * goods arrive — a billing address in a no-tax state would under-collect on
     * every order shipped into one that charges.
     */
    "customer_details[address_source]": "shipping",
  });
  if (input.address.line1) body.set("customer_details[address][line1]", input.address.line1);
  if (input.address.city) body.set("customer_details[address][city]", input.address.city);
  if (input.address.province) body.set("customer_details[address][state]", input.address.province);
  if (input.address.postalCode) {
    body.set("customer_details[address][postal_code]", input.address.postalCode);
  }

  input.lines.forEach((line, i) => {
    body.set(`line_items[${i}][amount]`, String(line.amountMinor));
    body.set(`line_items[${i}][reference]`, line.reference);
    body.set(`line_items[${i}][quantity]`, String(line.quantity));
    body.set(`line_items[${i}][tax_behavior]`, behavior);
    const code = line.taxCode ?? input.defaultTaxCode;
    if (code) body.set(`line_items[${i}][tax_code]`, code);
  });

  /**
   * Shipping is quoted to Stripe as its own component rather than folded into a
   * line, because whether delivery is taxable is a jurisdiction's decision and
   * Stripe already knows it. Rolling it into the goods would tax it everywhere;
   * leaving it out would exempt it everywhere. Both are wrong somewhere.
   */
  if (input.shippingMinor > 0) {
    body.set("shipping_cost[amount]", String(input.shippingMinor));
    body.set("shipping_cost[tax_behavior]", behavior);
  }

  const res = await post<{
    id?: string | null;
    tax_amount_exclusive?: number;
    tax_amount_inclusive?: number;
    tax_breakdown?: BreakdownRow[];
    expires_at?: number | null;
  }>("/tax/calculations", input.accountId, body);
  if (!res.ok) return res;

  return {
    ok: true,
    calculationId: res.id ?? null,
    taxAmountExclusiveMinor: res.tax_amount_exclusive ?? 0,
    taxAmountInclusiveMinor: res.tax_amount_inclusive ?? 0,
    breakdown: normalizeBreakdown(res.tax_breakdown ?? []),
    expiresAt: res.expires_at ? new Date(res.expires_at * 1000) : null,
  };
}

/**
 * Records a calculation as a transaction on the merchant's Stripe Tax reports.
 *
 * **A calculation is a quote; a transaction is the filing record.** Without this
 * call the merchant charges tax correctly and has nothing to file with — Stripe
 * Tax's reports would show none of it, and the money they collected on Markii's
 * behalf of nobody would be invisible at return time. It is the half of Stripe
 * Tax that is easy to skip and impossible to reconstruct afterwards, because a
 * calculation expires.
 *
 * Called **only after payment succeeds**. A transaction created at quote time
 * would report tax on every abandoned basket.
 *
 * `reference` is the merchant's own handle on the row and must be unique on
 * their account; ours names the Markii order, so a redelivered webhook and a
 * browser redirect both resolve to the one transaction rather than two.
 */
export async function createTaxTransaction(input: {
  accountId: string;
  calculationId: string;
  /** Unique per account. `markii_order_{id}`. */
  reference: string;
}): Promise<{ ok: true; transactionId: string } | StripeTaxFailure> {
  const body = new URLSearchParams({
    calculation: input.calculationId,
    reference: input.reference,
  });

  const res = await post<{ id?: string }>(
    "/tax/transactions/create_from_calculation",
    input.accountId,
    body,
    `markii_tax_txn_${input.reference}`,
  );
  if (!res.ok) return res;
  if (!res.id) {
    return { ok: false, code: "unavailable", reason: "Stripe returned no tax transaction id." };
  }
  return { ok: true, transactionId: res.id };
}

/**
 * Reverses tax on a refund, so the merchant does not file — and pay — tax on
 * money they gave back.
 *
 * `full` when the whole order came back, `partial` otherwise. A partial reversal
 * is quoted as a `flat_amount`: Stripe wants the total being returned
 * **including its tax**, which is exactly `ComputedRefund.amountMinor`, and it
 * is negative because a reversal subtracts. Quoting it line by line would mean
 * mapping Markii's order lines onto the references sent at calculation time
 * through a discount allocation — more moving parts for the same number, each
 * one a way to reverse the wrong amount.
 *
 * `reference` names the Markii refund, so Stripe itself refuses a second
 * reversal of the same refund. That is the idempotency: a retried effect
 * collides on the reference rather than crediting the merchant twice.
 */
export async function createTaxReversal(input: {
  accountId: string;
  transactionId: string;
  /** Unique per account. `markii_refund_{id}`. */
  reference: string;
  mode: "full" | "partial";
  /** Positive minor units, tax included. Required for `partial`, ignored for `full`. */
  amountMinor?: number;
}): Promise<{ ok: true; reversalId: string } | StripeTaxFailure> {
  const body = new URLSearchParams({
    mode: input.mode,
    original_transaction: input.transactionId,
    reference: input.reference,
  });
  if (input.mode === "partial") {
    if (!input.amountMinor || input.amountMinor <= 0) {
      return {
        ok: false,
        code: "unavailable",
        reason: "A partial tax reversal needs a positive amount.",
      };
    }
    body.set("flat_amount", String(-input.amountMinor));
  }

  const res = await post<{ id?: string }>(
    "/tax/transactions/create_reversal",
    input.accountId,
    body,
    `markii_tax_rev_${input.reference}`,
  );
  if (!res.ok) return res;
  if (!res.id) {
    return { ok: false, code: "unavailable", reason: "Stripe returned no reversal id." };
  }
  return { ok: true, reversalId: res.id };
}

export type TaxAccountStatus = {
  ok: true;
  /** `active` is the only state that calculates. `pending` means Stripe is not finished. */
  status: "active" | "pending" | "unknown";
  /** What Stripe still wants from the merchant, verbatim. */
  missing: string[];
  defaultTaxCode: string | null;
  /**
   * Active registrations on the merchant's account.
   *
   * **Zero is the dangerous number.** Stripe Tax with no registration calculates
   * a legitimate zero everywhere, so the store looks configured, charges nothing,
   * and the merchant discovers the gap when they file. It is reported as its own
   * fact rather than folded into `status`, which Stripe reports as `active`
   * regardless.
   */
  activeRegistrations: number | null;
};

/**
 * Whether Stripe Tax can actually calculate on this merchant's account.
 *
 * Read live rather than cached on connect: a merchant activates Stripe Tax in
 * their own dashboard, at a time Markii is not told about, so a stored flag
 * would be stale in the direction that refuses working checkouts.
 */
export async function taxAccountStatus(
  accountId: string,
): Promise<TaxAccountStatus | StripeTaxFailure> {
  const key = secret();
  if (!key) {
    return { ok: false, code: "unavailable", reason: "Markii has no Stripe credentials configured." };
  }
  const headers = { authorization: `Bearer ${key}`, "Stripe-Account": accountId };

  let settings: Response;
  try {
    settings = await fetch(`${API}/tax/settings`, { headers });
  } catch (e) {
    return {
      ok: false,
      code: "unavailable",
      reason: e instanceof Error ? e.message : "Could not reach Stripe.",
    };
  }

  const json = (await settings.json().catch(() => ({}))) as {
    status?: string;
    status_details?: { pending?: { missing_fields?: string[] } };
    defaults?: { tax_code?: string | null };
  } & StripeError;
  if (!settings.ok) return { ok: false, ...classify(json, settings.status) };

  /**
   * Counted separately and allowed to fail on its own. A missing
   * `tax.registration` permission must not turn a readable settings object into
   * "Stripe Tax is broken" — the registration count is extra information, not
   * the answer.
   */
  let activeRegistrations: number | null = null;
  try {
    const regs = await fetch(`${API}/tax/registrations?status=active&limit=100`, { headers });
    if (regs.ok) {
      const body = (await regs.json().catch(() => ({}))) as { data?: unknown[] };
      activeRegistrations = Array.isArray(body.data) ? body.data.length : null;
    }
  } catch {
    activeRegistrations = null;
  }

  return {
    ok: true,
    status: json.status === "active" ? "active" : json.status === "pending" ? "pending" : "unknown",
    missing: json.status_details?.pending?.missing_fields ?? [],
    defaultTaxCode: json.defaults?.tax_code ?? null,
    activeRegistrations,
  };
}
