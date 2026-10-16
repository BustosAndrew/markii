import "server-only";

import { and, desc, eq } from "drizzle-orm";
import { notFound } from "../api";
import { agentSessions, db, type AgentKind, type AgentSession } from "../db";

/**
 * Agent sessions — one person's conversation with one agent.
 *
 * **Every lookup is by owner.** A session is what someone typed to an agent,
 * so another staff member asking for it by id gets the same `404` as an id
 * that never existed — never a `403`, which would confirm it exists.
 */

function newSessionId() {
  return `as_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export async function createSession(input: {
  orgId: string;
  userId: string;
  agent: AgentKind;
  title: string | null;
}): Promise<AgentSession> {
  const [row] = await db
    .insert(agentSessions)
    .values({ id: newSessionId(), ...input, messages: [] })
    .returning();
  return row;
}

export async function ownedSession(
  sessionId: string,
  owner: { orgId: string; userId: string },
): Promise<AgentSession> {
  const [row] = await db
    .select()
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, sessionId),
        eq(agentSessions.orgId, owner.orgId),
        eq(agentSessions.userId, owner.userId),
      ),
    )
    .limit(1);
  if (!row) throw notFound("Agent session");
  return row;
}

export async function listSessions(owner: { orgId: string; userId: string }, limit = 50) {
  return db
    .select({
      id: agentSessions.id,
      agent: agentSessions.agent,
      title: agentSessions.title,
      createdAt: agentSessions.createdAt,
      updatedAt: agentSessions.updatedAt,
    })
    .from(agentSessions)
    .where(and(eq(agentSessions.orgId, owner.orgId), eq(agentSessions.userId, owner.userId)))
    .orderBy(desc(agentSessions.updatedAt))
    .limit(limit);
}

/**
 * Replace the stored transcript with what the turn ended on.
 *
 * Never throws, for the reason `recordUsage` does not: it runs after the
 * stream finished, and the reply the merchant just read must not turn into an
 * error. A lost save costs the turn from the history — logged, not hidden.
 */
export async function saveMessages(sessionId: string, messages: unknown[]): Promise<void> {
  try {
    await db
      .update(agentSessions)
      .set({ messages, updatedAt: new Date() })
      .where(eq(agentSessions.id, sessionId));
  } catch (e) {
    console.error("[agents] could not save session messages", { sessionId, error: e });
  }
}

/** A session list's label: the first line of the first message, trimmed. */
export function titleFrom(text: string): string | null {
  const line = text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  if (!line) return null;
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}
