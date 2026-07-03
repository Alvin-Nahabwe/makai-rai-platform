import type { Metadata } from 'next';
import { Source_Sans_3, DM_Serif_Display } from 'next/font/google';
import './globals.css';

const sourceSans = Source_Sans_3({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  variable: '--font-source-sans',
  display: 'swap',
});

const dmSerif = DM_Serif_Display({
  subsets: ['latin'],
  weight: '400',
  variable: '--font-dm-serif',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'MAK-AI Responsible AI Toolkit',
  description: 'Assess and improve responsible AI practices across the ML lifecycle',
  icons: { icon: '/favicon.png', apple: '/favicon-192.png' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sourceSans.variable} ${dmSerif.variable}`}>
      <body>{children}</body>
    </html>
  );
}
