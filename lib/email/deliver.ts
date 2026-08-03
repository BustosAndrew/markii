import "server-only";

import { inArray } from "drizzle-orm";
import { db, products } from "../db";
import { sendMerchantMail } from "./index";
import { digitalDelivery, type DeliveryLicenceKey } from "./templates";
import type { SendResult } from "./types";

/**
 * Emailing digital delivery (§18.8 × §6).
 *
 * **Why this exists as its own module.** A shopper who buys a file gets their
 * download links in the checkout response — but a browser tab gets closed, and
 * an agent-driven purchase has no tab at all. The email is the copy that
 * survives, and for a download-only order it is the entire delivery mechanism.
 *
 * It is called **after** the order is written and never inside the transaction:
 * an email cannot be rolled back, and a confirmation for an order that did not
 * commit is worse than a missing one.
 */

/** The subset of `DeliveryPayload` this needs, so the two modules stay uncoupled. */
export type DeliveryMailPayload = {
  downloads: {
    fileName: string;
    sizeBytes: number | null;
    url: string;
    downloadLimit: number | null;
    expiresAt: string | null;
  }[];
  licenceKeys: { key: string; productId: number }[];
};

/** `1.4 MB`. Approximate by design — this is a hint, not an invoice line. */
function sizeLabel(bytes: number | null): string | null {
  if (bytes == null || bytes <= 0) return null;
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Dates a shopper reads, in UTC, because a grant expires in UTC. */
function expiryLabel(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      });
}

async function productNames(ids: number[]): Promise<Map<number, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: products.id, name: products.name })
    .from(products)
    .where(inArray(products.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * Send the delivery email for an order, if there is anything to deliver.
 *
 * Returns `null` when the order has no digital items — the common case, and not
 * a failure. Never throws: a mail problem must not turn a settled payment into
 * an error response, because the shopper has already paid and the links are
 * already in the checkout response they are looking at.
 */
export async function sendDeliveryMail(input: {
  orgId: string;
  orderId: number;
  to: string | null;
  storeName: string;
  delivery: DeliveryMailPayload;
  totalMinor?: number | null;
  currency?: string | null;
  supportEmail?: string | null;
}): Promise<SendResult | null> {
  if (input.delivery.downloads.length === 0 && input.delivery.licenceKeys.length === 0) {
    return null;
  }
  if (!input.to) {
    // Agent-driven x402 orders often carry no address. The links were returned
    // in the checkout response, so this is not a delivery failure — but it is
    // also not something to report as a send.
    return null;
  }

  try {
    const names = await productNames(input.delivery.licenceKeys.map((k) => k.productId));
    const licenceKeys: DeliveryLicenceKey[] = input.delivery.licenceKeys.map((k) => ({
      key: k.key,
      productName: names.get(k.productId) ?? "Your purchase",
    }));

    const email = digitalDelivery({
      storeName: input.storeName,
      orderId: input.orderId,
      items: input.delivery.downloads.map((d) => ({
        name: d.fileName,
        url: d.url,
        downloadLimit: d.downloadLimit,
        expiresOn: expiryLabel(d.expiresAt),
        sizeLabel: sizeLabel(d.sizeBytes),
      })),
      licenceKeys,
      totalMinor: input.totalMinor ?? null,
      currency: input.currency ?? null,
      supportEmail: input.supportEmail ?? null,
    });

    return await sendMerchantMail(input.orgId, {
      to: input.to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      template: "digital_delivery",
      orderId: input.orderId,
    });
  } catch (e) {
    // Logged without the payload: `delivery.downloads[].url` contains grant
    // tokens, and a credential in an application log is a credential leak.
    console.error("[email] digital delivery send failed", {
      orderId: input.orderId,
      error: e instanceof Error ? e.message : String(e),
    });
    return {
      sent: false,
      provider: "none",
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}
