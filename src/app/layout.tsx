import { SpeedInsights } from '@vercel/speed-insights/next';
import type { Metadata } from 'next';
import { type ReactNode, Suspense } from 'react';

import Analytics from '@/components/Analytics';

const inVercel = process.env.VERCEL === '1';

export const metadata: Metadata = {
  metadataBase: new URL('https://arckep.ru'),
  alternates: {
    canonical: '/chat',
  },
};

const RootLayout = ({ children }: { children: ReactNode }) => {
  return (
    <html suppressHydrationWarning lang={'en'} style={{ height: '100%' }}>
      <body style={{ height: '100%', margin: 0 }}>
        {children}
        <Suspense fallback={null}>
          <Analytics />
          {inVercel && <SpeedInsights />}
        </Suspense>
      </body>
    </html>
  );
};

export default RootLayout;
