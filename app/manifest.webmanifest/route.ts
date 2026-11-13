import type { MetadataRoute } from 'next';

// Lets browsers install the wiki as an app of its own (Chrome and Edge on Android and Windows offer it).
// Served from a route rather than Next's manifest file so the page can link it with credentials
// (app/layout.tsx): behind a sign-in in front of the whole site, such as Cloudflare Access, a
// manifest fetched without cookies would get the sign-in page instead and installing would fail.
const manifest: MetadataRoute.Manifest = {
  name: 'Wiki',
  short_name: 'Wiki',
  description: 'A wiki with a built-in assistant',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#f4f6f8',
  theme_color: '#146c73',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};

export const dynamic = 'force-static';

export function GET() {
  return new Response(JSON.stringify(manifest), { headers: { 'Content-Type': 'application/manifest+json' } });
}
