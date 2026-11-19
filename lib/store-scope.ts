import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-store scoping (`staff.storeIds`, `api_tokens.store_ids`), carried with
 * the request rather than threaded through every call.
 *
 * `siteScope` and `ownSites` (`lib/tenancy.ts`) intersect with this, so every
 * org check that already exists also narrows to the caller's stores — the
 * same "make the unscoped query impossible to write" rule tenancy follows.
 * Before this, per-store scoping was applied only where a list route
 * remembered `siteScopeForStaff`, and **no registry action and no
 * single-item route honoured it at all**: a member scoped to store A could
 * read, edit and delete store B's products, orders, discounts and pages.
 *
 * Two places set it, and both resolve it from the caller's own record:
 * `orgHandler` from the auth context, and `invokeAction` from the staff or
 * token row (`resolveStoreScope`), never from anything the caller sends.
 *
 * **Absent means "all"** — the scheduled jobs, storefront rendering, seeds and
 * webhooks have no staff member behind them, and narrowing them would break
 * them. That default is what every caller had before this existed, so code
 * that never enters a scope behaves exactly as it did.
 */
export type StoreIds = number[] | "all";

/**
 * On `globalThis` so that two copies of this module — which `next dev` can
 * create per route (see `lib/actions/registry.ts`) — share one store. Sharing
 * is safe here because the value is plain data, unlike the registry's classes.
 */
const KEY = Symbol.for("markii.storeScope");
const storage: AsyncLocalStorage<StoreIds> = ((globalThis as Record<symbol, unknown>)[KEY] ??=
  new AsyncLocalStorage<StoreIds>()) as AsyncLocalStorage<StoreIds>;

export function withStoreScope<T>(storeIds: StoreIds, fn: () => T): T {
  return storage.run(storeIds, fn);
}

/** The stores the current caller may reach, or `"all"` outside any scope. */
export function currentStoreScope(): StoreIds {
  return storage.getStore() ?? "all";
}
