import { Suspense } from "react";
import { MfaRecoverForm } from "@/components/auth/mfa-recover-form";

export default function MfaRecoverPage() {
  return (
    <Suspense fallback={<p className="p-8 text-sm text-muted">Loading…</p>}>
      <MfaRecoverForm />
    </Suspense>
  );
}