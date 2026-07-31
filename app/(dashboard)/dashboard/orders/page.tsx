import { OrdersSubnav } from "@/components/dashboard/orders-subnav";
import { ComingSoon } from "@/components/ui/coming-soon";
import { PageHeader } from "@/components/ui/page-header";

export default function OrdersPage() {
  return (
    <div>
      <PageHeader
        title="Orders"
        description="Operational order views are planned; settlements stay live while promoted order APIs land."
      />
      <OrdersSubnav />
      <ComingSoon
        title="Orders list is planned"
        description="Promoted order list, timelines, and operational states arrive with API §13. Settlement history remains live under the Settlements tab."
        apiSection="API §13 · Orders (list and timeline)"
      />
    </div>
  );
}
