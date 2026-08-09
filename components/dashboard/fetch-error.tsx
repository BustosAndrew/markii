"use client";

import { useRouter } from "next/navigation";
import { sanitizePublicCopy } from "@/lib/api/public-copy";
import { ErrorState } from "@/components/ui/error-state";

export function FetchError({
  title = "Unavailable",
  message,
}: {
  title?: string;
  message: string;
}) {
  const router = useRouter();
  return (
    <ErrorState
      title={title}
      message={sanitizePublicCopy(message) || "Something went wrong."}
      onRetry={() => router.refresh()}
    />
  );
}
