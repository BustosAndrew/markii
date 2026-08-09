import { ComingSoon } from "@/components/ui/coming-soon";
import { SettingsShell } from "@/components/dashboard/settings-shell";

export default function SettingsDomainsPage() {
  return (
    <SettingsShell
      title="Domains"
      description="Manage custom domains for your storefronts."
    >
      <ComingSoon
        title="Org-wide domain settings aren’t ready yet"
        description="You can already attach a custom domain on each website. Central domain management for the whole org will land here later."
      />
    </SettingsShell>
  );
}
