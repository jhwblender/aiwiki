import type { MetadataRoute } from 'next';

// Lets browsers install the wiki as an app of its own (Chrome and Edge on Android and Windows offer it)
export default function manifest(): MetadataRoute.Manifest {
  return {
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
}
