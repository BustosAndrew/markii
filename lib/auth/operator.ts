import "server-only";

import { ApiError, forbidden } from "@/lib/api";
import type { Actor } from "@/lib/actions/types";
import { requestContextFrom } from "./request-context";
import { requireSession, type Session } from "./session";

/**
 * Platform operators (G12) — the people at Markii who may act on a merchant's
 * org: today, suspend and reinstate it.
 *
 * **Identified by a signed-in staff session on an email allowlist**, and each
 * half is doing work:
 *
 * - *A session*, so MFA applies (`getSession` enforces it, D40) and step-up
 *   applies (`platform.*` actions demand a fresh factor). Not a shared secret
 *   like `CRON_SECRET`: a secret cannot say *who* suspended a store, and the
 *   audit row must. Not an API token: tokens are org-scoped and MFA-exempt,
 *   which is the wrong shape for the most powerful thing anyone can do here.
 * - *An allowlist*, `PLATFORM_OPERATOR_EMAILS`, because nothing in the data
 *   model says "works at Markii" — every staff row is a merchant's. It is a
 *   list of addresses, or `@domain` entries meaning anyone whose verified
 *   address is at that host. **Unset, nobody is an operator** (D41: refuse
 *   rather than run open), and the refusal says so in the log.
 *
 * The operator's own org is irrelevant to what they do here: `operatorActorFor`
 * mints an `operator` actor whose `orgId` is the **target** org, which is how
 * the action registry scopes the write and the audit row lands in the
 * merchant's own log as "Markii operator".
 */

export type Operator = { session: Session; email: string };

export type OperatorAllowlist = { emails: Set<string>; domains: Set<string> };

/** Parse `PLATFORM_OPERATOR_EMAILS`. Null when unset or empty — nobody. */
export function parseOperatorAllowlist(raw: string | undefined): OperatorAllowlist | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const emails = new Set<string>();
  const domains = new Set<string>();
  for (const entry of trimmed.split(",")) {
    const v = entry.trim().toLowerCase();
    if (!v) continue;
    if (v.startsWith("@")) domains.add(v.slice(1));
    else emails.add(v);
  }
  return emails.size || domains.size ? { emails, domains } : null;
}

/** Pure: is this address on the list? */
export function isOperatorEmail(
  email: string | null | undefined,
  list: OperatorAllowlist | null,
): boolean {
  if (!list || !email) return false;
  const e = email.trim().toLowerCase();
  if (list.emails.has(e)) return true;
  const at = e.lastIndexOf("@");
  return at > 0 && list.domains.has(e.slice(at + 1));
}

/**
 * The signed-in caller as an operator, or a refusal.
 *
 * **403 for a non-operator, not 404.** The caller is already an authenticated
 * merchant; pretending the route does not exist protects nothing they could
 * not read in this repository, and a 404 would send a real operator with a
 * mistyped allowlist entry hunting for a routing bug.
 *
 * **503 `CONFIGURATION_REQUIRED` when the allowlist is unset**, the same
 * status `lib/cron/auth.ts` answers for a missing `CRON_SECRET` — it is a
 * deployment fact, not the caller's fault, and the log line names the fix.
 */
export async function requireOperator(): Promise<Operator> {
  const session = await requireSession();
  const list = parseOperatorAllowlist(process.env.PLATFORM_OPERATOR_EMAILS);
  if (!list) {
    console.error(
      "[operator] refused: PLATFORM_OPERATOR_EMAILS is unset, so no account is a platform operator.",
    );
    throw new ApiError(
      "CONFIGURATION_REQUIRED",
      503,
      "Platform operations are not configured on this deployment.",
      { resolution: "Set PLATFORM_OPERATOR_EMAILS to the operator addresses (or @domain entries)." },
    );
  }
  if (!isOperatorEmail(session.user.email, list)) {
    throw forbidden("This account is not a platform operator.");
  }
  return { session, email: session.user.email!.trim().toLowerCase() };
}

/**
 * The actor for a platform action against `targetOrgId`. Carries the request
 * context like every other HTTP-minted actor, so the audit row records where
 * the suspension was issued from.
 */
export function operatorActorFor(op: Operator, targetOrgId: string, req: Request): Actor {
  return {
    type: "operator",
    id: op.session.user.id,
    orgId: targetOrgId,
    request: requestContextFrom(req),
  };
}
