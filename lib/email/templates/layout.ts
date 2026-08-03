import { formatMinor } from "../../api/money";

/**
 * The shared shell for merchant mail.
 *
 * **These emails are the merchant's, not Markii's.** No Markii logo, no
 * gradient, no "powered by" — a customer's order confirmation is a message from
 * the store they bought from, and putting a platform's brand on it is both
 * presumptuous and confusing at the moment a shopper is checking whether they
 * were charged correctly. The palette here is deliberately neutral so it sits
 * under any merchant's name.
 *
 * Written as inline-styled tables because that is what mail clients render.
 * Outlook has no flexbox, Gmail strips `<style>` blocks in some contexts, and
 * dark-mode clients recolour backgrounds unpredictably — so the layout stays
 * simple enough that none of that matters.
 */

/**
 * Escape text for HTML.
 *
 * Product titles, variant names and merchant notes all reach these templates
 * unmodified from the catalog, and a product legitimately called
 * `Sizes < 10 "narrow"` would otherwise break the markup. Merchant custom code
 * runs on storefronts (`CLAUDE.md`), so catalog strings are not trusted input.
 */
export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** `formatMinor` is the single source of truth for the exponent (D31). */
export function money(amountMinor: number, currency: string): string {
  return formatMinor(amountMinor, currency);
}

const TEXT = "#16161D";
const MUTED = "#5C5C66";
const RULE = "#E5E5EA";

export type LayoutInput = {
  storeName: string;
  /** Rendered as the leading headline. */
  heading: string;
  /** Pre-rendered HTML blocks, in order. */
  blocks: string[];
  /** Small print under the rule — store contact, policy note. */
  footer?: string[];
};

export function renderHtml(input: LayoutInput): string {
  const blocks = input.blocks.join("\n");
  const footer =
    input.footer && input.footer.length > 0
      ? `<tr><td style="padding:24px 0 0;border-top:1px solid ${RULE};color:${MUTED};font-size:13px;line-height:20px">
           ${input.footer.join("<br>")}
         </td></tr>`
      : "";

  return `<!-- ${esc(input.storeName)} -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAFAFA;margin:0;padding:24px 0">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border:1px solid ${RULE};border-radius:12px;padding:32px">
      <tr><td style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${TEXT};font-size:15px;line-height:24px">
        <div style="font-size:13px;color:${MUTED};letter-spacing:.04em;text-transform:uppercase">${esc(input.storeName)}</div>
        <h1 style="margin:8px 0 24px;font-size:22px;line-height:30px;font-weight:600;color:${TEXT}">${esc(input.heading)}</h1>
        ${blocks}
      </td></tr>
      ${footer}
    </table>
  </td></tr>
</table>`;
}

/** A `label: value` row, for totals. `strong` marks the order total. */
export function totalRow(label: string, value: string, strong = false): string {
  const weight = strong ? "600" : "400";
  const color = strong ? TEXT : MUTED;
  return `<tr>
    <td style="padding:4px 0;color:${color};font-weight:${weight}">${esc(label)}</td>
    <td align="right" style="padding:4px 0;color:${TEXT};font-weight:${weight};white-space:nowrap">${esc(value)}</td>
  </tr>`;
}

export function totalsTable(rows: string[]): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
    style="margin:16px 0;font-size:14px;line-height:22px">${rows.join("")}</table>`;
}

export function paragraph(text: string): string {
  return `<p style="margin:0 0 16px;color:${TEXT}">${esc(text)}</p>`;
}

/**
 * A call-to-action.
 *
 * Rendered as a plain link as well as a button in the text part, because a
 * shopper whose client blocks the styled version still needs the URL — and for
 * digital delivery that URL *is* the entitlement.
 */
export function button(label: string, url: string): string {
  return `<p style="margin:0 0 20px">
    <a href="${esc(url)}" style="display:inline-block;background:${TEXT};color:#FFFFFF;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600;font-size:14px">${esc(label)}</a>
  </p>`;
}

/** Line items as a table. `note` renders under the title — variant, SKU. */
export function lineTable(
  lines: { title: string; note?: string | null; quantity: number; amount: string }[],
): string {
  const rows = lines
    .map(
      (l) => `<tr>
        <td style="padding:10px 0;border-bottom:1px solid ${RULE};vertical-align:top">
          <div style="color:${TEXT}">${esc(l.title)}</div>
          ${l.note ? `<div style="color:${MUTED};font-size:13px">${esc(l.note)}</div>` : ""}
          <div style="color:${MUTED};font-size:13px">Qty ${l.quantity}</div>
        </td>
        <td align="right" style="padding:10px 0;border-bottom:1px solid ${RULE};vertical-align:top;white-space:nowrap;color:${TEXT}">${esc(l.amount)}</td>
      </tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:22px">${rows}</table>`;
}

/**
 * The plain-text part.
 *
 * Not an afterthought: text/plain is what screen readers, some corporate
 * gateways, and every agent parsing a receipt actually read — and agent
 * legibility is the product (`CLAUDE.md`). It carries the same facts and the
 * same links as the HTML, never a "view this email in your browser" stub.
 */
export function renderText(lines: (string | null | undefined)[]): string {
  return lines.filter((l) => l !== null && l !== undefined).join("\n").trim();
}

export type RenderedEmail = { subject: string; html: string; text: string };
