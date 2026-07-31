import { NextResponse } from "next/server";
import { invokeAction } from "@/lib/actions";
import { orgHandler } from "@/lib/auth/handler";

/**
 * `POST /api/actions/:id` — invoke (§22).
 *
 * Same validation, permissions, and audit for every caller: a click, an agent
 * turn, an MCP client, or CI all arrive here. There is no privileged path around
 * it, which is the entire point of the registry.
 *
 * `?dryRun=1` returns the diff the invocation *would* produce without writing —
 * this is how the agent proposal flow builds a proposal (§22 rule 2), not a
 * separate proposal engine.
 */
export const POST = orgHandler(async (req, { params, session }) => {
  const { id } = await params;
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";

  const raw = await req.text();
  const input = raw ? JSON.parse(raw) : {};

  const outcome = await invokeAction(id, input, { actor: session.actor, dryRun });
  return NextResponse.json(outcome);
});
