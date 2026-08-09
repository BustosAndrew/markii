import { Suspense } from "react";
import { MfaEnrollForm } from "@/components/auth/mfa-enroll-form";

export default function MfaEnrollPage() {
  return (
    <Suspense fallback={<p className="p-8 text-sm text-muted">Loading…</p>}>
      <MfaEnrollForm />
    </Suspense>
  );
}
