import { createPublicClient, erc20Abi, http, parseEventLogs, type Hash } from "viem";
import { baseSepolia } from "viem/chains";

/** Circle USDC on Base Sepolia. */
export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

/** Cents (2 decimals) → USDC base units (6 decimals). */
export function usdcUnits(amountCents: number): bigint {
  return BigInt(amountCents) * 10_000n;
}

export function buildChallenge(opts: {
  resource: string;
  description: string;
  payTo: string;
  amountCents: number;
}) {
  return {
    x402Version: 1,
    error: "X-PAYMENT header is required",
    accepts: [
      {
        scheme: "exact",
        network: "base-sepolia",
        maxAmountRequired: usdcUnits(opts.amountCents).toString(),
        resource: opts.resource,
        description: opts.description,
        mimeType: "application/json",
        payTo: opts.payTo,
        maxTimeoutSeconds: 300,
        asset: USDC_BASE_SEPOLIA,
        extra: { name: "USDC", decimals: 6 },
      },
    ],
  };
}

export type PaymentPayload = { txHash?: string; from?: string };

/** Accepts either raw JSON or base64-encoded JSON in the X-PAYMENT header. */
export function decodePaymentHeader(header: string): PaymentPayload | null {
  for (const candidate of [header, safeB64Decode(header)]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed as PaymentPayload;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function safeB64Decode(s: string): string | null {
  try {
    return Buffer.from(s, "base64").toString("utf8");
  } catch {
    return null;
  }
}

export type VerifyResult = { ok: boolean; reason?: string; from?: string };

/**
 * Settlement check: the tx must be a confirmed USDC transfer on Base Sepolia
 * paying at least `amountCents` worth of USDC to `payTo`.
 */
export async function verifyOnChain(opts: {
  txHash: string;
  payTo: string;
  amountCents: number;
}): Promise<VerifyResult> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(opts.txHash)) {
    return { ok: false, reason: "txHash is not a valid transaction hash" };
  }
  try {
    const client = createPublicClient({
      chain: baseSepolia,
      transport: http(process.env.BASE_SEPOLIA_RPC_URL),
    });
    const receipt = await client.getTransactionReceipt({ hash: opts.txHash as Hash });
    if (receipt.status !== "success") {
      return { ok: false, reason: "transaction reverted" };
    }
    const transfers = parseEventLogs({ abi: erc20Abi, logs: receipt.logs, eventName: "Transfer" });
    const required = usdcUnits(opts.amountCents);
    const match = transfers.find(
      (t) =>
        t.address.toLowerCase() === USDC_BASE_SEPOLIA.toLowerCase() &&
        t.args.to.toLowerCase() === opts.payTo.toLowerCase() &&
        t.args.value >= required,
    );
    if (!match) {
      return {
        ok: false,
        reason: `no USDC transfer of at least ${required} base units to ${opts.payTo} found in transaction`,
      };
    }
    return { ok: true, from: match.args.from };
  } catch (e) {
    return {
      ok: false,
      reason: `on-chain verification failed: ${e instanceof Error ? e.message : "unknown error"}`,
    };
  }
}
