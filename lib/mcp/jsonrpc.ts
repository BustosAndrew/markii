/**
 * The JSON-RPC 2.0 envelope MCP rides on.
 *
 * **Hand-rolled rather than taken from `@modelcontextprotocol/sdk`.** The SDK's
 * Streamable HTTP transport is written against Node's `http.ServerResponse`,
 * and a Next route handler deals in Web `Request`/`Response` — bridging those
 * is more code, and stranger code, than the stateless subset of the protocol
 * actually needs. This repo has taken the same trade before, with SigV4 for SES
 * and base32 for TOTP.
 *
 * **Revisit that if sessions, server-initiated messages, or sampling are ever
 * wanted.** Those are the parts worth a dependency; request/response is not.
 */

export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

/** Standard JSON-RPC codes, plus the one MCP adds for an unknown tool. */
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

export function rpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

export function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0" as const, id, error: { code, message, ...(data ? { data } : {}) } };
}

/**
 * A notification has no `id` and **must not** be answered.
 *
 * Getting this wrong is the classic JSON-RPC bug: replying to
 * `notifications/initialized` puts a response on the wire the client is not
 * waiting for, and strict clients treat that as a protocol violation.
 */
export function isNotification(msg: JsonRpcRequest): boolean {
  return msg.id === undefined;
}

export function isValidRequest(msg: unknown): msg is JsonRpcRequest {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return false;
  const m = msg as Record<string, unknown>;
  return m.jsonrpc === "2.0" && typeof m.method === "string";
}
