import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth/auth-form";
import { requireNoSession } from "@/lib/auth/already-signed-in";

export const dynamic = "force-dynamic";

export default async function SignUpPage() {
  if (await requireNoSession()) redirect("/dashboard");
  return <AuthForm mode="sign-up" />;
}
