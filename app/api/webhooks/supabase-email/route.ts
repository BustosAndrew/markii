import { NextResponse } from "next/server";
import {
  actionOf,
  actionUrl,
  routeFor,
  verifyHookSignature,
  TEMPLATE_FOR,
  type HookPayload,
} from "@/lib/email/auth-hook";
import { sendMerchantMail, sendPlatformMail } from "@/lib/email";

/**
 * `POST /api/webhooks/supabase-email` (§24) — Supabase Send Email Hook.
 *
 * **Supabase stops sending auth mail the moment this hook is enabled**, for the
 * whole project and both identity domains. Everything below is shaped by that:
 * a bug here does not degrade email, it removes it — no password resets, no
 * shopper confirmations, for anyone.
 *
 * Not an action (§22): there is no actor and no organization on the request.
 * Supabase is an unauthenticated caller proving itself with a signature, and
 * the send it causes is auth plumbing rather than a merchant mutation.
 *
 * **Shopper mail always goes through SES from the merchant's own verified
 * domain** — never Resend, never `markii.shop`. Staff mail always goes through
 * Resend from `markii.shop`. The hook is the one place that choice is made,
 * which is why the two streams meet here and nowhere else.
 */
export async function POST(req: Request) {
  const secret = process.env.SEND_EMAIL_HOOK_SECRET;
  if (!secret) {
    /**
     * Refuses rather than sending unverified mail. An unauthenticated caller
     * reaching this route could otherwise make Markii send an attacker-chosen
     * link from a merchant's domain — phishing with the merchant's own
     * reputation behind it.
     */
    console.error("[auth-hook] SEND_EMAIL_HOOK_SECRET is not set; refusing");
    return NextResponse.json({ error: "hook not configured" }, { status: 503 });
  }

  const body = await req.text();
  const verified = verifyHookSignature(body, {
    id: req.headers.get("webhook-id"),
    timestamp: req.headers.get("webhook-timestamp"),
    signature: req.headers.get("webhook-signature"),
  }, secret);

  if (!verified.ok) {
    return NextResponse.json({ error: verified.reason }, { status: 403 });
  }

  let payload: HookPayload;
  try {
    payload = JSON.parse(body) as HookPayload;
  } catch {
    return NextResponse.json({ error: "body is not JSON" }, { status: 400 });
  }

  const action = actionOf(payload);
  const template = TEMPLATE_FOR[action];
  if (!template) {
    /**
     * An action this build does not know about. Refused rather than dropped:
     * answering 200 would tell Supabase the mail was handled, and the user
     * would wait forever for a message nobody sent.
     */
    console.error(`[auth-hook] unknown email_action_type: ${payload.email_data.email_action_type}`);
    return NextResponse.json({ error: "unsupported email action" }, { status: 400 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) {
    return NextResponse.json({ error: "supabase url not configured" }, { status: 503 });
  }

  const route = await routeFor(payload);
  const to = payload.user.email;
  const url = actionUrl(payload, supabaseUrl);

  if (route.stream === "refuse") {
    console.error(`[auth-hook] refusing ${action} for ${payload.user.id}: ${route.reason}`);
    return NextResponse.json({ error: route.reason }, { status: 422 });
  }

  if (route.stream === "platform") {
    // Markii's own people — Resend, from markii.shop, exactly as before the hook.
    const rendered = template.render({ storeName: "Markii", actionUrl: url, toEmail: to });
    const sent = await sendPlatformMail({
      to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    if (!sent.sent) {
      // A non-2xx makes Supabase surface the failure to the caller rather than
      // reporting a sign-in link as sent when nothing left the building.
      return NextResponse.json({ error: sent.reason }, { status: 502 });
    }
    return NextResponse.json({ ok: true, stream: "platform" });
  }

  const rendered = template.render({
    storeName: route.storeName,
    actionUrl: url,
    toEmail: to,
  });

  /**
   * Always SES, never Resend — this is the merchant's mail to their customer.
   *
   * `siteId` is what lets `sendMerchantMail` fall back to the storefront's own
   * `{slug}.{ROOT_DOMAIN}` address when the merchant has not verified a domain
   * (D44), rather than refusing. Blocking account creation over someone else's
   * unfinished setup would punish the shopper.
   */
  const sent = await sendMerchantMail(route.orgId, {
    to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    template: template.id,
    siteId: route.siteId,
  });

  if (!sent.sent) {
    console.error(`[auth-hook] merchant send failed for site ${route.siteId}: ${sent.reason}`);
    return NextResponse.json({ error: sent.reason }, { status: 502 });
  }

  return NextResponse.json({ ok: true, stream: "merchant" });
}
