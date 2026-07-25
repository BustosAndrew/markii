import { agentTraffic, db } from "@/lib/db";

const AGENT_PATTERNS: [RegExp, string][] = [
  [/claude|anthropic/i, "Claude"],
  [/gptbot|openai|chatgpt/i, "GPTBot"],
  [/perplexity/i, "PerplexityBot"],
  [/gemini|google-extended|googleother/i, "Gemini"],
  [/googlebot/i, "Googlebot"],
  [/bingbot|copilot/i, "Bingbot"],
  [/x402|agent/i, "Agent"],
];

export function parseAgentName(userAgent: string | null | undefined): string {
  if (!userAgent) return "Other";
  for (const [re, name] of AGENT_PATTERNS) if (re.test(userAgent)) return name;
  return "Other";
}

/** Records a storefront hit. Never throws — analytics must not break rendering. */
export async function logTraffic(opts: {
  siteId: number;
  path: string;
  userAgent: string | null | undefined;
  productId?: number | null;
}): Promise<void> {
  try {
    await db.insert(agentTraffic).values({
      siteId: opts.siteId,
      productId: opts.productId ?? null,
      path: opts.path,
      agentUserAgent: opts.userAgent ?? "",
      agentName: parseAgentName(opts.userAgent),
    });
  } catch (e) {
    console.error("traffic log failed", e);
  }
}
