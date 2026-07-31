import { ComingSoon } from "@/components/ui/coming-soon";
import { SettingsShell } from "@/components/dashboard/settings-shell";

export default function SettingsTaxPage() {
  return (
    <SettingsShell
      title="Tax"
      description="Tax configuration stays intentionally empty until the commerce settings APIs exist."
    >
      <ComingSoon
        title="Tax settings are planned"
        description="Provider configuration, nexus, and tax calculation settings arrive with commerce core."
        apiSection="API §18 · Commerce core (tax settings)"
      />
    </SettingsShell>
  );
}
