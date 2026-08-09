import { Suspense } from "react";
import { MfaChallengeForm } from "@/components/auth/mfa-challenge-form";

export default function MfaChallengePage() {
  return (
    <Suspense fallback={<p className="p-8 text-sm text-muted">Loading…</p>}>
      <MfaChallengeForm />
    </Suspense>
  );
}
