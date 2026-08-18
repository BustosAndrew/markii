import type { EmailSettings } from "@/lib/api/email";
import { isPlannedError } from "@/lib/api/planned";
// In-process, so the session cookie is inherited rather than dropped — see lib/api/server.ts.
import { getEmailSettings } from "@/lib/api/server";
import { EmailDomains } from "@/components/dashboard/email-domains";
import { EmailSuppressions } from "@/components/dashboard/email-suppressions";
import { Badge } from "@/components/ui/badge";
import { ComingSoon } from "@/components/ui/coming-soon";
import { SettingsShell } from "@/components/dashboard/settings-shell";

/**
 * Settings → Email (§24).
 *
 * The screen `lib/email/` already tells merchants to visit: "Verify a sending
 * domain in Settings → Email." Until this existed, that instruction pointed at
 * nothing.
 *
 * **The two streams are shown separately and never merged into one "email: OK".**
 * Resend carries Markii's own mail; SES carries the merchant's, from their own
 * domain. A merchant whose password reset arrived would otherwise reasonably
 * conclude their order confirmations work, and they do not.
 */
export default async function SettingsEmailPage() {
  let data: EmailSettings | null = null;
  let planned = false;
  let error: string | null = null;

  try {
    data = await getEmailSettings();
  } catch (caught) {
    if (isPlannedError(caught)) {
      planned = true;
    } else if (caught instanceof Error) {
      error = caught.message;
    } else {
      error = "Email settings could not be loaded.";
    }
  }

  if (!data) {
    // A planned section and a real failure are different facts; only one is ours to fix.
    return (
      <SettingsShell title="Email" description={DESCRIPTION}>
        {planned ? (
          <ComingSoon
            title="Email settings aren’t available yet"
            description="Sending domains, deliverability, and the suppression list will appear here when email is connected."
          />
        ) : (
          <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
            <h2 className="text-base font-medium text-foreground">Email settings</h2>
            <p className="mt-2 text-sm leading-6 text-muted">{error}</p>
          </section>
        )}
      </SettingsShell>
    );
  }

  return (
    <SettingsShell title="Email" description={DESCRIPTION}>
      <div className="space-y-6">
        <CustomerEmailCard settings={data} />
        <EmailDomains
          domains={data.domains}
          providerConfigured={data.providerConfigured}
        />
        <EmailSuppressions suppressions={data.suppressions} />
        <PlatformEmailCard platform={data.platformEmail} />
      </div>
    </SettingsShell>
  );
}

const DESCRIPTION =
  "Customer email is sent from your own verified domain when you have one. Until then it " +
  "sends from each storefront’s Markii address — never from markii.shop itself.";

/**
 * `code` answers **whether mail is going out, and from whose address**.
 *
 * `configuration_required` is Markii's problem (no AWS credentials here) and
 * nothing the merchant does will help. `unverified_sender` means mail **is**
 * sending, from the storefront's Markii address, and verifying their own domain
 * is an improvement rather than a repair (D44) — so it is not an error state and
 * must not be badged as one.
 */
function CustomerEmailCard({ settings }: { settings: EmailSettings }) {
  const { customerEmail, providerConfigured, fallbackSender } = settings;

  return (
    <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-medium text-foreground">Customer email</h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            Order confirmations, shipping and refund notices, cancellations, and digital delivery.
          </p>
        </div>
        {/*
          Three states, not two. "Sending, unverified" is the common one before a
          merchant sets up their domain, and calling it "Not sending" would be
          false — their customers are receiving mail.
        */}
        <Badge
          variant={
            customerEmail.code === "ready"
              ? "success"
              : customerEmail.canSend
                ? "info"
                : "warning"
          }
        >
          {customerEmail.code === "ready"
            ? "Sending"
            : customerEmail.canSend
              ? "Sending — unverified"
              : "Not sending"}
        </Badge>
      </div>

      <p className="mt-4 text-sm leading-6 text-foreground">{customerEmail.message}</p>

      {customerEmail.senderAddress ? (
        <p className="mt-2 text-sm text-muted">
          From <span className="font-medium text-foreground">{customerEmail.senderAddress}</span>
        </p>
      ) : null}

      {!providerConfigured ? (
        <p className="mt-4 rounded-[var(--radius-control)] bg-warning-bg px-3 py-2 text-sm leading-6 text-warning-text">
          Email is not connected on this deployment, so nothing below can send yet regardless of
          your DNS. Attempts are recorded rather than silently dropped, and appear on the order
          timeline as <span className="font-medium">email failed</span>.
        </p>
      ) : null}

      {!fallbackSender.ok ? (
        <p className="mt-4 rounded-[var(--radius-control)] bg-warning-bg px-3 py-2 text-sm leading-6 text-warning-text">
          {fallbackSender.problem ??
            "The shared storefront sender is not sending. This is a Markii incident, not something you can fix by verifying a domain."}
        </p>
      ) : null}
    </section>
  );
}

/**
 * Reported separately and deliberately last: this is Markii's mail *to the
 * merchant*, and it working says nothing about whether their customers hear
 * from them.
 */
function PlatformEmailCard({ platform }: { platform: EmailSettings["platformEmail"] }) {
  const ready = platform.status === "ready";

  return (
    <section className="rounded-[var(--radius-card)] border border-border bg-surface p-5 shadow-[var(--shadow-sm)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-medium text-foreground">Markii’s email to you</h2>
          <p className="mt-1 text-sm leading-6 text-muted">{platform.scope}</p>
        </div>
        <Badge variant={ready ? "success" : "neutral"}>
          {ready ? "Ready" : "Configuration required"}
        </Badge>
      </div>
      <p className="mt-4 text-sm leading-6 text-muted">
        This is a separate stream from your customer email above. One working does not mean the
        other does.
      </p>
    </section>
  );
}
