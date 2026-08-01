/**
 * Creates the two Storage buckets this app needs (§18.8, D6).
 *
 * Run: `pnpm storage:init`
 *
 * Buckets are **not** part of the SQL migration chain — Supabase creates them
 * through its Storage API, not DDL — so without this they are a manual dashboard
 * step, which is exactly the kind of setup that gets forgotten on a new
 * environment and surfaces as uploads failing in production.
 *
 * Idempotent: an existing bucket is reported, not treated as an error. An
 * existing bucket with the **wrong privacy** is a hard failure, because a public
 * `digital-assets` means every file a merchant sells is downloadable by anyone
 * with the URL, and every download limit in §18.8 is decoration.
 *
 * The client is built here rather than imported from `lib/storage`, which is
 * `server-only` and therefore unimportable outside a Next build. Only the client
 * is duplicated — the bucket names and privacy flags come from
 * `lib/storage/buckets.ts`, so this cannot provision something the app does not
 * expect.
 */
import { createClient } from "@supabase/supabase-js";
import { BUCKETS } from "../lib/storage/buckets";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    console.error(
      "✖ Storage is not configured.\n" +
        "  Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local\n" +
        "  (service role is server-only — never a NEXT_PUBLIC_ variable).",
    );
    process.exit(1);
  }

  const client = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: existing, error: listError } = await client.storage.listBuckets();
  if (listError) {
    console.error(`✖ could not list buckets: ${listError.message}`);
    process.exit(1);
  }

  const byName = new Map((existing ?? []).map((b) => [b.name, b]));

  for (const bucket of BUCKETS) {
    const label = bucket.public ? "public" : "private";
    const current = byName.get(bucket.name);

    if (current) {
      if (current.public !== bucket.public) {
        console.error(
          `✖ bucket "${bucket.name}" is ${current.public ? "public" : "private"} — expected ${label}.\n` +
            (bucket.public
              ? "  Product images must be publicly readable or storefront pages break."
              : "  A public digital-assets bucket exposes every file merchants sell, and makes\n" +
                "  download limits meaningless. Fix this before selling anything."),
        );
        process.exitCode = 1;
      } else {
        console.log(`  = ${bucket.name} (${label}) already exists`);
      }
      continue;
    }

    const { error } = await client.storage.createBucket(bucket.name, { public: bucket.public });
    if (error) {
      console.error(`✖ could not create "${bucket.name}": ${error.message}`);
      process.exitCode = 1;
    } else {
      console.log(`  + created ${bucket.name} (${label})`);
    }
  }

  if (!process.exitCode) console.log("✔ storage buckets ready");
}

main().catch((e) => {
  console.error("bucket setup failed:", e);
  process.exit(1);
});
