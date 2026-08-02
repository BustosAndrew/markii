CREATE TABLE "readiness_issue_states" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"issue_id" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"assigned_to" text,
	"note" text,
	"actor_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "readiness_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"scope" text NOT NULL,
	"scope_id" integer,
	"day" text NOT NULL,
	"score" integer NOT NULL,
	"components" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"counts" jsonb DEFAULT '{"critical":0,"warning":0,"opportunity":0}'::jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "readiness_snapshots_uq" UNIQUE NULLS NOT DISTINCT("org_id","scope","scope_id","day")
);
--> statement-breakpoint
ALTER TABLE "readiness_issue_states" ADD CONSTRAINT "readiness_issue_states_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "readiness_snapshots" ADD CONSTRAINT "readiness_snapshots_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "readiness_issue_states_uq" ON "readiness_issue_states" USING btree ("org_id","issue_id");--> statement-breakpoint
CREATE INDEX "readiness_snapshots_org_day_idx" ON "readiness_snapshots" USING btree ("org_id","day");--> statement-breakpoint

-- A score outside 0–100 is a bug in the weighting, and it would render as a
-- broken progress bar rather than an obvious error.
ALTER TABLE "readiness_snapshots" ADD CONSTRAINT "readiness_snapshots_score_range" CHECK ("score" >= 0 AND "score" <= 100);--> statement-breakpoint

-- Deny by default (D6).
ALTER TABLE "readiness_issue_states" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "readiness_snapshots" ENABLE ROW LEVEL SECURITY;
