ALTER TABLE "blog_posts" ADD COLUMN "requires_tier_id" integer;--> statement-breakpoint
ALTER TABLE "site_documents" ADD COLUMN "requires_tier_id" integer;--> statement-breakpoint
ALTER TABLE "site_documents" ADD COLUMN "published_requires_tier_id" integer;--> statement-breakpoint
ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_posts_requires_tier_id_membership_tiers_id_fk" FOREIGN KEY ("requires_tier_id") REFERENCES "public"."membership_tiers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_documents" ADD CONSTRAINT "site_documents_requires_tier_id_membership_tiers_id_fk" FOREIGN KEY ("requires_tier_id") REFERENCES "public"."membership_tiers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_documents" ADD CONSTRAINT "site_documents_published_requires_tier_id_membership_tiers_id_fk" FOREIGN KEY ("published_requires_tier_id") REFERENCES "public"."membership_tiers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blog_posts_requires_tier_idx" ON "blog_posts" USING btree ("requires_tier_id");--> statement-breakpoint
CREATE INDEX "site_documents_requires_tier_idx" ON "site_documents" USING btree ("requires_tier_id");--> statement-breakpoint
CREATE INDEX "site_documents_published_requires_tier_idx" ON "site_documents" USING btree ("published_requires_tier_id");