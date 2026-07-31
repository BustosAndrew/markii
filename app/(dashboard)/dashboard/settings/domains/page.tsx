import { ComingSoon } from "@/components/ui/coming-soon";
import { SettingsShell } from "@/components/dashboard/settings-shell";

export default function SettingsDomainsPage() {
  return (
    <SettingsShell
      title="Domains"
      description="Domain settings keep their place in the IA even before the org-level settings surface expands."
    >
      <ComingSoon
        title="Domain settings are partially planned"
        description="Website-level domains are already managed on each site. Centralized domain settings will expand here as the broader settings surface lands."
        apiSection="Settings shell · Website routes stay live today"
      />
    </SettingsShell>
  );
}
