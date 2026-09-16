import { redirect } from "next/navigation";
import { AdminShell } from "@/components/admin/admin-shell";
import { MfaStepUpProvider } from "@/components/auth/mfa-step-up-provider";
import { EmptyState } from "@/components/ui/empty-state";
import { ButtonLink } from "@/components/ui/button";
import { loadOrError } from "@/lib/api/load";
import { mfaPathForGate } from "@/lib/api/mfa-errors";
import { getMe, getMfaStatus } from "@/lib/api/server";
import { ApiClientError } from "@/lib/api/types";

export const dynamic = "force-dynamic";

/**
 * The platform operator area (G12, `docs/API.md` §26).
 *
 * Same gate order as the merchant dashboard — sign-in, then MFA — and then
 * one more: `me.operator`, which is the `PLATFORM_OPERATOR_EMAILS` allowlist
 * as `/api/me` reports it. A signed-in merchant who is not on it sees a plain
 * page saying so rather than a redirect, because a redirect would look like
 * a broken link to the one person who *should* be here with a mistyped
 * allowlist entry. The shell renders nothing of the admin surface for them.
 *
 * `me.operator` only decides what to render; every `/api/admin/*` call the
 * pages make re-checks the list itself.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  let mfaStatus: Awaited<ReturnType<typeof getMfaStatus>> | null = null;
  try {
    mfaStatus = await getMfaStatus();
  } catch (err) {
    if (err instanceof ApiClientError && err.status === 401) redirect("/sign-in?next=/admin");
  }
  if (mfaStatus?.required) {
    const path = mfaPathForGate(mfaStatus.gate);
    if (path) redirect(`${path}?next=/admin`);
  }

  const me = await loadOrError(() => getMe());

  if (!me.data?.operator) {
    return (
      <MfaStepUpProvider>
        <AdminShell me={me.data}>
          <EmptyState
            title="This account is not a platform operator"
            description={
              me.error ??
              "Operators are the addresses in PLATFORM_OPERATOR_EMAILS on this deployment. " +
                "Nothing here is available to a merchant account."
            }
            action={<ButtonLink href="/dashboard" variant="secondary">Back to dashboard</ButtonLink>}
          />
        </AdminShell>
      </MfaStepUpProvider>
    );
  }

  return (
    <MfaStepUpProvider>
      <AdminShell me={me.data}>{children}</AdminShell>
    </MfaStepUpProvider>
  );
}
