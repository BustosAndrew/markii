import "server-only";

import { createHash } from "node:crypto";
import { ApiError } from "@/lib/api";
import { PUBLIC_BUCKET, downloadFile, publicMediaPathOf, publicMediaUrl, uploadFile } from "@/lib/storage";
import {
  ASSET_REF,
  ASSET_TYPES,
  PACKAGE_LIMITS,
  imageRefs,
  mapImages,
  themePackageSchema,
  type ImageRef,
  type ThemeFile,
  type ThemePackage,
} from "./theme-package";

/**
 * A theme package's images, carried inside the file (D53).
 *
 * **Export** copies every image that is the store's own upload — a
 * `public-media` object under the org's prefix — into the file and rewrites
 * each reference to `asset:{sha256}`. Images hosted anywhere else, another
 * org's uploads included, stay as links and are reported, because they are
 * not the store's to hand over.
 *
 * **Import** checks each image is what it claims (the hash, the size, the file
 * signature), stores it at `{orgId}/theme-assets/{sha256}.{ext}` in the
 * importing org's `public-media`, and rewrites the tokens to those URLs. The
 * path is the content, so importing the same theme twice stores each image
 * once, and a refused import leaves files a retry simply reuses.
 *
 * **Storage quota is not consulted**, and that is G5, not an omission: the
 * quota meters the files a merchant *sells* (`digital_assets`); public images
 * are uncounted by design (`lib/commerce/media-usage.ts`). A package is bounded
 * by {@link PACKAGE_LIMITS} instead — 100 images, 5 MB each, 25 MB in all.
 *
 * Image rights belong to the image's owner or creator (D53); Markii does not
 * clear them.
 */

export type ImageReport = {
  /** Images carried in the file, or stored by an import. */
  bundled: number;
  bytes: number;
  /** References left as links: hosted outside the store's own uploads. */
  external: ImageRef[];
  /** The store's own uploads that could not be read, left as links. */
  unreadable: ImageRef[];
};

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The file really is the image type it claims — checked on the bytes, never the label. */
function signatureMatches(bytes: Uint8Array, contentType: string): boolean {
  const at = (i: number, ...b: number[]) => b.every((v, k) => bytes[i + k] === v);
  if (contentType === "image/png") return at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (contentType === "image/jpeg") return at(0, 0xff, 0xd8, 0xff);
  if (contentType === "image/webp") return at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50);
  return false;
}

function sniffType(bytes: Uint8Array): string | null {
  for (const t of Object.keys(ASSET_TYPES)) if (signatureMatches(bytes, t)) return t;
  return null;
}

function tooLarge(message: string): ApiError {
  return new ApiError("CONFLICT", 409, message, {
    reason: "package_too_large",
    limits: PACKAGE_LIMITS,
  });
}

/** The store's own upload behind a URL, or null. Another org's upload is not the store's own. */
export function ownImagePath(url: string, orgId: string): string | null {
  const path = publicMediaPathOf(url);
  return path && path.startsWith(`${orgId}/`) ? path : null;
}

/** Export: the package as a file, with the store's own images inside it. */
export async function bundleImages(pkg: ThemePackage, orgId: string): Promise<{ file: ThemeFile; report: ImageReport }> {
  const refs = imageRefs(pkg);
  const tokenFor = new Map<string, string>();
  const assets: ThemeFile["assets"] = [];
  const external: ImageRef[] = [];
  const unreadable: ImageRef[] = [];
  const seenHash = new Set<string>();
  let bytes = 0;

  for (const ref of refs) {
    if (tokenFor.has(ref.url)) continue;
    const path = ownImagePath(ref.url, orgId);
    if (!path) {
      external.push(ref);
      continue;
    }
    const got = await downloadFile(PUBLIC_BUCKET, path);
    const type = got.ok ? sniffType(got.bytes) : null;
    if (!got.ok || !type || got.bytes.length > PACKAGE_LIMITS.maxAssetBytes) {
      unreadable.push(ref);
      continue;
    }
    const hash = sha256(got.bytes);
    tokenFor.set(ref.url, `asset:${hash}`);
    if (seenHash.has(hash)) continue;
    seenHash.add(hash);
    bytes += got.bytes.length;
    if (assets.length + 1 > PACKAGE_LIMITS.maxAssets) throw tooLarge(`A theme package carries at most ${PACKAGE_LIMITS.maxAssets} images.`);
    if (bytes > PACKAGE_LIMITS.maxTotalAssetBytes) throw tooLarge("This design's images come to more than 25 MB, more than a theme package carries.");
    assets.push({ hash, contentType: type, data: Buffer.from(got.bytes).toString("base64") });
  }

  const mapped = mapImages(pkg, (url) => tokenFor.get(url) ?? url);
  return {
    file: { ...mapped, assets },
    report: { bundled: assets.length, bytes, external, unreadable },
  };
}

