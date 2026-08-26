import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

export default function nextConfig(phase: string): NextConfig {
  const isVercelBuild = process.env.VERCEL === "1";

  return {
    reactStrictMode: true,
    // Keep production validation from overwriting the active dev server's CSS/assets.
    // Vercel's Next.js adapter requires the conventional `.next` output folder.
    distDir:
      phase === PHASE_DEVELOPMENT_SERVER || isVercelBuild
        ? ".next"
        : ".next-build",
  };
}
