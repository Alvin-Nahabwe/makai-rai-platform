import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'MAK-AI Responsible AI Toolkit',
  description: 'Assess and improve responsible AI practices across the ML lifecycle',
  icons: { icon: '/favicon.png', apple: '/favicon-192.png' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=Source+Sans+3:wght@300;400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
