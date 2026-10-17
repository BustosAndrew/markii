"use client";

import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  getToolName,
  isTextUIPart,
  isToolUIPart,
  type UIMessage,
} from "ai";
import { useMemo, useState } from "react";
import {
  agentChatEndpoint,
  getAgentSession,
  type AgentProposal,
} from "@/lib/api/agents";
import { publicErrorMessage, PUBLIC_CONFIGURATION_RESOLUTION } from "@/lib/api/public-copy";
import { isPaymentPastDue, isTrialEnded } from "@/lib/api/trial-errors";
import { ApiClientError, type ApiErrorBody } from "@/lib/api/types";
import { AgentProposalCard } from "@/components/dashboard/agent-proposal-card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/field";

function asUiMessages(raw: unknown[]): UIMessage[] {
  return raw.filter((row): row is UIMessage => {
    if (!row || typeof row !== "object") return false;
    const message = row as { id?: unknown; role?: unknown; parts?: unknown };
    return (
      typeof message.id === "string" &&
      (message.role === "user" || message.role === "assistant" || message.role === "system") &&
      Array.isArray(message.parts)
    );
  });
}

function textOf(message: UIMessage): string {
  return message.parts
    .filter(isTextUIPart)
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function proposalIdFromOutput(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const row = output as { status?: unknown; proposalId?: unknown };
  if (row.status === "proposed" && typeof row.proposalId === "string") return row.proposalId;
  return null;
}

function proposeToolNote(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const row = output as { status?: unknown; message?: unknown };
  if (row.status === "limit_reached") {
    // The tool's message is addressed to the model; the merchant gets their own.
    return "The agent reached its limit of proposals for one message. Ask it to continue for the rest.";
  }
  if (row.status === "refused" || row.status === "no_change") {
    return typeof row.message === "string" ? row.message : "The change could not be prepared.";
  }
  return null;
}

async function readChatError(res: Response): Promise<ApiClientError> {
  let code = "INTERNAL";
  let message = res.statusText || "Request failed";
  let details: unknown | undefined;
  try {
    const body = (await res.json()) as ApiErrorBody;
    if (body?.error) {
      code = body.error.code || code;
      message = body.error.message || message;
      details = body.error.details;
    }
  } catch {
    // non-JSON error body
  }
  return new ApiClientError(res.status, code, message, details);
}

function chatErrorCopy(error: unknown): string {
  if (isTrialEnded(error)) {
    return "Your free month has ended, so the Catalog agent is paused. Choose a plan on the Billing page to turn it back on. Your products, orders, and customers are still here.";
  }
  if (isPaymentPastDue(error)) {
    return "A billing payment hasn’t gone through, so the Catalog agent is paused. Update your card on the Billing page. Your products, orders, and customers are still here.";
  }
  if (error instanceof ApiClientError && error.code === "ACCOUNT_SUSPENDED") {
    return "This account is on hold, so the Catalog agent can’t run. Contact support. Your products, orders, and customers are still here.";
  }
  const fallback = publicErrorMessage(error, "The agent could not reply.");
  if (!(error instanceof ApiClientError)) return fallback;
  if (error.code === "CONFIGURATION_REQUIRED") {
    return PUBLIC_CONFIGURATION_RESOLUTION;
  }
  const details = error.details;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    const resolution = (details as { resolution?: unknown }).resolution;
    if (typeof resolution === "string" && resolution.trim()) {
      return `${fallback} ${resolution}`;
    }
  }
  return fallback;
}

type ChatSlot = {
  sessionId: string | null;
  onSessionId: (id: string) => void;
  onFinished: () => void;
};

function catalogChatTransport(slot: ChatSlot) {
  return new DefaultChatTransport<UIMessage>({
    api: agentChatEndpoint("catalog"),
    credentials: "same-origin",
    prepareSendMessagesRequest: ({ messages }) => {
      const last = messages.at(-1);
      return {
        body: {
          ...(slot.sessionId ? { sessionId: slot.sessionId } : {}),
          message: {
            id: last?.id ?? crypto.randomUUID(),
            role: "user" as const,
            parts: (last?.parts ?? [])
              .filter(isTextUIPart)
              .map((part) => ({ type: "text" as const, text: part.text })),
          },
        },
      };
    },
    // The chat stream is not a JSON service call; this fetch only exists to
    // throw pre-stream JSON refusals and keep the session id from the header.
    fetch: async (input, init) => {
      const res = await fetch(input, init);
      const nextId = res.headers.get("x-agent-session-id");
      if (nextId) {
        slot.sessionId = nextId;
        slot.onSessionId(nextId);
      }
      if (!res.ok) throw await readChatError(res);
      return res;
    },
  });
}

