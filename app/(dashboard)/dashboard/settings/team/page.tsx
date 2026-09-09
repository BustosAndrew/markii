import Link from "next/link";
import { getMe, listSites, listStaff, listTokens } from "@/lib/api/server";
import { loadOrError } from "@/lib/api/load";
import { SettingsShell } from "@/components/dashboard/settings-shell";
import { StaffPanel } from "@/components/dashboard/staff-panel";
import { TokensPanel } from "@/components/dashboard/tokens-panel";
import { FetchError } from "@/components/dashboard/fetch-error";

/**
 * Settings → Team (§16).
 *
 * Staff, invites, roles, and tokens. Sessions and email live on Account —
 * they are the signed-in user's, and listing them here would read as the
 * org's devices.
 */
export default async function SettingsTeamPage() {
  const [me, staff, tokens, sites] = await Promise.all([
    loadOrError(() => getMe()),
    loadOrError(() => listStaff()),
    loadOrError(() => listTokens()),
    loadOrError(() => listSites({ limit: 100 })),
  ]);

  const seatLimit = me.data?.entitlements.staffSeatLimit ?? null;
  const siteOptions = (sites.data?.items ?? []).map((s) => ({ id: s.id, name: s.name }));

  return (
    <SettingsShell
      title="Team"
      description="Who can act in this organization, and which machine credentials can act on its behalf."
    >
      <div className="space-y-6">
        {!staff.data ? (
          <FetchError message={staff.error ?? "Staff could not be loaded."} />
        ) : (
          <StaffPanel
            staff={staff.data.items}
            seatLimit={seatLimit}
            currentUserId={me.data?.user.id ?? null}
          />
        )}

        {!tokens.data ? (
          <FetchError
            title="API tokens unavailable"
            message={tokens.error ?? "Tokens could not be loaded."}
          />
        ) : (
          <TokensPanel tokens={tokens.data.items} sites={siteOptions} />
        )}

        <p className="text-sm leading-6 text-muted">
          Your signed-in browsers are on{" "}
          <Link
            href="/dashboard/settings/account"
            className="font-medium text-foreground underline-offset-2 hover:underline"
          >
            Account
          </Link>
          , because they are yours — not the organization&apos;s.
        </p>
      </div>
    </SettingsShell>
  );
}
