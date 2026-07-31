import { PageHeader } from "@/components/ui/page-header";
import { SettingsSubnav } from "@/components/dashboard/settings-subnav";

export function SettingsShell({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <PageHeader title={title} description={description} />
      <SettingsSubnav />
      {children}
    </div>
  );
}
