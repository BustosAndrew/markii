import { ComingSoon } from "@/components/ui/coming-soon";
import { PageHeader } from "@/components/ui/page-header";

export default function DiscountsPage() {
  return (
    <div>
      <PageHeader
        title="Discounts"
        description="Discounts and gift cards are planned for the commerce launch."
      />
      <ComingSoon
        title="Discounts are planned"
        description="Discount codes, automatic promotions, and validation flows will appear here when API §18 discount routes are live."
        apiSection="API §18 · Commerce core (discounts)"
      />
    </div>
  );
}
