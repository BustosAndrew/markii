"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function RouteTabs({
  tabs,
  value,
  queryKey = "tab",
  ariaLabel,
}: {
  tabs: { value: string; label: string }[];
  value: string;
  queryKey?: string;
  ariaLabel: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  return (
    <Tabs
      value={value}
      defaultValue={value}
      onValueChange={(nextValue) => {
        const next = new URLSearchParams(searchParams.toString());
        next.set(queryKey, nextValue);
        next.delete("page");
        router.push(`${pathname}?${next.toString()}`);
      }}
    >
      <TabsList aria-label={ariaLabel}>
        {tabs.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
