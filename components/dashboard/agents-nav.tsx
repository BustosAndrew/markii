"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Sparkles } from "lucide-react";
import { getAgentDirectory, type AgentDirectory, type AgentKind } from "@/lib/api/agents";
import { useOpenAgent } from "@/components/dashboard/agent-panel";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const FALLBACK_AGENTS: AgentDirectory["agents"] = [
  {
    id: "assistant",
    name: "Assistant",
    description: "Answers questions, checks setup, and points you to the right page.",
    beta: true,
    href: null,
  },
  {
    id: "catalog",
    name: "Catalog agent",
    description: "Proposes catalog edits. Nothing is applied until you approve it.",
    beta: true,
    href: "/dashboard/catalog",
  },
];

export function AgentsNavMenu() {
  const agents = useOpenAgent();
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [directory, setDirectory] = useState<AgentDirectory | null>(null);

  const close = useCallback(() => setOpen(false), []);

  async function toggle() {
    if (open) {
      close();
      return;
    }
    setOpen(true);
    if (!directory) {
      try {
        setDirectory(await getAgentDirectory());
      } catch {
        // The fallback list is enough to pick an agent; the panel loads its own directory.
      }
    }
  }

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (rootRef.current?.contains(target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        buttonRef.current?.focus();
      }
    };

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  const items = directory?.agents ?? FALLBACK_AGENTS;

  function pick(id: AgentKind) {
    close();
    agents?.openAgent(id);
  }

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => void toggle()}
        className={cn(
          "flex min-h-10 cursor-pointer items-center gap-2 rounded-[var(--radius-control)] px-2.5 py-1.5 text-sm font-medium transition-colors",
          "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/10",
          open
            ? "bg-hover text-foreground"
            : "text-muted hover:bg-hover-soft hover:text-foreground",
        )}
      >
        <Sparkles className="size-4 shrink-0" />
        Agents
        <ChevronDown
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")}
          aria-hidden
        />
      </button>

      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label="Available agents"
          className="absolute right-0 z-50 mt-1 w-72 rounded-[var(--radius-card)] border border-border bg-surface p-1 shadow-[var(--shadow-md)]"
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              onClick={() => pick(item.id)}
              className="flex w-full cursor-pointer flex-col items-start gap-1 rounded-[var(--radius-control)] px-3 py-2.5 text-left transition-colors hover:bg-hover-soft"
            >
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-foreground">{item.name}</span>
                {item.beta ? <Badge variant="info">Beta</Badge> : null}
              </span>
              <span className="text-xs leading-5 text-muted">{item.description}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
