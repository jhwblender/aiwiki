/** @type {import('next').NextConfig} */
const nextConfig = {
  // scripts/e2e.mjs runs its own dev server next to yours, so it builds into a separate folder
  distDir: process.env.NEXT_DIST_DIR || '.next',
  serverExternalPackages: ['better-sqlite3', 'simple-git'],
};
export default nextConfig;
