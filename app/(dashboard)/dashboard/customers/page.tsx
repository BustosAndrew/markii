import { ComingSoon } from "@/components/ui/coming-soon";
import { PageHeader } from "@/components/ui/page-header";

export default function CustomersPage() {
  return (
    <div>
      <PageHeader
        title="Customers"
        description="Customer records and order history are planned for the commerce launch."
      />
      <ComingSoon
        title="Customers are planned"
        description="Customer profiles, addresses, and purchase history will appear here when API §18 customer routes are live."
        apiSection="API §18 · Commerce core (customers)"
      />
    </div>
  );
}
