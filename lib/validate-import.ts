import { ApiClientError } from "@/lib/api/types";

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.goog",
]);

function isPrivateIpv4(hostname: string) {
  const m = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/** Soft client gate for scrape URLs. Backend must still enforce SSRF controls. */
export function assertPublicHttpsUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ApiClientError(400, "VALIDATION_ERROR", "Enter a valid URL.");
  }

  if (url.protocol !== "https:") {
    throw new ApiClientError(
      400,
      "VALIDATION_ERROR",
      "Only https:// storefront URLs are allowed.",
    );
  }

  if (url.username || url.password) {
    throw new ApiClientError(
      400,
      "VALIDATION_ERROR",
      "URLs with embedded credentials are not allowed.",
    );
  }

  const host = url.hostname.toLowerCase();
  if (
    BLOCKED_HOSTS.has(host) ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "::1" ||
    host.startsWith("[") ||
    isPrivateIpv4(host)
  ) {
    throw new ApiClientError(
      400,
      "VALIDATION_ERROR",
      "That host cannot be scraped from Markii.",
    );
  }

  if (raw.trim().length > 2048) {
    throw new ApiClientError(400, "VALIDATION_ERROR", "URL is too long.");
  }

  return url.toString();
}

export function assertCsvFile(file: File) {
  const name = file.name.toLowerCase();
  const okType =
    file.type === "text/csv" ||
    file.type === "application/vnd.ms-excel" ||
    file.type === "text/plain" ||
    file.type === "";
  if (!okType && !name.endsWith(".csv")) {
    throw new ApiClientError(
      400,
      "VALIDATION_ERROR",
      "Upload a .csv file.",
    );
  }
  if (file.size === 0) {
    throw new ApiClientError(400, "VALIDATION_ERROR", "CSV file is empty.");
  }
  if (file.size > 10 * 1024 * 1024) {
    throw new ApiClientError(
      400,
      "VALIDATION_ERROR",
      "CSV must be 10 MB or smaller.",
    );
  }
}
