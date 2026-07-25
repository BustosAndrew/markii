import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

// Placeholder keeps `next build` working before DATABASE_URL is configured;
// no connection is made until the first query.
const connectionString =
  process.env.DATABASE_URL ??
  "postgresql://placeholder:placeholder@ep-placeholder.us-east-2.aws.neon.tech/neondb?sslmode=require";

export const db = drizzle(neon(connectionString), { schema });

export * from "./schema";
