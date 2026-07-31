import { ComingSoon } from "@/components/ui/coming-soon";
import { SettingsShell } from "@/components/dashboard/settings-shell";

export default function SettingsShippingPage() {
  return (
    <SettingsShell
      title="Shipping"
      description="Shipping zones and rates will live here once human checkout and commerce settings are built."
    >
      <ComingSoon
        title="Shipping settings are planned"
        description="Shipping zones, rates, and checkout-related configuration arrive with commerce core."
        apiSection="API §18 · Commerce core (shipping settings)"
      />
    </SettingsShell>
  );
}
