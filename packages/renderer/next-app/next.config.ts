import type { NextConfig } from "next";

/** The exported store needs no special configuration: the renderer is plain TypeScript under `renderer/src`. */
const nextConfig: NextConfig = {
  poweredByHeader: false,
};

export default nextConfig;
