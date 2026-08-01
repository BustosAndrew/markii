CREATE TABLE "action_invocations" (
	"id" text PRIMARY KEY NOT NULL,
	"action_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"org_id" text,
	"risk_tier" text NOT NULL,
	"input" jsonb NOT NULL,
	"result" jsonb,
	"diff" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ok" boolean NOT NULL,
	"error_code" text,
	"error_message" text,
	"undoable" boolean DEFAULT false NOT NULL,
	"undone_by_invocation_id" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "action_invocations_occurred_idx" ON "action_invocations" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "action_invocations_action_idx" ON "action_invocations" USING btree ("action_id");--> statement-breakpoint
CREATE INDEX "action_invocations_actor_idx" ON "action_invocations" USING btree ("actor_type","actor_id");--> statement-breakpoint
-- Deny by default, as for every other table (D6). Not FORCE — the app connects
-- as the table owner, which RLS exempts.
ALTER TABLE "action_invocations" ENABLE ROW LEVEL SECURITY;
