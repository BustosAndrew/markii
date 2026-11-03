"use client";

import { useOpenAgent } from "@/components/dashboard/agent-panel";
import { Button, ButtonLink } from "@/components/ui/button";
import type { AgentKind } from "@/lib/api/agents";

export function AskAgentButton({
  agent,
  label,
}: {
  agent: AgentKind;
  label: string;
}) {
  const agents = useOpenAgent();
  // The brand agent has no dashboard drawer — it lives in the site editor.
  if (agent === "brand") {
    return (
      <ButtonLink
        href="/dashboard/websites?open=design"
        variant="secondary"
        className="px-3 py-1.5 text-sm"
      >
        {label}
      </ButtonLink>
    );
  }
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
