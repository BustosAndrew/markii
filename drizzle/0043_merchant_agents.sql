-- Merchant agents (D47, docs/AGENT-OPS.md): the catalog agent's sessions, its
-- proposals, and the beta usage ledger.
--
-- A proposal is a stored dry run. The agent writes rows here and nowhere else;
-- the catalog changes only when a person approves one, and then through
-- invokeAction as that person. The transcript is server-side so a client
-- cannot hand the model an invented history.

CREATE TABLE "agent_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"org_id" text NOT NULL,
	"agent" text NOT NULL,
	"action_id" text NOT NULL,
	"input" jsonb NOT NULL,
	"diff" jsonb NOT NULL,
	"risk_tier" text NOT NULL,
	"summary" text NOT NULL,
	"rationale" text,
	"affected_count" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"invocation_id" text,
	"error" text,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent" text NOT NULL,
	"title" text,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"session_id" text,
	"agent" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD CONSTRAINT "agent_proposals_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD CONSTRAINT "agent_proposals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_usage" ADD CONSTRAINT "agent_usage_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_usage" ADD CONSTRAINT "agent_usage_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_proposals_session_idx" ON "agent_proposals" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_proposals_org_status_idx" ON "agent_proposals" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "agent_sessions_owner_idx" ON "agent_sessions" USING btree ("org_id","user_id","updated_at");--> statement-breakpoint
CREATE INDEX "agent_usage_org_idx" ON "agent_usage" USING btree ("org_id","created_at");
--> statement-breakpoint

-- Deny-by-default, per the standing rule that every table gets RLS even though
-- authorization lives in the action registry. No FORCE: the app connects as the
-- table owner, which RLS exempts.
ALTER TABLE "agent_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_proposals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_usage" ENABLE ROW LEVEL SECURITY;
