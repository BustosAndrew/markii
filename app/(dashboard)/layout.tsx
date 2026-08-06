import { DashboardSidebar } from "@/components/dashboard/sidebar";
import { MobileNav } from "@/components/dashboard/mobile-nav";
import { loadOrError } from "@/lib/api/load";
import { getMe } from "@/lib/api/server";

/**
 * Identity is resolved **once here** and passed down, rather than fetched by the
 * sidebar and the mobile drawer separately. Both render the same org card, and
 * two independent fetches could briefly disagree about which org is active —
 * which is exactly the thing the card exists to state unambiguously.
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const me = await loadOrError(() => getMe());

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground lg:flex-row">
      <MobileNav me={me.data} />
      <DashboardSidebar me={me.data} />
      <main className="min-w-0 flex-1 px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-6 sm:py-8">
        {children}
      </main>
    </div>
  );
}
