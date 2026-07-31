/**
 * Action registry — the single mutation path (`docs/API.md` §22).
 *
 * Built ahead of the site builder on purpose (`docs/BACKEND.md` §1): agent-
 * nativeness cannot be retrofitted onto a mutation layer that assumed one UI
 * caller, so Phase C's commerce mutations are defined here from their first
 * commit rather than refactored into it later.
 *
 * **Status.** The primitive is complete; there are no action definitions yet,
 * and no HTTP surface. `/api/actions*` (§22) waits for Phase A, because every
 * one of those endpoints needs an actor to authorize and there is no auth yet —
 * shipping them now would mean four routes that can only answer 401.
 *
 * Definitions live in `lib/actions/definitions/` and must be imported from this
 * barrel to register themselves.
 */

export { defineAction, getAction, allActions, describeAction } from "./registry";
export {
  setAuthorizationResolver,
  authorize,
  isAuthorizationConfigured,
  type AuthorizationResolver,
} from "./registry";
export { invokeAction, type InvokeOptions } from "./invoke";
export type {
  ActionContext,
  ActionDefinition,
  Actor,
  DiffEntry,
  InvocationOutcome,
  Permission,
  RiskTier,
} from "./types";
