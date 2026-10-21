/** @type {import('next').NextConfig} */
const nextConfig = {
  // scripts/e2e.mjs runs its own dev server next to yours, so it builds into a separate folder
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // Native modules and PDF tooling run as plain Node packages, not bundled
  serverExternalPackages: ['better-sqlite3', 'simple-git', 'unpdf', 'mammoth', '@napi-rs/canvas'],
};
export default nextConfig;
