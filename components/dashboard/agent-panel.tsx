"use client";

import { MessageCircle, Sparkles } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
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
import { cn } from "@/lib/utils";

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
    launcherLabel: string;
    launcherHint: string;
    loadError: string;
  }
> = {
  catalog: {
    title: "Catalog agent",
    description: "Proposes catalog edits. Nothing is applied until you approve it.",
    launcherLabel: "Catalog agent",
    launcherHint: "AI chat · Beta",
    loadError: "Could not load the Catalog agent.",
  },
  assistant: {
    title: "Assistant",
    description: "Answers questions, checks setup, and points you to the right page. It cannot change your store.",
    launcherLabel: "Assistant",
    launcherHint: "AI chat · Beta",
    loadError: "Could not load the assistant.",
  },
};

const OpenAssistantContext = createContext<(() => void) | null>(null);

export function useOpenAssistant() {
  return useContext(OpenAssistantContext);
}

export function AssistantHost({ children }: { children: ReactNode }) {
  const openRef = useRef<() => void>(() => {});
  const open = useCallback(() => {
    openRef.current();
  }, []);
  return (
    <OpenAssistantContext.Provider value={open}>
      {children}
      <AgentPanel agent="assistant" openRef={openRef} />
    </OpenAssistantContext.Provider>
  );
}

export function AgentPanel({
  agent,
  openRef,
}: {
  agent: AgentKind;
  openRef?: MutableRefObject<() => void>;
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

  useEffect(() => {
    if (!openRef) return;
    openRef.current = openPanel;
  }, [openRef, openPanel]);

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

  const Icon = agent === "catalog" ? Sparkles : MessageCircle;

  return (
    <>
      {open ? null : (
        <button
          type="button"
          onClick={openPanel}
          className={cn(
            "fixed right-4 z-40 flex items-center gap-3 rounded-[var(--radius-card)] px-3 py-2.5 text-left shadow-[var(--shadow-md)] transition-[background-color,box-shadow,border-color] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/20 lg:right-6",
            "bottom-[max(1.5rem,env(safe-area-inset-bottom))]",
            agent === "catalog"
              ? "bg-brand text-on-brand hover:bg-brand-hover active:bg-brand-pressed"
              : "border border-border bg-surface text-foreground hover:bg-hover",
          )}
        >
          <span
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-control)]",
              agent === "catalog" ? "bg-on-brand/15" : "bg-hover-soft",
            )}
            aria-hidden
          >
            <Icon className="size-4" />
          </span>
          <span className="min-w-0 pr-1">
            <span className="block text-sm font-semibold leading-5 tracking-tight">
              {copy.launcherLabel}
            </span>
            <span
              className={cn(
                "block text-xs leading-4",
                agent === "catalog" ? "text-on-brand/80" : "text-muted",
              )}
            >
              {copy.launcherHint}
            </span>
          </span>
        </button>
      )}

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
    </>
  );
}
