"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getAgentDirectory,
  getAgentSession,
  listAgentSessions,
  type AgentDirectory,
  type AgentEditorContext,
  type AgentSessionSummary,
} from "@/lib/api/agents";
import { publicErrorMessage, PUBLIC_CONFIGURATION_RESOLUTION } from "@/lib/api/public-copy";
import { AgentChat } from "@/components/dashboard/agent-chat";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/field";

/**
 * The brand agent, docked in the site editor (D51, M3).
 *
 * One conversation thread per site: the newest is reopened when the editor
 * loads, so the merchant picks up where they left off. Everything that makes
 * the agent *see* the editor — the current draft, edits made by hand since it
 * last spoke, the selected block — is assembled on the server each turn; the
 * only thing sent from here is `context`, which says where the merchant is.
 */

type Thread = { key: string; sessionId: string | null; messages: unknown[] };
const newThread = (): Thread => ({ key: `new-${Math.random().toString(36).slice(2)}`, sessionId: null, messages: [] });

export function BrandChat({
  siteId,
  canEdit,
  context,
  onToolResult,
  onStop,
  onBusyChange,
  stopSignal,
}: {
  siteId: number;
  canEdit: boolean;
  context: () => AgentEditorContext;
  onToolResult: (toolName: string, output: unknown) => void;
  onStop: () => Promise<void>;
  onBusyChange: (busy: boolean) => void;
  stopSignal: number;
}) {
  const [directory, setDirectory] = useState<AgentDirectory | null>(null);
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  const [thread, setThread] = useState<Thread | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  /** After a turn: the allowance moved and a new conversation may now be listed. */
  const load = useCallback(async () => {
    const [dir, listed] = await Promise.all([getAgentDirectory(), listAgentSessions({ agent: "brand", siteId })]);
    setDirectory(dir);
    setSessions(listed.items);
  }, [siteId]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getAgentDirectory(), listAgentSessions({ agent: "brand", siteId })])
      .then(async ([dir, listed]) => {
        const latest = listed.items[0];
        const detail = latest ? await getAgentSession(latest.id) : null;
        if (cancelled) return;
        setDirectory(dir);
        setSessions(listed.items);
        setThread(detail ? { key: detail.id, sessionId: detail.id, messages: detail.messages } : newThread());
      })
      .catch((e) => {
        if (!cancelled) setLoadError(publicErrorMessage(e, "Could not load the brand agent."));
      });
    return () => {
      cancelled = true;
    };
  }, [siteId]);

  async function resume(id: string) {
    try {
      const detail = await getAgentSession(id);
      setThread({ key: detail.id, sessionId: detail.id, messages: detail.messages });
    } catch (e) {
      setLoadError(publicErrorMessage(e, "Could not open that chat."));
    }
  }

  if (loadError && !directory) return <p className="p-3 text-sm text-error-text">{loadError}</p>;
  if (!directory || !thread) return <p className="p-3 text-sm text-muted">Loading the brand agent…</p>;
  if (!directory.configured) {
    return (
      <div className="p-3">
        <p className="text-sm font-medium text-foreground">Configuration required</p>
        <p className="mt-1 text-sm leading-6 text-muted">{PUBLIC_CONFIGURATION_RESOLUTION}</p>
      </div>
    );
  }

  const allowed = directory.allowance.allowed;
  const disabledReason = !canEdit
    ? "Your role can't edit this design, so it can't use the brand agent."
    : !allowed
      ? "This month's beta allowance is used."
      : undefined;

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => setThread(newThread())}>
          New chat
        </Button>
        {sessions.length > 0 ? (
          <Select
            aria-label="Past design chats"
            className="max-w-44 text-xs"
            value={thread.sessionId ?? ""}
            onChange={(e) => e.target.value && void resume(e.target.value)}
          >
            <option value="">Past chats</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title?.trim() || "Untitled chat"}
              </option>
            ))}
          </Select>
        ) : null}
      </div>
      {loadError ? <p className="text-xs text-error-text">{loadError}</p> : null}
      <AgentChat
        key={thread.key}
        agent="brand"
        sessionId={thread.sessionId}
        initialMessages={thread.messages}
        initialProposals={[]}
        canSend={canEdit && allowed}
        disabledReason={disabledReason}
        onSessionId={(id) => setThread((t) => (t && t.sessionId !== id ? { ...t, sessionId: id } : t))}
        onFinished={() => void load().catch(() => {})}
        context={context}
        onToolResult={onToolResult}
        onStop={onStop}
        onBusyChange={onBusyChange}
        stopSignal={stopSignal}
      />
    </div>
  );
}
