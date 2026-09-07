import { PageHeader } from "@/components/ui/page-header";
import { SettingsSubnav } from "@/components/dashboard/settings-subnav";
import { loadOrError } from "@/lib/api/load";
import { canReadOrgAudit } from "@/lib/api/org";
import { getMe } from "@/lib/api/server";

export async function SettingsShell({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  const me = await loadOrError(() => getMe());

  return (
    <div>
      <PageHeader title={title} description={description} />
      <SettingsSubnav showAudit={canReadOrgAudit(me.data?.role)} />
      {children}
    </div>
  );
}
