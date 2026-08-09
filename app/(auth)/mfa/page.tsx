import { redirect } from "next/navigation";
import { getMfaStatus } from "@/lib/api/server";
import { mfaPathForGate } from "@/lib/api/mfa-errors";
import { ApiClientError } from "@/lib/api/types";

export default async function MfaIndexPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const q = next ? `?next=${encodeURIComponent(next)}` : "";

  try {
    const status = await getMfaStatus();
    if (!status.required || status.gate.status === "ok") {
      redirect(next?.startsWith("/") ? next : "/dashboard");
    }
    const path = mfaPathForGate(status.gate);
    redirect(`${path ?? "/mfa/enroll"}${q}`);
  } catch (err) {
    if (err instanceof ApiClientError && err.status === 401) {
      redirect("/sign-in");
    }
    throw err;
  }
}
