export { digitalDelivery } from "./delivery";
export type { DeliveryItem, DeliveryLicenceKey, DeliveryMailContext } from "./delivery";
export {
  cancellationNotice,
  orderConfirmation,
  refundNotice,
  shippingNotice,
} from "./orders";
export type {
  CancellationNoticeInput,
  OrderMailContext,
  OrderMailLine,
  RefundNoticeInput,
  ShippingNoticeInput,
} from "./orders";
export type { RenderedEmail } from "./layout";

/**
 * The stable identifier written to `email_deliveries.template`.
 *
 * Stable is the point: a merchant asking "which of our emails is bouncing?"
 * cannot be answered from a subject line they have since reworded, and a
 * template rename must not orphan a year of delivery history. Add to this union
 * rather than reusing an existing id for different content.
 */
export const TEMPLATE_IDS = [
  "order_confirmation",
  "shipping_notice",
  "refund_notice",
  "cancellation_notice",
  "digital_delivery",
] as const;

export type TemplateId = (typeof TEMPLATE_IDS)[number];
