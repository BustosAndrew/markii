import type { SignupBurst } from "@/lib/auth/signup-review";
import { esc, paragraph, renderHtml, renderText, type RenderedEmail } from "./layout";

/**
 * The daily sign-up review digest (G12) — Markii's own mail to Markii's own
 * inbox, so it goes via `sendPlatformMail`. Listed per domain with every org
 * under it, because the reader's next step is to look at those orgs, and a
 * count alone would send them to the database to find out which.
 *
 * The addresses in it are merchants' sign-up emails going to the platform's
 * support inbox — Markii's own customer data, read by Markii. Nothing here is
 * forwarded to a merchant or a third party.
 */
export type SignupReviewContext = {
  bursts: SignupBurst[];
  since: Date;
  until: Date;
  threshold: number;
  totalSignups: number;
};

const when = (d: Date) => d.toISOString().replace("T", " ").slice(0, 16) + " UTC";

export function signupReview(ctx: SignupReviewContext): RenderedEmail {
  const flagged = ctx.bursts.reduce((n, b) => n + b.count, 0);
  const summary =
    `${ctx.totalSignups} merchant sign-up${ctx.totalSignups === 1 ? "" : "s"} between ` +
    `${when(ctx.since)} and ${when(ctx.until)}. ${flagged} of them came from ` +
    `${ctx.bursts.length} domain${ctx.bursts.length === 1 ? "" : "s"} with ${ctx.threshold} or more.`;

  const tables = ctx.bursts.map((b) => {
    const rows = b.orgs
      .map(
        (o) =>
          `<tr><td style="padding:4px 8px 4px 0;font-size:13px">${esc(when(o.createdAt))}</td>` +
          `<td style="padding:4px 8px 4px 0;font-size:13px">${esc(o.email)}</td>` +
          `<td style="padding:4px 0;font-size:13px">${esc(o.name)} <span style="color:#666">(${esc(o.slug)})</span></td></tr>`,
      )
      .join("");
    return (
      `<h3 style="margin:20px 0 8px;font-size:15px">${esc(b.domain)} — ${b.count}</h3>` +
      `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse">${rows}</table>`
    );
  });

  const html = renderHtml({
    storeName: "Markii",
    heading: "Sign-ups to review",
    blocks: [
      paragraph(summary),
      paragraph(
        "This is a lead, not a verdict: an agency onboarding clients or a shared office looks " +
          "the same as a disposable-mail service. The sign-up rate limit has already refused " +
          "anything over its own ceiling; nothing here has been held or disabled.",
      ),
      ...tables,
    ],
  });

  const text = renderText([
    "Sign-ups to review",
    "",
    summary,
    "",
    "This is a lead, not a verdict. Nothing has been held or disabled.",
    "",
    ...ctx.bursts.flatMap((b) => [
      `${b.domain} — ${b.count}`,
      ...b.orgs.map((o) => `  ${when(o.createdAt)}  ${o.email}  ${o.name} (${o.slug})`),
      "",
    ]),
  ]);

  const subject =
    ctx.bursts.length === 1
      ? `Sign-ups to review: ${ctx.bursts[0].count} from ${ctx.bursts[0].domain}`
      : `Sign-ups to review: ${flagged} across ${ctx.bursts.length} domains`;

  return { subject, html, text };
}
