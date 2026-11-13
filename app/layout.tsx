import type { Metadata, Viewport } from 'next';
import './globals.css';
import { themeScript } from '@/lib/theme';

export const metadata: Metadata = {
  title: 'Wiki',
  description: 'A wiki with a built-in assistant',
  icons: { icon: '/icon.svg', apple: '/apple-icon.png' },
  appleWebApp: { capable: true, title: 'Wiki' },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#146c73' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <link rel="manifest" href="/manifest.webmanifest" crossOrigin="use-credentials" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
