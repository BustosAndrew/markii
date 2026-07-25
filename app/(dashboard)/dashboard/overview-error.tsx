"use client";

import { useRouter } from "next/navigation";
import { ErrorState } from "@/components/ui/error-state";

export function OverviewError({ message }: { message: string }) {
  const router = useRouter();
  return (
    <ErrorState
      title="Overview unavailable"
      message={message}
      onRetry={() => router.refresh()}
    />
  );
}
