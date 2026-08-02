import { MarketingFooter } from "@/components/marketing/site-footer";
import { MarketingHeader } from "@/components/marketing/site-header";

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex min-h-screen flex-1 flex-col bg-background">
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="animate-drift absolute -top-32 left-1/2 h-120 w-120 -translate-x-[70%] rounded-full bg-brand/8 blur-[120px]" />
        <div className="animate-drift-slow absolute top-48 right-0 h-100 w-100 translate-x-1/4 rounded-full bg-brand-light/10 blur-[120px]" />
      </div>
      <MarketingHeader />
      <main className="flex-1">{children}</main>
      <MarketingFooter />
    </div>
  );
}
