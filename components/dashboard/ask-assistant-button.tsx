"use client";

import { useOpenAssistant } from "@/components/dashboard/agent-panel";
import { Button } from "@/components/ui/button";

export function AskAssistantButton({
  label = "Ask the assistant",
}: {
  label?: string;
}) {
  const open = useOpenAssistant();
  if (!open) return null;
  return (
    <Button type="button" variant="secondary" className="px-3 py-1.5 text-sm" onClick={open}>
      {label}
    </Button>
  );
}
