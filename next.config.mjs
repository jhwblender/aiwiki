/** @type {import('next').NextConfig} */
const nextConfig = {
  // scripts/e2e.mjs runs its own dev server next to yours, so it builds into a separate folder
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // Native modules and PDF tooling run as plain Node packages, not bundled
  serverExternalPackages: ['better-sqlite3', 'simple-git', 'unpdf', 'mammoth', '@napi-rs/canvas'],
  poweredByHeader: false,
  // The wiki is never shown inside another site's page, and links out do not carry the page address
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
};
export default nextConfig;
