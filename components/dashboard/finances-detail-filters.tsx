"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Input, Select } from "@/components/ui/field";
import { cn } from "@/lib/utils";

export function FinancesDetailFilters({ className }: { className?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  function update(key: string, value: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (!value) next.delete(key);
    else next.set(key, value);
    if (key !== "page") next.delete("page");
    startTransition(() => {
      router.push(`${pathname}?${next.toString()}`);
    });
  }

  return (
    <div
      className={cn(
        "mb-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center",
        pending && "opacity-70",
        className,
      )}
    >
      <Input
        key={`q-${searchParams.get("q") ?? ""}`}
        defaultValue={searchParams.get("q") ?? ""}
        placeholder="Search product or tx hash…"
        className="sm:max-w-xs"
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            update("q", (e.target as HTMLInputElement).value.trim());
          }
        }}
        onBlur={(e) => update("q", e.target.value.trim())}
      />
      <Select
        aria-label="Status"
        className="sm:max-w-[160px]"
        value={searchParams.get("status") ?? ""}
        onChange={(e) => update("status", e.target.value)}
      >
        <option value="">All statuses</option>
        <option value="success">Success</option>
        <option value="pending">Pending</option>
        <option value="cancel">Cancel</option>
        <option value="failed">Failed</option>
      </Select>
      <Input
        type="date"
        aria-label="From date"
        className="sm:max-w-[160px]"
        value={searchParams.get("from") ?? ""}
        onChange={(e) => update("from", e.target.value)}
      />
      <Input
        type="date"
        aria-label="To date"
        className="sm:max-w-[160px]"
        value={searchParams.get("to") ?? ""}
        onChange={(e) => update("to", e.target.value)}
      />
    </div>
  );
}
