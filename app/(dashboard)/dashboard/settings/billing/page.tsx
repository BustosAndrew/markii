import { redirect } from "next/navigation";

export default function LegacySettingsBillingPage() {
  redirect("/dashboard/billing");
}
