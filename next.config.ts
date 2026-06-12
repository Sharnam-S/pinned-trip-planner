import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The trip store reads data/trips/*.json with dynamic fs calls, which
  // output tracing can't see — force the files into every serverless bundle
  // so deployed copies can serve the committed trips.
  outputFileTracingIncludes: {
    "/*": ["data/trips/**/*.json"],
  },
};

export default nextConfig;
