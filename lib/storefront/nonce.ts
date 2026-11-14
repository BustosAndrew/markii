import "server-only";

import { headers } from "next/headers";

/**
 * This request's CSP nonce, set by `proxy.ts` (`lib/storefront/csp.ts`).
 * Every script a storefront server component renders itself — the preview
 * bridge, the merchant's head code — carries it, or the policy blocks it.
 * Undefined when the policy is off (`STOREFRONT_CSP=off`), and a script without
 * a nonce attribute then runs as it always did.
 */
export async function requestNonce(): Promise<string | undefined> {
  return (await headers()).get("x-nonce") ?? undefined;
}
