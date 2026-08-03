import {
  button,
  esc,
  money,
  paragraph,
  renderHtml,
  renderText,
  type RenderedEmail,
} from "./layout";

/**
 * Digital delivery mail (§18.8).
 *
 * **The link in this email is the entitlement.** A download grant token is the
 * shopper's only credential — anyone holding the URL can spend a download
 * against the cap. Three consequences shape this template:
 *
 * - The URL is never truncated, shortened, or wrapped in a redirect that hides
 *   it. A shopper who cannot copy the full link cannot get what they paid for.
 * - The limit and expiry are stated plainly, because they are the terms the
 *   shopper is being held to. Discovering a 3-download cap on the fourth attempt
 *   is a support ticket the merchant did not need.
 * - Nothing here is logged by callers. A grant token in an application log is a
 *   credential in an application log.
 */

export type DeliveryItem = {
  name: string;
  /** The full, unshortened grant URL. */
  url: string;
  /** Null means unlimited — say so rather than omitting the line. */
  downloadLimit: number | null;
  /** Already-formatted date, or null for no expiry. Rendered, never computed. */
  expiresOn: string | null;
  sizeLabel?: string | null;
};

/**
 * Licence keys are listed **separately from downloads**, not attached to them.
 *
 * A grant belongs to a file; a key belongs to a product, and a product can have
 * several files or none. Pairing them in the template would mean inventing a
 * join the data does not support — and a key shown under the wrong file is a key
 * the customer tries in the wrong place.
 */
export type DeliveryLicenceKey = { key: string; productName: string };

export type DeliveryMailContext = {
  storeName: string;
  orderId: number;
  items: DeliveryItem[];
  licenceKeys: DeliveryLicenceKey[];
  /** Shown so the email doubles as a receipt for a download-only order. */
  totalMinor?: number | null;
  currency?: string | null;
  supportEmail?: string | null;
};

function termsFor(item: DeliveryItem): string {
  const parts: string[] = [];
  parts.push(
    item.downloadLimit === null
      ? "Unlimited downloads"
      : `${item.downloadLimit} download${item.downloadLimit === 1 ? "" : "s"}`,
  );
  if (item.expiresOn) parts.push(`available until ${item.expiresOn}`);
  if (item.sizeLabel) parts.push(item.sizeLabel);
  return parts.join(" · ");
}

export function digitalDelivery(ctx: DeliveryMailContext): RenderedEmail {
  const blocks: string[] = [
    paragraph(
      ctx.items.length === 1
        ? `Your download from order #${ctx.orderId} is ready.`
        : `Your ${ctx.items.length} downloads from order #${ctx.orderId} are ready.`,
    ),
  ];

  for (const item of ctx.items) {
    blocks.push(
      `<div style="margin:0 0 24px;padding:16px;border:1px solid #E5E5EA;border-radius:10px">
        <div style="font-weight:600;margin-bottom:4px">${esc(item.name)}</div>
        <div style="color:#5C5C66;font-size:13px;margin-bottom:12px">${esc(termsFor(item))}</div>
        ${button("Download", item.url)}
      </div>`,
    );
  }

  if (ctx.licenceKeys.length > 0) {
    blocks.push(
      `<div style="margin:0 0 24px;padding:16px;border:1px solid #E5E5EA;border-radius:10px">
        <div style="font-weight:600;margin-bottom:8px">${ctx.licenceKeys.length === 1 ? "Your licence key" : "Your licence keys"}</div>
        ${ctx.licenceKeys
          .map(
            (k) =>
              `<div style="font-size:13px;color:#5C5C66;margin-bottom:4px">${esc(k.productName)}: <code style="color:#16161D;font-size:14px">${esc(k.key)}</code></div>`,
          )
          .join("")}
      </div>`,
    );
  }

  blocks.push(
    paragraph(
      "Keep this email — these links are how you get to your files, so treat them like a receipt " +
        "you would not forward.",
    ),
  );

  const footer = [
    ctx.supportEmail
      ? `Trouble downloading? Contact ${esc(ctx.supportEmail)}.`
      : "Trouble downloading? Just reply to this email.",
  ];
  if (ctx.totalMinor != null && ctx.currency) {
    footer.unshift(`Order #${ctx.orderId} · ${esc(money(ctx.totalMinor, ctx.currency))}`);
  }

  return {
    subject:
      ctx.items.length === 1
        ? `Your download is ready — ${ctx.storeName}`
        : `Your downloads are ready — ${ctx.storeName}`,
    html: renderHtml({
      storeName: ctx.storeName,
      heading: ctx.items.length === 1 ? "Your download is ready" : "Your downloads are ready",
      blocks,
      footer,
    }),
    text: renderText([
      ctx.items.length === 1 ? "Your download is ready" : "Your downloads are ready",
      ``,
      `Order #${ctx.orderId}`,
      ``,
      ...ctx.items.flatMap((item) => [
        `${item.name}`,
        `  ${termsFor(item)}`,
        `  ${item.url}`,
        ``,
      ]),
      ...(ctx.licenceKeys.length > 0
        ? [
            ctx.licenceKeys.length === 1 ? `Your licence key` : `Your licence keys`,
            ...ctx.licenceKeys.map((k) => `  ${k.productName}: ${k.key}`),
            ``,
          ]
        : []),
      `Keep this email — these links are how you get to your files.`,
      ``,
      `— ${ctx.storeName}`,
    ]),
  };
}