export function AgentChat({
  sessionId,
  initialMessages,
  initialProposals,
  canSend,
  disabledReason,
  onSessionId,
  onFinished,
}: {
  sessionId: string | null;
  initialMessages: unknown[];
  initialProposals: AgentProposal[];
  canSend: boolean;
  disabledReason?: string;
  onSessionId: (id: string) => void;
  onFinished: () => void;
}) {
  const [slot] = useState<ChatSlot>(() => ({
    sessionId,
    onSessionId,
    onFinished,
  }));

  const [proposals, setProposals] = useState<AgentProposal[]>(initialProposals);
  const [draft, setDraft] = useState("");
  const transport = useMemo(() => catalogChatTransport(slot), [slot]);

  const { messages, sendMessage, stop, status, error, clearError } = useChat({
    transport,
    messages: asUiMessages(initialMessages),
    onFinish: async () => {
      const id = slot.sessionId;
      if (id) {
        try {
          const detail = await getAgentSession(id);
          setProposals(detail.proposals);
        } catch {
          // The transcript already streamed; a session refetch can wait.
        }
      }
      slot.onFinished();
    },
  });

  const busy = status === "submitted" || status === "streaming";
  const proposalById = new Map(proposals.map((row) => [row.id, row]));

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy || !canSend) return;
    setDraft("");
    clearError();
    await sendMessage({ text });
  }

  return (
    <div>
      <div className="space-y-4">
        {messages.length === 0 ? (
          <p className="text-sm leading-6 text-muted">
            Ask about products, collections, or stock. The agent proposes edits; nothing
            changes until you approve a card.
          </p>
        ) : null}

        {messages.map((message) => {
          if (message.role === "user") {
            const text = textOf(message);
            if (!text) return null;
            return (
              <div key={message.id} className="flex justify-end">
                <p className="max-w-[90%] rounded-[var(--radius-control)] bg-brand px-3 py-2 text-sm leading-6 text-on-brand">
                  {text}
                </p>
              </div>
            );
          }

          if (message.role !== "assistant") return null;

          return (
            <div key={message.id} className="space-y-3">
              {message.parts.map((part, index) => {
                if (isTextUIPart(part) && part.text.trim()) {
                  return (
                    <p
                      key={`${message.id}-text-${index}`}
                      className="text-sm leading-6 text-foreground"
                    >
                      {part.text}
                    </p>
                  );
                }

                if (!isToolUIPart(part)) return null;
                const name = getToolName(part);
                if (!name.startsWith("propose_")) return null;

                if (part.state === "input-streaming" || part.state === "input-available") {
                  return (
                    <p key={`${message.id}-${name}-${index}`} className="text-sm text-muted">
                      Preparing a proposal…
                    </p>
                  );
                }

                if (part.state === "output-error") {
                  return (
                    <p
                      key={`${message.id}-${name}-${index}`}
                      className="text-sm leading-6 text-error-text"
                    >
                      {part.errorText}
                    </p>
                  );
                }

                if (part.state !== "output-available") return null;

                const proposalId = proposalIdFromOutput(part.output);
                if (proposalId) {
                  const proposal = proposalById.get(proposalId);
                  if (!proposal) {
                    return (
                      <p key={`${message.id}-${proposalId}`} className="text-sm text-muted">
                        Proposal ready.
                      </p>
                    );
                  }
                  return (
                    <AgentProposalCard
                      key={proposal.id}
                      proposal={proposal}
                      onChange={(next) => {
                        setProposals((current) =>
                          current.map((row) => (row.id === next.id ? next : row)),
                        );
                      }}
                    />
                  );
                }

                const note = proposeToolNote(part.output);
                if (!note) return null;
                return (
                  <p
                    key={`${message.id}-${name}-${index}`}
                    className="text-sm leading-6 text-muted"
                  >
                    {note}
                  </p>
                );
              })}
            </div>
          );
        })}
      </div>

      {error ? (
        <p className="mt-3 text-sm leading-6 text-error-text">{chatErrorCopy(error)}</p>
      ) : null}

      <form onSubmit={(event) => void onSubmit(event)} className="mt-4 shrink-0">
        <label htmlFor="agent-message" className="sr-only">
          Message the Catalog agent
        </label>
        <Textarea
          id="agent-message"
          rows={3}
          value={draft}
          disabled={!canSend || busy}
          placeholder={disabledReason ?? "Ask about your catalog…"}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="mt-2 flex items-center justify-end gap-2">
          {busy ? (
            <Button type="button" variant="ghost" className="px-3 py-1.5 text-sm" onClick={() => void stop()}>
              Stop
            </Button>
          ) : null}
          <Button type="submit" className="px-3 py-1.5 text-sm" disabled={!canSend || busy || !draft.trim()}>
            Send
          </Button>
        </div>
      </form>
    </div>
  );
}
