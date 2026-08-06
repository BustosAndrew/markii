"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Input, Select } from "@/components/ui/field";
import { cn } from "@/lib/utils";

export function ListFilters({
  searchPlaceholder = "Search…",
  filters,
  dateRange = false,
  className,
}: {
  searchPlaceholder?: string;
  filters?: {
    key: string;
    label: string;
    options: { value: string; label: string }[];
  }[];
  /**
   * Adds `from`/`to` inputs beside the selects. Kept here rather than in a
   * second component so a screen that needs both does not render two search
   * boxes writing to the same `q`.
   */
  dateRange?: boolean;
  className?: string;
}) {
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
        key={searchParams.get("q") ?? ""}
        name="q"
        defaultValue={searchParams.get("q") ?? ""}
        placeholder={searchPlaceholder}
        className="sm:max-w-xs"
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            update("q", (e.target as HTMLInputElement).value.trim());
          }
        }}
        onBlur={(e) => update("q", e.target.value.trim())}
      />
      {filters?.map((f) => (
        <Select
          key={f.key}
          aria-label={f.label}
          className="sm:max-w-[180px]"
          value={searchParams.get(f.key) ?? ""}
          onChange={(e) => update(f.key, e.target.value)}
        >
          <option value="">{f.label}</option>
          {f.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      ))}
      {dateRange ? (
        <>
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
        </>
      ) : null}
    </div>
  );
}
