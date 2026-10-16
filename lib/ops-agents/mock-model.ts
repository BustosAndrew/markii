import "server-only";

import type { LanguageModel } from "ai";

/**
 * A scripted model for the integration suite — **never available on a real
 * deployment** (see `mockModelEnabled`).
 *
 * The chat → tool → proposal → approval path is wiring, and wiring is where
 * this codebase's bugs have lived (`tests/README.md`). It cannot be driven
 * against a real model in CI without paying per run and accepting a
 * non-deterministic result, so with `MARKII_AGENT_MOCK_MODEL=1` on a local
 * server the chat route uses this instead.
 *
 * The script is the user's message. `MOCK:` followed by JSON —
 * `{"toolCalls":[{"toolName":"…","input":{…}}],"text":"…"}` — makes the first
 * step call those tools; once their results are in, the second step says
 * `text`. Anything else gets a plain reply. The tools themselves are real.
 */

/**
 * Three conditions, and the flag is the weakest of them.
 *
 * Not `NODE_ENV`: CI runs the integration suite against `next start`, which is
 * a production build, so a `NODE_ENV` guard would refuse the mock exactly
 * where the suite needs it. What actually distinguishes a real deployment is
 * that it serves a real domain and runs on Vercel — so the mock also requires
 * `ROOT_DOMAIN` to be localhost and `VERCEL` to be unset. A flag copied into
 * production by mistake therefore still enables nothing.
 */
export function mockModelEnabled(): boolean {
  const root = (process.env.ROOT_DOMAIN ?? "").trim().toLowerCase();
  const localRoot = root === "localhost" || root.endsWith(".localhost") || root.startsWith("localhost:");
  return process.env.MARKII_AGENT_MOCK_MODEL === "1" && localRoot && !process.env.VERCEL;
}

type Script = { toolCalls?: { toolName: string; input: unknown }[]; text?: string };

const USAGE = {
  inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 50, text: 50, reasoning: undefined },
};

/** The last user message's text, from a model prompt. */
function lastUserText(prompt: { role: string; content: unknown }[]): string {
  const user = [...prompt].reverse().find((m) => m.role === "user");
  if (!user || !Array.isArray(user.content)) return "";
  return user.content
    .filter((p): p is { type: "text"; text: string } => (p as { type?: string }).type === "text")
    .map((p) => p.text)
    .join("\n");
}

export async function mockModel(): Promise<LanguageModel> {
  // Imported only when enabled, so test helpers never reach a production bundle path.
  const [{ MockLanguageModelV4 }, { simulateReadableStream }] = await Promise.all([
    import("ai/test"),
    import("ai"),
  ]);

  return new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      const last = prompt[prompt.length - 1];
      const afterTools = last?.role === "tool";

      const raw = lastUserText(prompt as never);
      let script: Script = {};
      if (raw.startsWith("MOCK:")) {
        try {
          script = JSON.parse(raw.slice(5)) as Script;
        } catch {
          script = { text: "The mock script was not valid JSON." };
        }
      }

      const calls = !afterTools ? (script.toolCalls ?? []) : [];
      const text = afterTools || calls.length === 0 ? (script.text ?? "Mock reply.") : null;

      const chunks = [
        ...calls.map((c, i) => ({
          type: "tool-call" as const,
          toolCallId: `mock-call-${prompt.length}-${i}`,
          toolName: c.toolName,
          input: JSON.stringify(c.input ?? {}),
        })),
        ...(text
          ? [
              { type: "text-start" as const, id: "t1" },
              { type: "text-delta" as const, id: "t1", delta: text },
              { type: "text-end" as const, id: "t1" },
            ]
          : []),
        {
          type: "finish" as const,
          finishReason: { unified: calls.length ? ("tool-calls" as const) : ("stop" as const), raw: undefined },
          usage: USAGE,
        },
      ];

      return { stream: simulateReadableStream({ chunks }) };
    },
  });
}
