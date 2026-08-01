/**
 * Action registry — the single mutation path (`docs/API.md` §22).
 *
 * Built ahead of the site builder on purpose (`docs/BACKEND.md` §1): agent-
 * nativeness cannot be retrofitted onto a mutation layer that assumed one UI
 * caller, so Phase C's commerce mutations are defined here from their first
 * commit rather than refactored into it later.
 *
 * **Status.** The primitive is complete and the first Phase C mutations are
 * defined against it (`definitions/catalog.ts`, `definitions/inventory.ts`).
 * Authorization is installed by `./authorization`, which resolves staff and
 * token callers identically (§22 rule 4).
 *
 * Definitions live in `lib/actions/definitions/` and **must be imported here**
 * to register themselves — an action nobody imports does not exist.
 */

// Side-effect imports: registration happens at module load.
import "./authorization";
import "./definitions/catalog";
import "./definitions/inventory";
import "./definitions/collections";
import "./definitions/customers";
import "./definitions/shipping";

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
