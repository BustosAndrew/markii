import { ApiClientError } from "./types";

export async function uploadProductImage(file: File, init?: RequestInit) {
  const allowed = ["image/png", "image/jpeg", "image/webp"];
  if (!allowed.includes(file.type)) {
    throw new ApiClientError(
      400,
      "VALIDATION_ERROR",
      "Only PNG, JPG, or WebP images are allowed.",
    );
  }
  if (file.size > 5 * 1024 * 1024) {
    throw new ApiClientError(
      400,
      "VALIDATION_ERROR",
      "Image must be 5 MB or smaller.",
    );
  }

  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/uploads", {
    ...init,
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    let code = "INTERNAL";
    let message = res.statusText || "Upload failed";
    try {
      const body = await res.json();
      code = body?.error?.code ?? code;
      message = body?.error?.message ?? message;
    } catch {
      // ignore
    }
    throw new ApiClientError(res.status, code, message);
  }

  return (await res.json()) as { url: string };
}