/**
 * Import: check and store a file's images in the importing org, and return the
 * package with every `asset:` token replaced by its new URL — the form
 * `builder.importTheme` accepts. With `store: false` (a dry run) nothing is
 * uploaded; the URLs are the same ones, because the path is the content.
 */
export async function unbundleImages(
  file: ThemeFile,
  orgId: string,
  opts: { store: boolean },
): Promise<{ pkg: ThemePackage; report: ImageReport }> {
  const urlFor = new Map<string, string>();
  let bytes = 0;
  for (const asset of file.assets) {
    const data = Buffer.from(asset.data, "base64");
    if (data.length > PACKAGE_LIMITS.maxAssetBytes) throw tooLarge("An image in this theme package is larger than 5 MB.");
    bytes += data.length;
    if (bytes > PACKAGE_LIMITS.maxTotalAssetBytes) throw tooLarge("This theme package's images come to more than 25 MB.");
    if (sha256(data) !== asset.hash) {
      throw new ApiError("VALIDATION_ERROR", 400, "An image in this theme package does not match its checksum; the file is damaged or was edited.", {
        reason: "asset_hash_mismatch",
        hash: asset.hash,
      });
    }
    if (!signatureMatches(data, asset.contentType)) {
      throw new ApiError("VALIDATION_ERROR", 400, `An image in this theme package is not the ${asset.contentType} it claims to be.`, {
        reason: "asset_type_mismatch",
        hash: asset.hash,
      });
    }
    const path = `${orgId}/theme-assets/${asset.hash}.${ASSET_TYPES[asset.contentType]}`;
    const url = publicMediaUrl(path);
    if (!url) throw configurationRequired();
    if (opts.store) {
      const put = await uploadFile({ bucket: PUBLIC_BUCKET, path, body: data, contentType: asset.contentType });
      if (!put.ok && put.code === "configuration_required") throw configurationRequired();
      if (!put.ok && put.code !== "already_exists") {
        throw new ApiError("UPSTREAM_ERROR", 502, "An image in this theme package could not be stored. Nothing was imported; try again.", {
          reason: put.code,
        });
      }
    }
    urlFor.set(`asset:${asset.hash}`, url);
  }

  const missing: ImageRef[] = [];
  const rest = { theme: file.theme, documents: file.documents, savedBlocks: file.savedBlocks, format: file.format, version: file.version, ...(file.name ? { name: file.name } : {}) };
  const mapped = mapImages(rest, (url, ref) => {
    if (!ASSET_REF.test(url)) return url;
    const next = urlFor.get(url);
    if (!next) missing.push({ url, ...ref });
    return next ?? url;
  });
  if (missing.length) {
    throw new ApiError("VALIDATION_ERROR", 400, "This theme package refers to images it does not carry.", {
      reason: "asset_missing",
      where: missing.map((m) => m.where),
    });
  }

  const parsed = themePackageSchema.safeParse(mapped);
  if (!parsed.success) {
    throw new ApiError("VALIDATION_ERROR", 400, "This theme package is not valid once its images are resolved.", {
      reason: "invalid_package",
      issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  const external = imageRefs(parsed.data).filter((r) => !ownImagePath(r.url, orgId));
  return { pkg: parsed.data, report: { bundled: urlFor.size, bytes, external, unreadable: [] } };
}

function configurationRequired(): ApiError {
  return new ApiError("CONFIGURATION_REQUIRED", 503, "File storage is not configured, so a theme package cannot be stored or read.", {
    resolution: "File storage is not configured on this deployment. Contact your Markii admin.",
  });
}
