-- Site builder (Phase D, D51 — docs/BUILDER.md §4, §12): a site design (theme +
-- tokens, draft and published), page documents as JSON node trees, a snapshot per
-- publish, and live-preview sessions. Plus agent_sessions.site_id, so a brand-agent
-- conversation belongs to one storefront.
--
-- Additive: no existing row changes. A site with no site_designs row has never been
-- designed and keeps rendering the fixed storefront.

CREATE TABLE "site_design_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"note" text,
	"published_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_designs" (
	"site_id" integer PRIMARY KEY NOT NULL,
	"draft_theme_id" text NOT NULL,
	"draft_tokens" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"published_tokens" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"draft_revision" integer DEFAULT 0 NOT NULL,
	"published_revision" integer DEFAULT 0 NOT NULL,
	"published_version" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone,
	"agent_lock_session_id" text,
	"agent_lock_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"kind" text DEFAULT 'page' NOT NULL,
	"handle" text NOT NULL,
	"title" text NOT NULL,
	"seo" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"draft_tree" jsonb NOT NULL,
	"draft_deleted" boolean DEFAULT false NOT NULL,
	"published_handle" text,
	"published_title" text,
	"published_seo" jsonb,
	"published_tree" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_preview_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"site_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "site_id" integer;--> statement-breakpoint
ALTER TABLE "site_design_versions" ADD CONSTRAINT "site_design_versions_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_designs" ADD CONSTRAINT "site_designs_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_documents" ADD CONSTRAINT "site_documents_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_preview_sessions" ADD CONSTRAINT "site_preview_sessions_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "site_design_versions_site_version_uq" ON "site_design_versions" USING btree ("site_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "site_documents_site_kind_handle_uq" ON "site_documents" USING btree ("site_id","kind","handle");--> statement-breakpoint
CREATE INDEX "site_documents_published_idx" ON "site_documents" USING btree ("site_id","kind","published_handle");--> statement-breakpoint
CREATE UNIQUE INDEX "site_preview_sessions_token_uq" ON "site_preview_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "site_preview_sessions_site_idx" ON "site_preview_sessions" USING btree ("site_id");--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Deny-by-default, per the standing rule that every table gets RLS even though
-- authorization lives in the action registry. No FORCE: the app connects as the
-- table owner, which RLS exempts.
ALTER TABLE "site_designs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "site_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "site_design_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "site_preview_sessions" ENABLE ROW LEVEL SECURITY;
