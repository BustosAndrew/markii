import { NextResponse } from "next/server";
import { orgHandler } from "@/lib/auth/handler";
import { setupStatus } from "@/lib/setup";

/**
 * `GET /api/setup` — the first-run setup checklist (§28).
 *
 * Derived from the live store on every call; nothing to mark done. The same
 * function backs the assistant's `setup_status` tool, so the checklist a
 * screen shows and the one the assistant talks about are the same answer.
 *
 * `org.read`, which every role holds: a viewer may see what is left to do,
 * and each step's `canAct` says whether their role could do it.
 */
export const GET = orgHandler(
  async (_req, { session }) => NextResponse.json(await setupStatus(session)),
  { permission: "org.read" },
);
