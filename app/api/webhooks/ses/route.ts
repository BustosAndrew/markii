import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, emailDeliveries } from "@/lib/db";
import {
  confirmSubscription,
  suppressionSignals,
  verifySnsMessage,
  type SesEvent,
  type SnsEnvelope,
} from "@/lib/email/sns";
import { suppress } from "@/lib/email/suppression";

/**
 * `POST /api/webhooks/ses` (§6) — SES bounce and complaint events over SNS.
 *
 * **This is what keeps the SES account alive.** AWS suspends senders above
 * roughly 5% bounce or 0.1% complaint, measured across the whole account — so
 * one merchant repeatedly mailing a dead address can get every merchant on the
 * platform cut off. Every event that lands here ends in a suppression or is
 * deliberately ignored, and both are decisions rather than defaults.
 *
 * Not an action (§22): there is no actor and no organization on the request.
 * SNS is an unauthenticated caller proving itself with a signature, and the
 * write it causes is a platform-safety record, not a merchant mutation.
 *
 * **Always answers 200 once the signature verifies.** SNS retries a non-2xx for
 * an hour and then disables the subscription — losing every future bounce
 * because one lookup failed is a far worse outcome than dropping one event, so
 * failures are logged and acknowledged.
 */

export const POST = async (req: Request) => {
  const raw = await req.text();

  let envelope: SnsEnvelope;
  try {
    envelope = JSON.parse(raw) as SnsEnvelope;
  } catch {
    return NextResponse.json({ error: "Body is not JSON." }, { status: 400 });
  }

  const verified = await verifySnsMessage(envelope);
  if (!verified.ok) {
    // 403, not 400: this is a rejected caller, and it is the one case worth
    // alerting on — someone is posting unsigned bounce events at us.
    console.warn("[ses-webhook] rejected unverified SNS message", verified.reason);
    return NextResponse.json({ error: verified.reason }, { status: 403 });
  }

  if (envelope.Type === "SubscriptionConfirmation") {
    const confirmed = envelope.SubscribeURL
      ? await confirmSubscription(envelope.SubscribeURL)
      : false;
    return NextResponse.json({ ok: true, confirmed });
  }

  if (envelope.Type !== "Notification") {
    return NextResponse.json({ ok: true, ignored: envelope.Type });
  }

  let event: SesEvent;
  try {
    event = JSON.parse(envelope.Message) as SesEvent;
  } catch {
    console.error("[ses-webhook] notification payload was not JSON");
    return NextResponse.json({ ok: true, ignored: "unparseable" });
  }

  const signals = suppressionSignals(event);
  if (signals.length === 0) {
    // Deliveries, opens, transient bounces. Acknowledged and dropped.
    return NextResponse.json({ ok: true, suppressed: 0 });
  }

  /**
   * Which merchant this was. Resolved through `email_deliveries`, because SES
   * knows the message id and nothing about organizations — and suppression is
   * per org (an address that reported one store has not blocked every store).
   *
   * An event we cannot attribute is dropped rather than applied globally.
   * Guessing wrong here silences a merchant's mail to a customer who never
   * complained about them.
   */
  const messageId = signals[0].messageId;
  if (!messageId) {
    console.warn("[ses-webhook] event carried no message id; cannot attribute to an org");
    return NextResponse.json({ ok: true, suppressed: 0, reason: "no_message_id" });
  }

  const [delivery] = await db
    .select({ orgId: emailDeliveries.orgId })
    .from(emailDeliveries)
    .where(eq(emailDeliveries.providerMessageId, messageId))
    .orderBy(desc(emailDeliveries.createdAt))
    .limit(1);

  if (!delivery) {
    console.warn("[ses-webhook] no delivery record for message", messageId);
    return NextResponse.json({ ok: true, suppressed: 0, reason: "unknown_message" });
  }

  let suppressed = 0;
  for (const signal of signals) {
    try {
      await suppress({
        orgId: delivery.orgId,
        email: signal.email,
        reason: signal.reason,
        detail: signal.detail,
        sourceMessageId: messageId,
      });
      suppressed += 1;
    } catch (e) {
      console.error("[ses-webhook] could not record suppression", e);
    }
  }

  // The delivery's own outcome, so a merchant looking at one order sees what
  // happened to its email rather than only a platform-level list.
  await db
    .update(emailDeliveries)
    .set({
      status: signals[0].reason === "complaint" ? "complained" : "bounced",
      reason: signals[0].detail,
    })
    .where(eq(emailDeliveries.providerMessageId, messageId))
    .catch((e) => console.error("[ses-webhook] could not update delivery status", e));

  return NextResponse.json({ ok: true, suppressed });
};
