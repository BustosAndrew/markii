import { getMe, listSessions } from "@/lib/api/server";
import { loadOrError } from "@/lib/api/load";
import { canWriteOrg } from "@/lib/api/org";
import { SettingsShell } from "@/components/dashboard/settings-shell";
import { EmailChangeForm } from "@/components/dashboard/email-change-form";
import { OrgNameForm } from "@/components/dashboard/org-name-form";
import { SessionsPanel } from "@/components/dashboard/sessions-panel";
import { UsernameForm } from "@/components/dashboard/username-form";
import { FetchError } from "@/components/dashboard/fetch-error";

/**
 * Settings → Account (§16).
 *
 * Personal identity and security: username, email, the caller's own devices.
 * Organization name is here too when the role can write it — it is the company
 * name, not a second username. Staff and tokens stay on Team.
 */
export default async function SettingsAccountPage() {
  const [me, sessions] = await Promise.all([
    loadOrError(() => getMe()),
    loadOrError(() => listSessions()),
  ]);

  return (
    <SettingsShell
      title="Account"
      description="Your username, login address, and the browsers you are signed in on."
    >
      <div className="space-y-6">
        <UsernameForm currentName={me.data?.user.name ?? null} />

        {me.data && canWriteOrg(me.data.role) ? (
          <OrgNameForm currentName={me.data.org.name} />
        ) : null}

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
