import { redirect } from "next/navigation";
import { DashboardSidebar } from "@/components/dashboard/sidebar";
import { MobileNav } from "@/components/dashboard/mobile-nav";
import { MfaStepUpProvider } from "@/components/auth/mfa-step-up-provider";
import { loadOrError } from "@/lib/api/load";
import { mfaPathForGate } from "@/lib/api/mfa-errors";
import { getMe, getMfaStatus } from "@/lib/api/server";
import { ApiClientError } from "@/lib/api/types";

/**
 * Identity is resolved **once here** and passed down, rather than fetched by the
 * sidebar and the mobile drawer separately. Both render the same org card, and
 * two independent fetches could briefly disagree about which org is active —
 * which is exactly the thing the card exists to state unambiguously.
 *
 * MFA is checked first. Every other authenticated call answers `403` until the
 * gate is clear, so rendering the shell without this would look like a broken
 * dashboard rather than a setup step.
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Keep redirect() outside this try — Next's redirect throws, and catching it
  // would swallow the navigation and leave a merchant on a locked dashboard.
  let mfaStatus: Awaited<ReturnType<typeof getMfaStatus>> | null = null;
  try {
    mfaStatus = await getMfaStatus();
  } catch (err) {
    if (err instanceof ApiClientError && err.status === 401) {
      redirect("/sign-in");
    }
    // Other failures fall through — getMe will surface them in the shell.
  }
  if (mfaStatus?.required) {
    const path = mfaPathForGate(mfaStatus.gate);
    if (path) redirect(`${path}?next=/dashboard`);
  }

  const me = await loadOrError(() => getMe());

  return (
    <MfaStepUpProvider>
      <div className="flex min-h-dvh flex-col bg-background text-foreground lg:flex-row">
        <MobileNav me={me.data} />
        <DashboardSidebar me={me.data} />
        <main className="min-w-0 flex-1 px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-6 sm:py-8">
          {children}
        </main>
      </div>
    </MfaStepUpProvider>
  );
}
