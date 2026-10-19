"use client";

import { useOpenAgent } from "@/components/dashboard/agent-panel";
import { Button } from "@/components/ui/button";
import type { AgentKind } from "@/lib/api/agents";

export function AskAgentButton({
  agent,
  label,
}: {
  agent: AgentKind;
  label: string;
}) {
  const agents = useOpenAgent();
  if (!agents) return null;
  return (
    <Button
      type="button"
      variant="secondary"
      className="px-3 py-1.5 text-sm"
      onClick={() => agents.openAgent(agent)}
    >
      {label}
    </Button>
  );
}

export function AskAssistantButton({
  label = "Ask the assistant",
}: {
  label?: string;
}) {
  return <AskAgentButton agent="assistant" label={label} />;
}
