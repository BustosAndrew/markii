import "server-only";

import { generateAgentMd, generateLlmsTxt } from "./generators";
import { defaultWallet } from "./integrations";
import type { SiteData } from "./storefront";

/**
 * The two agent-facing documents a storefront publishes, rendered from one
 * place.
 *
 * They used to be assembled inline in their own route handlers, which was fine
 * while those routes were the only caller. The MCP `markii://site/{slug}/…`
 * resources are a second one, and the options are the part that would drift:
 * `agent.md` needs the payout address resolved through `defaultWallet`, and both
 * need the site's enabled rails and whether purchases are on. A resource that
 * quietly rendered without them would show a merchant a document their store
 * does not serve — which is the failure mode worth designing out, because it
 * looks correct.
 *
 * **Neither function logs traffic**, and the routes still do. An agent crawl is
 * an event that happened; a merchant reading their own store's document through
 * MCP is not one, and counting it would inflate the analytics the merchant uses
 * to judge whether agents find them at all.
 */

export function renderLlmsTxt(data: SiteData): string {
  return generateLlmsTxt(data.bundle, data.baseUrl, {
    rails: data.site.paymentProviders,
    purchasesEnabled: data.site.purchasesEnabled,
  });
}

export async function renderAgentMd(data: SiteData): Promise<string> {
  const payTo = data.site.walletAddress ?? (await defaultWallet(data.site.orgId));
  return generateAgentMd(data.bundle, data.baseUrl, {
    payTo,
    rails: data.site.paymentProviders,
    purchasesEnabled: data.site.purchasesEnabled,
  });
}
