import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // The e2e production server builds into its own folder so it never
  // clashes with the dev server's .next (playwright.config.ts).
  distDir: process.env.TAPEDECK_DIST_DIR || ".next",
  // The dev-only "N" badge covers the player's cover art in the corner.
  devIndicators: false,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
