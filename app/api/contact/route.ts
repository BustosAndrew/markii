import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, handler } from "@/lib/api";
import { isResendConfigured, sendPlatformMail } from "@/lib/email";

const contactSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254),
  topic: z
    .enum(["general", "sales", "support", "billing"])
    .optional()
    .default("general"),
  message: z.string().trim().min(10).max(5000),
  /** Honeypot — bots fill this; humans leave it empty. */
  company: z.string().max(200).optional(),
});

const TOPIC_LABEL: Record<string, string> = {
  general: "General",
  sales: "Sales",
  support: "Support",
  billing: "Billing",
};

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const POST = handler(async (req) => {
  const input = contactSchema.parse(await req.json());

  // Silent success for honeypot hits so scrapers do not learn the field exists.
  if (input.company?.trim()) {
    return NextResponse.json({ ok: true });
  }

  if (!isResendConfigured()) {
    throw badRequest(
      "Email is not configured on this deployment yet. Please write us at support@markii.shop.",
    );
  }

  const to = process.env.CONTACT_TO?.trim() || "support@markii.shop";
  const topic = TOPIC_LABEL[input.topic] ?? "General";
  const subject = `[Markii contact · ${topic}] ${input.name}`;

  const text = [
    `From: ${input.name} <${input.email}>`,
    `Topic: ${topic}`,
    "",
    input.message,
  ].join("\n");

  const html = `
    <p><strong>From:</strong> ${escapeHtml(input.name)} &lt;${escapeHtml(input.email)}&gt;</p>
    <p><strong>Topic:</strong> ${escapeHtml(topic)}</p>
    <hr />
    <p style="white-space:pre-wrap">${escapeHtml(input.message)}</p>
  `.trim();

  const result = await sendPlatformMail({
    to,
    subject,
    text,
    html,
    replyTo: input.email,
  });

  if (!result.sent) {
    console.error("[contact] platform mail failed", result.reason);
    throw badRequest(
      "We could not send your message just now. Please email support@markii.shop directly.",
    );
  }

  return NextResponse.json({ ok: true });
});
