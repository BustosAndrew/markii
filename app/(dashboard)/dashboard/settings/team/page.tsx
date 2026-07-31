import { ComingSoon } from "@/components/ui/coming-soon";
import { SettingsShell } from "@/components/dashboard/settings-shell";

export default function SettingsTeamPage() {
  return (
    <SettingsShell
      title="Team"
      description="Organization staff, invites, roles, and org switching arrive with Phase A auth."
    >
      <ComingSoon
        title="Team management is planned"
        description="Staff lists, invites, role management, sessions, and tokens will appear here when API §16 is live."
        apiSection="API §16 · Accounts, organizations, staff"
      />
    </SettingsShell>
  );
}
