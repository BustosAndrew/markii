import { getMe, listSites, listStaff, listTokens } from "@/lib/api/server";
import { loadOrError } from "@/lib/api/load";
import { SettingsShell } from "@/components/dashboard/settings-shell";
import { StaffPanel } from "@/components/dashboard/staff-panel";
import { TokensPanel } from "@/components/dashboard/tokens-panel";
import { ComingSoon } from "@/components/ui/coming-soon";
import { FetchError } from "@/components/dashboard/fetch-error";

/**
 * Settings → Team (§16).
 *
 * Staff, invites, roles, tokens, and the audit log are live. **Sessions are
 * not** — shown as such rather than omitted, because a team page with no
 * mention of them reads as "there are no sessions", which is a different claim
 * from "it is not built yet".
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

        <ComingSoon
          title="Sessions aren’t ready yet"
          description="Per-device session management will appear here when it is built. Sign out from the sidebar ends this session."
        />
      </div>
    </SettingsShell>
  );
}
