import type { Metadata } from 'next';
import localFont from 'next/font/local';
import './globals.css';

// Source Sans 3 and DM Serif Display are served from app/fonts (their licences sit beside them), so no build
// fetches from Google. next/font/local puts `declarations` on every @font-face of one call, so each subset file
// has its own call with its own unicode-range, copied from the CSS next/font/google produced. The calls of one
// family declare one font-family that equals the name of that family's latin constant, because the CSS variable
// is built from that name. Turbopack needs the values written out, so the ranges repeat. Only the latin files
// are preloaded; a latin-ext file loads when a page uses one of its characters.
const sourceSans = localFont({
  src: './fonts/source-sans-3-latin.woff2',
  weight: '300 700',
  variable: '--font-source-sans',
  display: 'swap',
  declarations: [
    { prop: 'font-family', value: 'sourceSans' },
    { prop: 'unicode-range', value: 'U+??,U+131,U+152-153,U+2BB-2BC,U+2C6,U+2DA,U+2DC,U+304,U+308,U+329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD' },
  ],
});
const _sourceSansLatinExt = localFont({
  src: './fonts/source-sans-3-latin-ext.woff2',
  weight: '300 700',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: 'font-family', value: 'sourceSans' },
    { prop: 'unicode-range', value: 'U+100-2BA,U+2BD-2C5,U+2C7-2CC,U+2CE-2D7,U+2DD-2FF,U+304,U+308,U+329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF' },
  ],
});

const dmSerif = localFont({
  src: './fonts/dm-serif-display-latin.woff2',
  weight: '400',
  variable: '--font-dm-serif',
  display: 'swap',
  declarations: [
    { prop: 'font-family', value: 'dmSerif' },
    { prop: 'unicode-range', value: 'U+??,U+131,U+152-153,U+2BB-2BC,U+2C6,U+2DA,U+2DC,U+304,U+308,U+329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD' },
  ],
});
const _dmSerifLatinExt = localFont({
  src: './fonts/dm-serif-display-latin-ext.woff2',
  weight: '400',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: 'font-family', value: 'dmSerif' },
    { prop: 'unicode-range', value: 'U+100-2BA,U+2BD-2C5,U+2C7-2CC,U+2CE-2D7,U+2DD-2FF,U+304,U+308,U+329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF' },
  ],
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
    <html lang="en" className={`${sourceSans.variable} ${dmSerif.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
