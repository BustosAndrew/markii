CREATE TABLE "blog_posts" (
	"id" serial PRIMARY KEY NOT NULL,
	"site_id" integer NOT NULL,
	"handle" text NOT NULL,
	"title" text NOT NULL,
	"excerpt" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"cover_image" text,
	"cover_alt" text DEFAULT '' NOT NULL,
	"author" text DEFAULT '' NOT NULL,
	"seo" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_posts_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "blog_posts_site_handle_uq" ON "blog_posts" USING btree ("site_id","handle");--> statement-breakpoint
CREATE INDEX "blog_posts_site_published_idx" ON "blog_posts" USING btree ("site_id","published_at");

-- Deny-by-default, like every table: authorization lives in the action registry.
ALTER TABLE "blog_posts" ENABLE ROW LEVEL SECURITY;
