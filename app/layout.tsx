import type { Metadata } from 'next';
import localFont from 'next/font/local';
import OfflineBanner from '@/components/layout/OfflineBanner';
import SkipLink from '@/components/layout/SkipLink';
import Footer from '@/components/layout/Footer';
import './globals.css';

// Source Sans 3 and DM Serif Display are served from app/fonts (their licences sit beside them), so no build
// fetches from Google. next/font/local puts `declarations` on every @font-face of one call, so each subset file
// has its own call with its own unicode-range. The calls of one family declare one font-family that equals the name
// of that family's core constant, because the CSS variable is built from that name. Turbopack needs the values
// written out, so the ranges repeat. Each family has three files (NFR-PERF-02, scripts/fonts/subset.sh):
//  - core: printable ASCII and the few other characters page copy uses; the only file preloaded, on every page;
//  - rest: the rest of Google's latin range, fetched only by a page that shows one of its characters;
//  - latin-ext: Google's latin-ext file as it was, fetched the same way.
// Where two files of a family cover a code point, the one declared last wins. Each latin-ext call comes first, as in
// Google's stylesheet, so the code points it shares with the latin range resolve to the rest file, as they resolved
// to the latin file before; core and rest share none.
// Only its @font-face is wanted; never use this constant's className or variable (the family is sourceSans).
const _sourceSansLatinExt = localFont({
  src: './fonts/source-sans-3-latin-ext.woff2',
  weight: '400 700',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: 'font-family', value: 'sourceSans' },
    { prop: 'unicode-range', value: 'U+100-2BA,U+2BD-2C5,U+2C7-2CC,U+2CE-2D7,U+2DD-2FF,U+304,U+308,U+329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF' },
  ],
});
// Only its @font-face is wanted; never use this constant's className or variable (the family is sourceSans).
const _sourceSansLatinRest = localFont({
  src: './fonts/source-sans-3-latin-rest.woff2',
  weight: '400 700',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: 'font-family', value: 'sourceSans' },
    { prop: 'unicode-range', value: 'U+A0-A6,U+A8-B6,U+B8-FF,U+131,U+152-153,U+2BB-2BC,U+2C6,U+2DA,U+2DC,U+304,U+308,U+329,U+2000-2013,U+2015-2025,U+2027-206F,U+20AC,U+2122,U+2212,U+2215,U+FEFF,U+FFFD' },
  ],
});
const sourceSans = localFont({
  src: './fonts/source-sans-3-latin-core.woff2',
  weight: '400 700',
  variable: '--font-source-sans',
  display: 'swap',
  declarations: [
    { prop: 'font-family', value: 'sourceSans' },
    { prop: 'unicode-range', value: 'U+20-7E,U+A7,U+B7,U+2014,U+2026,U+2191,U+2193' },
  ],
});

// Only its @font-face is wanted; never use this constant's className or variable (the family is dmSerif).
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
// Only its @font-face is wanted; never use this constant's className or variable (the family is dmSerif).
const _dmSerifLatinRest = localFont({
  src: './fonts/dm-serif-display-latin-rest.woff2',
  weight: '400',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: 'font-family', value: 'dmSerif' },
    { prop: 'unicode-range', value: 'U+A0-A6,U+A8-B6,U+B8-FF,U+131,U+152-153,U+2BB-2BC,U+2C6,U+2DA,U+2DC,U+304,U+308,U+329,U+2000-2013,U+2015-2025,U+2027-206F,U+20AC,U+2122,U+2212,U+2215,U+FEFF,U+FFFD' },
  ],
});
const dmSerif = localFont({
  src: './fonts/dm-serif-display-latin-core.woff2',
  weight: '400',
  variable: '--font-dm-serif',
  display: 'swap',
  adjustFontFallback: 'Times New Roman',
  declarations: [
    { prop: 'font-family', value: 'dmSerif' },
    { prop: 'unicode-range', value: 'U+20-7E,U+A7,U+B7,U+2014,U+2026,U+2191,U+2193' },
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
      <body>
        <SkipLink />
        <OfflineBanner />
        {children}
        <Footer />
      </body>
    </html>
  );
}
