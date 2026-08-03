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
 * Staff, invites, roles, and scoped API tokens are live. **Audit and sessions
 * are not** and are shown as such rather than omitted — a team page with no
 * mention of them reads as "there is no audit log", which is a different claim
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
          title="Audit log and active sessions are not built yet"
          description="Every action is already recorded (§22 rule 5) — what is missing is the screen and the route to read it back, along with per-device session revocation."
          apiSection="API §16 · audit, sessions, MFA"
        />
      </div>
    </SettingsShell>
  );
}
