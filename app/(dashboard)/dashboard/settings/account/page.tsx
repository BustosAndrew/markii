import { getMe, listSessions } from "@/lib/api/server";
import { loadOrError } from "@/lib/api/load";
import { SettingsShell } from "@/components/dashboard/settings-shell";
import { EmailChangeForm } from "@/components/dashboard/email-change-form";
import { SessionsPanel } from "@/components/dashboard/sessions-panel";
import { FetchError } from "@/components/dashboard/fetch-error";

/**
 * Settings → Account (§16).
 *
 * Personal security, not org administration: email change and the caller's own
 * devices. Every role can reach this page. Staff and tokens stay on Team.
 */
export default async function SettingsAccountPage() {
  const [me, sessions] = await Promise.all([
    loadOrError(() => getMe()),
    loadOrError(() => listSessions()),
  ]);

  return (
    <SettingsShell
      title="Account"
      description="The address on your login, and the browsers you are signed in on."
    >
      <div className="space-y-6">
        <EmailChangeForm currentEmail={me.data?.user.email ?? null} />

        {!sessions.data ? (
          <FetchError
            title="Sessions unavailable"
            message={sessions.error ?? "Signed-in devices could not be loaded."}
          />
        ) : (
          <SessionsPanel sessions={sessions.data.items} />
        )}
      </div>
    </SettingsShell>
  );
}
