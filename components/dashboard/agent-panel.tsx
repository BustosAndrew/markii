"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  getAgentDirectory,
  listAgentSessions,
  getAgentSession,
  type AgentDirectory,
  type AgentKind,
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

const COPY: Record<
  AgentKind,
  {
    title: string;
    description: string;
    loadError: string;
  }
> = {
  catalog: {
    title: "Catalog agent",
    description: "Proposes catalog edits. Nothing is applied until you approve it.",
    loadError: "Could not load the Catalog agent.",
  },
  assistant: {
    title: "Assistant",
    description: "Answers questions, checks setup, and points you to the right page. It cannot change your store.",
    loadError: "Could not load the assistant.",
  },
};

type AgentsContextValue = {
  openAgent: (kind: AgentKind) => void;
};

const AgentsContext = createContext<AgentsContextValue | null>(null);

export function useOpenAgent() {
  return useContext(AgentsContext);
}

export function useOpenAssistant() {
  const agents = useOpenAgent();
  if (!agents) return null;
  return () => agents.openAgent("assistant");
}

export function AgentsHost({ children }: { children: ReactNode }) {
  const openers = useRef<Partial<Record<AgentKind, () => void>>>({});
  const closers = useRef<Partial<Record<AgentKind, () => void>>>({});

  const register = useCallback((kind: AgentKind, open: () => void, close: () => void) => {
    openers.current[kind] = open;
    closers.current[kind] = close;
    return () => {
      delete openers.current[kind];
      delete closers.current[kind];
    };
  }, []);

  const openAgent = useCallback((kind: AgentKind) => {
    (Object.keys(closers.current) as AgentKind[]).forEach((id) => {
      if (id !== kind) closers.current[id]?.();
    });
    openers.current[kind]?.();
  }, []);

  return (
    <AgentsContext.Provider value={{ openAgent }}>
      {children}
      <AgentPanel agent="assistant" register={register} />
      <AgentPanel agent="catalog" register={register} />
    </AgentsContext.Provider>
  );
}

export function AgentPanel({
  agent,
  register,
}: {
  agent: AgentKind;
  register?: (kind: AgentKind, open: () => void, close: () => void) => () => void;
}) {
  const copy = COPY[agent];
  const [open, setOpen] = useState(false);
  const [directory, setDirectory] = useState<AgentDirectory | null>(null);
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [thread, setThread] = useState<Thread>(newThread);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [dir, listed] = await Promise.all([
        getAgentDirectory(),
        listAgentSessions({ agent }),
      ]);
      setDirectory(dir);
      setSessions(listed.items);
    } catch (err) {
      setLoadError(publicErrorMessage(err, copy.loadError));
    }
  }, [agent, copy.loadError]);

  const openPanel = useCallback(() => {
    setOpen(true);
    void load();
  }, [load]);

  const closePanel = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!register) return;
    return register(agent, openPanel, closePanel);
  }, [agent, register, openPanel, closePanel]);

  const handleSessionId = useCallback((id: string) => {
    setThread((current) =>
      current.sessionId === id ? current : { ...current, sessionId: id },
    );
  }, []);

  const listed = directory?.agents.find((row) => row.id === agent);
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
    <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={copy.title}
        description={copy.description}
        className="max-w-lg"
        // The transcript and any in-flight reply live in `useChat`; unmounting
        // on close would drop both while the session id survived, so the next
        // message would continue a conversation the merchant could no longer see.
        keepMounted
      >
        {loadError && !directory ? (
          <ErrorState title={copy.title} message={loadError} onRetry={() => void load()} />
        ) : !directory ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : (
          <div>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <Badge variant="info">Beta</Badge>
              {listed ? (
                <span className="text-sm text-muted">{listed.name}</span>
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
                  agent={agent}
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
  );
}
