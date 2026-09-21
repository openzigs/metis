import path from "node:path";

const repoRoot = process.cwd().endsWith("/ui") ? process.cwd().slice(0, -3) : process.cwd();
const sharedDist = path.relative(
  process.cwd(),
  path.join(repoRoot, "packages/shared/dist/index.js"),
);
const uiKitSrc = path.relative(process.cwd(), path.join(repoRoot, "packages/ui-kit/src/index.ts"));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Allow the Playwright e2e UI server to use an isolated build/dev directory
  // (e.g. `.next-e2e`) via `NEXT_DIST_DIR` so it can boot alongside a
  // developer's already-running `next dev` stack without tripping Next's
  // per-project dev lock. No-op in normal dev/CI (default `.next`).
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  // Next.js dev rejects HMR/runtime requests from origins it doesn't recognise.
  // The e2e suite drives the app over the loopback IP (http://127.0.0.1), which
  // is not in Next's default allow list, so the dev React runtime never loads
  // and pages fail to hydrate (forms fall back to native GET submits). List the
  // loopback hosts explicitly. Dev-only — ignored by the production build.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // Emit a standalone server bundle (.next/standalone) so Dockerfile.ui can
  // ship a minimal runtime image without the full pnpm node_modules tree.
  // See: https://nextjs.org/docs/app/api-reference/next-config-js/output
  output: "standalone",
  // Allow importing the workspace shared package's source TypeScript directly.
  transpilePackages: ["@metis/shared", "@metis/ui-kit"],
  typedRoutes: false,
  // We're inside a multi-package workspace; pin tracing to the metis repo so
  // Next doesn't try to climb above the repo into ~/Development.
  outputFileTracingRoot: repoRoot,
  turbopack: {
    resolveAlias: {
      "@metis/shared": sharedDist,
      "@metis/ui-kit": uiKitSrc,
    },
    resolveExtensions: [".tsx", ".ts", ".jsx", ".js", ".json"],
  },
  webpack(config) {
    // The @metis/shared sources use NodeNext-style `.js` extensions on
    // TypeScript imports. Map those to `.ts` (or fall back to `.js`) so
    // webpack can resolve them when the package is transpiled in-tree.
    config.resolve = config.resolve ?? {};
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
