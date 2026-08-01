"use client";

import { createContext, useContext, useId, useMemo, useState } from "react";
import { cn } from "@/lib/utils";

type TabsContextValue = {
  value: string;
  setValue: (value: string) => void;
  baseId: string;
};

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabsContext() {
  const context = useContext(TabsContext);
  if (!context) {
    throw new Error("Tabs components must be used inside <Tabs>.");
  }
  return context;
}

export function Tabs({
  defaultValue,
  value,
  onValueChange,
  children,
  className,
}: {
  defaultValue: string;
  value?: string;
  onValueChange?: (value: string) => void;
  children: React.ReactNode;
  className?: string;
}) {
  const [internalValue, setInternalValue] = useState(defaultValue);
  const baseId = useId();
  const currentValue = value ?? internalValue;

  const context = useMemo<TabsContextValue>(
    () => ({
      value: currentValue,
      setValue: (nextValue) => {
        if (value === undefined) {
          setInternalValue(nextValue);
        }
        onValueChange?.(nextValue);
      },
      baseId,
    }),
    [baseId, currentValue, onValueChange, value],
  );

  return (
    <TabsContext.Provider value={context}>
      <div className={cn("space-y-4", className)}>{children}</div>
    </TabsContext.Provider>
  );
}

export function TabsList({
  children,
  className,
  "aria-label": ariaLabel,
}: {
  children: React.ReactNode;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        // `max-w-full` + scroll keeps a long tab strip from forcing the page
        // wider than the viewport on narrow screens.
        "inline-flex max-w-full overflow-x-auto rounded-[var(--radius-control)] border border-border bg-surface-elevated p-1 scrollbar-none",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function TabsTrigger({
  value,
  children,
  className,
}: {
  value: string;
  children: React.ReactNode;
  className?: string;
}) {
  const { value: activeValue, setValue, baseId } = useTabsContext();
  const selected = value === activeValue;

  return (
    <button
      id={`${baseId}-tab-${value}`}
      type="button"
      role="tab"
      aria-selected={selected}
      aria-controls={`${baseId}-panel-${value}`}
      tabIndex={selected ? 0 : -1}
      onClick={() => setValue(value)}
      className={cn(
        "shrink-0 cursor-pointer whitespace-nowrap rounded-[calc(var(--radius-control)-4px)] px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/10",
        selected
          ? "bg-surface text-foreground shadow-[var(--shadow-sm)]"
          : "text-muted hover:bg-hover-soft hover:text-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function TabsPanel({
  value,
  children,
  className,
}: {
  value: string;
  children: React.ReactNode;
  className?: string;
}) {
  const { value: activeValue, baseId } = useTabsContext();
  const selected = value === activeValue;

  return (
    <div
      id={`${baseId}-panel-${value}`}
      role="tabpanel"
      aria-labelledby={`${baseId}-tab-${value}`}
      hidden={!selected}
      className={cn(selected ? "block" : "hidden", className)}
    >
      {children}
    </div>
  );
}
