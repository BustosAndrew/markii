import { apiGet } from "./client";
import { callWhenLive } from "./planned";

const SETUP_SECTION = "API §28";

/**
 * The first-run setup checklist (§28) — `GET /api/setup`.
 *
 * **Derived from the live store on every call.** There is nothing to mark
 * done and no "dismiss onboarding" call: a step is done when the store says
 * so, which is why a merchant who just connected Stripe sees it ticked on the
 * next fetch. Refetch after any setup action rather than updating locally.
 *
 * The assistant reads the same function (its `setup_status` tool), so a
 * checklist card and the assistant cannot disagree about what is left.
 *
 * Server components should use `getSetupStatus` from `lib/api/server`, which
 * calls the route in-process with the session cookie.
 */

const SETUP_API_LIVE = true;

export type SetupStepId =
  | "create_store"
  | "add_products"
  | "payments"
  | "shipping"
  | "tax"
  | "go_live"
  | "polish_catalog"
  | "customer_email"
  | "custom_domain"
  | "choose_plan";

/** `not_needed` is a real answer (a downloads-only store has no shipping) — render it as such, not as done. */
export type SetupStepStatus = "done" | "todo" | "not_needed";

export type SetupStep = {
  id: SetupStepId;
  /** Display copy. Varies with state — `choose_plan` reads "Update your payment method" when past due. */
  title: string;
  status: SetupStepStatus;
  /** Required to launch. Optional steps never block `readyToLaunch`; label them "Recommended". */
  required: boolean;
  /** What is true right now, in the merchant's terms. Safe to render verbatim. */
  detail: string;
  /** The dashboard page where the step is done. Always a real route. */
  href: string;
  permission: string;
  /** False → the asker's role cannot do this. Say "ask an owner or administrator"; do not link as a CTA. */
  canAct: boolean;
  /** An agent that can help — `"catalog"` → open the Catalog agent panel. */
  agent: "catalog" | "assistant" | null;
};

export type StoreSetup = {
  siteId: number;
  name: string;
  status: "draft" | "live" | "paused";
  steps: SetupStep[];
  requiredRemaining: number;
  /** Everything required except going live is done. */
  readyToLaunch: boolean;
};

export type SetupChecklist = {
  /** No store has ever gone live. Lead with setup and offer the assistant. */
  firstRun: boolean;
  /** `create_store`, then `choose_plan` (whose status follows billing standing). */
  account: SetupStep[];
  /** Only the stores the asker can reach — a store-limited staff member sees theirs. */
  stores: StoreSetup[];
  /** The one thing to do next; `siteId` null for an account step. Null when nothing is left. */
  next: { siteId: number | null; step: SetupStep } | null;
  complete: boolean;
};

export function getSetupStatus(init?: RequestInit) {
  return callWhenLive(SETUP_API_LIVE, SETUP_SECTION, () =>
    apiGet<SetupChecklist>("/api/setup", undefined, init),
  );
}
