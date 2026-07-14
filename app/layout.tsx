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

// Applied before first paint so a user's saved theme choice doesn't flash the
// wrong colours. When no explicit choice is stored, CSS `prefers-color-scheme`
// takes over.
const themeInitScript = `(function(){try{var t=localStorage.getItem('theme');if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sourceSans.variable} ${dmSerif.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
