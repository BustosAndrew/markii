"use client";

import { Sparkles } from "lucide-react";
import { useCallback, useState } from "react";
import {
  getAgentDirectory,
  listAgentSessions,
  getAgentSession,
  type AgentDirectory,
  type AgentProposal,
  type AgentSessionSummary,
} from "@/lib/api/agents";
import { publicErrorMessage, PUBLIC_CONFIGURATION_RESOLUTION } from "@/lib/api/public-copy";
import { AgentChat } from "@/components/dashboard/agent-chat";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LocalDate } from "@/components/ui/local-date";
import { Select } from "@/components/ui/field";

type Thread = {
  key: string;
  sessionId: string | null;
  messages: unknown[];
  proposals: AgentProposal[];
};

function newThread(): Thread {
  return { key: crypto.randomUUID(), sessionId: null, messages: [], proposals: [] };
}

function formatTokens(n: number): string {
  return n.toLocaleString();
}

export function AgentPanel() {
  const [open, setOpen] = useState(false);
  const [directory, setDirectory] = useState<AgentDirectory | null>(null);
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [thread, setThread] = useState<Thread>(newThread);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      // Catalog sessions only — an assistant session cannot be continued here.
      const [dir, listed] = await Promise.all([
        getAgentDirectory(),
        listAgentSessions({ agent: "catalog" }),
      ]);
      setDirectory(dir);
      setSessions(listed.items);
    } catch (err) {
      setLoadError(publicErrorMessage(err, "Could not load the Catalog agent."));
    }
  }, []);

  function openPanel() {
    setOpen(true);
    void load();
  }

  const handleSessionId = useCallback((id: string) => {
    setThread((current) =>
      current.sessionId === id ? current : { ...current, sessionId: id },
    );
  }, []);

  const catalog = directory?.agents.find((agent) => agent.id === "catalog");
  const configured = directory?.configured === true;
  const allowed = directory?.allowance.allowed === true;
  const canSend = configured && allowed;
  const disabledReason = !configured
    ? "Merchant agents are not configured on this deployment."
    : !allowed
      ? "This month's beta allowance is used."
      : undefined;

  async function resume(id: string) {
    try {
      const detail = await getAgentSession(id);
      setThread({
        key: detail.id,
        sessionId: detail.id,
        messages: detail.messages,
        proposals: detail.proposals,
      });
    } catch (err) {
      setLoadError(publicErrorMessage(err, "Could not open that chat."));
    }
  }

  return (
    <>
      {open ? null : (
        <button
          type="button"
          onClick={openPanel}
          className="fixed right-4 z-40 flex items-center gap-3 rounded-[var(--radius-card)] bg-brand px-3 py-2.5 text-left text-on-brand shadow-[var(--shadow-md)] transition-[background-color,box-shadow] hover:bg-brand-hover active:bg-brand-pressed focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/20 bottom-[max(1.5rem,env(safe-area-inset-bottom))] lg:right-6"
        >
          <span
            className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-on-brand/15"
            aria-hidden
          >
            <Sparkles className="size-4" />
          </span>
          <span className="min-w-0 pr-1">
            <span className="block text-sm font-semibold leading-5 tracking-tight">
              Catalog agent
            </span>
            <span className="block text-xs leading-4 text-on-brand/80">
              AI chat · Beta
            </span>
          </span>
        </button>
      )}

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Catalog agent"
        description="Proposes catalog edits. Nothing is applied until you approve it."
        className="max-w-lg"
        // The transcript and any in-flight reply live in `useChat`; unmounting
        // on close would drop both while the session id survived, so the next
        // message would continue a conversation the merchant could no longer see.
        keepMounted
      >
        {loadError && !directory ? (
          <ErrorState title="Catalog agent" message={loadError} onRetry={() => void load()} />
        ) : !directory ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : (
          <div>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <Badge variant="info">Beta</Badge>
              {catalog ? (
                <span className="text-sm text-muted">{catalog.name}</span>
              ) : null}
            </div>

            {!configured ? (
              <EmptyState
                title="Configuration required"
                description={PUBLIC_CONFIGURATION_RESOLUTION}
              />
            ) : (
              <>
                <p className="mb-3 text-xs leading-5 text-muted">
                  {formatTokens(directory.allowance.usedTokens)} of{" "}
                  {formatTokens(directory.allowance.capTokens)} tokens this month
                  {allowed ? null : (
                    <>
                      {" · "}
                      used up, resets <LocalDate value={directory.allowance.resetsAt} />
                    </>
                  )}
                </p>

                {!allowed ? (
                  <p className="mb-4 text-sm leading-6 text-warning-text">
                    This month&apos;s beta allowance is used. It resets{" "}
                    <LocalDate value={directory.allowance.resetsAt} />.
                  </p>
                ) : null}

                <div className="mb-4 flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    className="px-3 py-1.5 text-sm"
                    onClick={() => setThread(newThread())}
                  >
                    New chat
                  </Button>
                  {sessions.length > 0 ? (
                    <Select
                      aria-label="Past chats"
                      className="max-w-56"
                      value={thread.sessionId ?? ""}
                      onChange={(event) => {
                        const id = event.target.value;
                        if (id) void resume(id);
                      }}
                    >
                      <option value="">Past chats</option>
                      {sessions.map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.title?.trim() || "Untitled chat"}
                        </option>
                      ))}
                    </Select>
                  ) : null}
                </div>

                {loadError ? <p className="mb-3 text-sm text-error-text">{loadError}</p> : null}

                <AgentChat
                  key={thread.key}
                  sessionId={thread.sessionId}
                  initialMessages={thread.messages}
                  initialProposals={thread.proposals}
                  canSend={canSend}
                  disabledReason={disabledReason}
                  onSessionId={handleSessionId}
                  onFinished={load}
                />
              </>
            )}
          </div>
        )}
      </Drawer>
    </>
  );
}
