import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.join(__dirname),
  },
  /**
   * The Next.js export (D53) reads the renderer and the app scaffold from disk
   * at request time to zip them, which file tracing cannot see — without this
   * the deployed route has nothing to export.
   */
  outputFileTracingIncludes: {
    "/api/builder/sites/*/next-export": ["./packages/renderer/**/*"],
  },
};

export default nextConfig;
