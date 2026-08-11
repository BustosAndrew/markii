import { invokeAction } from "./actions";
import { apiGet } from "./client";
import { callWhenLive } from "./planned";
import { ApiClientError } from "./types";

const DELIVERY_SECTION = "API §18.8";

/**
 * Digital delivery — the files a merchant sells (§18.8).
 *
 * **This service was missing entirely until 2026-08-10, and that was the gap
 * worth finding.** Every piece of §18.8 has been built and passing on the
 * backend for weeks: upload, attach, download policy, signed per-purchase URLs,
 * reissue, revoke. None of it had a typed client, so no screen could reach any
 * of it — a merchant could not upload a file, attach one to a product, or set a
 * download limit. `docs/DECISIONS.md` D5 names creators and digital-goods
 * sellers as the **beachhead segment**, so this was the launch feature for the
 * launch audience, reachable from nowhere.
 *
 * It is the same failure CLAUDE.md records as having happened once before —
 * "endpoints were live and reachable from no screen" — recurring somewhere
 * nobody had looked, because `docs/API.md` marked §18.8 live and the badge was
 * telling the truth about the backend.
 *
 * **The split between route and action is deliberate and load-bearing.** Bytes
 * go to `POST /api/digital-assets` because an action writes its input to an
 * audit table, and a 2 GB course file base64'd into a JSON audit row is absurd.
 * Everything a merchant then *does* with an asset is an action (§22 rule 1).
 */

const DELIVERY_API_LIVE = true;

/**
 * **No `url` field, and it is not an oversight.** The bucket is private; a
 * durable address for a paid file is one leak away from being the product.
 * Shoppers get a short-lived signed URL minted per paid download instead.
 */
export type DigitalAsset = {
  id: number;
  orgId: string;
  siteId: number | null;
  storagePath: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  label: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Advisory only — G5's quotas are proposed and nothing blocks on them. */
export type MediaUsage = {
  storageBytes: number;
  storageLimitBytes: number | null;
  egressBytes: number;
  egressLimitBytes: number | null;
};

export type DigitalAssetList = {
  items: DigitalAsset[];
  total: number;
  page: number;
  limit: number;
  usage: MediaUsage;
};

export function listDigitalAssets(
  params: { siteId?: number; page?: number; limit?: number } = {},
  init?: RequestInit,
) {
  return callWhenLive(DELIVERY_API_LIVE, DELIVERY_SECTION, () =>
    apiGet<DigitalAssetList>("/api/digital-assets", params, init),
  );
}

/**
 * Uploads a file a merchant sells.
 *
 * `FormData`, not JSON, and **not** `invokeAction` — see the module note. The
 * response carries the asset row plus refreshed usage, so a screen can show the
 * new total without a second request.
 *
 * Deliberately **no client-side type allowlist**, unlike `uploadProductImage`:
 * a merchant may sell any file type, and guessing a list here would block a
 * legitimate product with a client-side rule the server never asked for. Size
 * is left to the server too, since the ceiling is a plan entitlement rather
 * than a constant.
 */
export async function uploadDigitalAsset(
  file: File,
  opts: { siteId?: number; label?: string } = {},
  init?: RequestInit,
): Promise<DigitalAsset & { usage: MediaUsage }> {
  const form = new FormData();
  form.append("file", file);
  if (opts.siteId != null) form.append("siteId", String(opts.siteId));
  if (opts.label) form.append("label", opts.label);

  const res = await fetch("/api/digital-assets", { ...init, method: "POST", body: form });

  if (!res.ok) {
    let code = "INTERNAL";
    let message = res.statusText || "Upload failed";
    try {
      const body = await res.json();
      code = body?.error?.code ?? code;
      message = body?.error?.message ?? message;
    } catch {
      // Non-JSON body — keep the status text.
    }
    /**
     * `503 CONFIGURATION_REQUIRED` reaches the caller intact rather than being
     * flattened into a generic failure: Supabase Storage being unconfigured is
     * an operator's problem, and `isConfigurationRequired` is how a screen tells
     * that apart from "not built yet" (`./planned`).
     */
    throw new ApiClientError(res.status, code, message);
  }

  return (await res.json()) as DigitalAsset & { usage: MediaUsage };
}

/** Makes an uploaded asset part of what a product delivers. Undoable. */
export function attachAsset(
  body: { productId: number; assetId: number; variantId?: number | null; position?: number },
  init?: RequestInit,
) {
  return invokeAction("delivery.attachAsset", body, init);
}

/** Removes the attachment, not the file — the asset stays for other products. */
export function detachAsset(body: { attachmentId: number }, init?: RequestInit) {
  return invokeAction("delivery.detachAsset", body, init);
}

/**
 * Deletes the underlying file.
 *
 * Distinct from detaching, and the more serious of the two: buyers who already
 * paid hold grants against this asset. Worth a confirmation step that says so.
 */
export function deleteAsset(body: { assetId: number }, init?: RequestInit) {
  return invokeAction("delivery.deleteAsset", body, init);
}

/**
 * How many times, and for how long, a buyer may download.
 *
 * `null` on either field means unlimited — not "unset". Render it as unlimited
 * rather than as an empty input, or a merchant will read a blank box as a value
 * they still need to supply.
 */
export function setDownloadPolicy(
  body: {
    productId: number;
    downloadLimit: number | null;
    downloadExpiryDays: number | null;
  },
  init?: RequestInit,
) {
  return invokeAction("delivery.setDownloadPolicy", body, init);
}

/**
 * Gives a buyer their download back — the support path.
 *
 * The common case is someone who hit their limit or let it expire through no
 * fault of their own. `unrevoke` is separate and deliberate: reinstating access
 * a merchant deliberately took away should be an explicit choice, not a
 * side effect of resetting a counter.
 */
export function reissueDownload(
  body: { grantId: number; resetCount?: boolean; extendDays?: number; unrevoke?: boolean },
  init?: RequestInit,
) {
  return invokeAction("delivery.reissueDownload", body, init);
}

/** Takes access away. `reason` is required — it is what the audit row explains. */
export function revokeDownload(body: { grantId: number; reason: string }, init?: RequestInit) {
  return invokeAction("delivery.revokeDownload", body, init);
}
