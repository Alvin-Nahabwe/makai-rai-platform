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
//  - core: printable ASCII, the characters typed names add (no-break space, en dash, curly quotes, the NFD marks
//    U+0304, U+0308, U+0329) and the few others page copy uses; the only file preloaded, on every page;
//  - rest: the rest of Google's latin range, fetched only by a page that shows one of its characters;
//  - latin-ext: Google's latin-ext file as it was, fetched the same way. Source Sans 3's is cut in two
//    (scripts/fonts/subset.sh): ext-common, the latin-ext letters names commonly carry (8.6 KB), and ext-rest, the
//    rest of what the file maps; their ranges are disjoint from each other and from core and rest, and each declares
//    exactly what its file maps, so an inviter's name with U+014B on S-04 fetches 8.6 KB, not 60 KB.
// Where two files of a family cover a code point, the one declared last wins. Each latin-ext call comes first, as in
// Google's stylesheet, so the code points it shares with the latin range (U+0304, U+0308, U+0329 in core; U+0131,
// U+0152-0153 and U+2020 in rest) resolve to a file cut from the latin one, as they resolved to the latin file before;
// core and rest share none.
// Only its @font-face is wanted; never use this constant's className or variable (the family is sourceSans).
const _sourceSansLatinExtRest = localFont({
  src: './fonts/source-sans-3-latin-ext-rest.woff2',
  weight: '400 700',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: 'font-family', value: 'sourceSans' },
    { prop: 'unicode-range', value: 'U+102-103,U+108-10B,U+10E-111,U+114-117,U+11A-11D,U+120-129,U+12C-12F,U+132-140,U+145-146,U+149,U+14E-14F,U+154-157,U+15C-15D,U+162-169,U+16C-16D,U+172-178,U+17F-181,U+18A,U+18D-18F,U+192-194,U+196-197,U+19A-19B,U+19E,U+1A0-1A1,U+1AF-1B1,U+1B7,U+1BF-1C3,U+1CD-1DD,U+1E2-1E7,U+1EA-1EB,U+1EE-1F0,U+1F4-1F5,U+1F7-201,U+204-205,U+208-209,U+20C-20D,U+218-220,U+222-223,U+226-227,U+237,U+23A-23E,U+241-245,U+248-249,U+250-253,U+255-25A,U+25C-27B,U+27D-285,U+287-292,U+294-295,U+298-299,U+29B-29F,U+2A1-2A8,U+2B0-2B4,U+2B7-2B9,U+2BD-2C1,U+2C7-2CC,U+2D0-2D7,U+2DD-2DE,U+2E0-2E4,U+2ED,U+1D25,U+1D2C,U+1D2E,U+1D30-1D31,U+1D33-1D3A,U+1D3C,U+1D3E-1D43,U+1D47-1D4B,U+1D4D,U+1D4F-1D52,U+1D56-1D58,U+1D5B,U+1D6F-1D70,U+1D79,U+1D7B,U+1D7F,U+1D9C,U+1DA0,U+1DAC,U+1DAE,U+1DB0,U+1DBB,U+1DBF,U+1E02-1E03,U+1E06-1E07,U+1E0A-1E11,U+1E16-1E17,U+1E1E-1E2B,U+1E32-1E3B,U+1E3E-1E49,U+1E52-1E53,U+1E56-1E63,U+1E66-1E67,U+1E6A-1E6F,U+1E72-1E73,U+1E7E-1E85,U+1E8E-1E97,U+1E9E-1E9F,U+1EF2-1EF9,U+20A1,U+20A3-20A4,U+20A6-20A7,U+20A9,U+20AB,U+20AE,U+20B1-20B2,U+20B4-20B5,U+20B8-20BA,U+20BD,U+2113,U+2C60-2C62,U+2C65-2C66,U+2C71,U+2C7D,U+A722-A725,U+A74E-A74F,U+A75A-A75B,U+A764-A765,U+A779-A787,U+A789,U+A7AD-A7AE,U+A7B3,U+A7B5,U+A7F2-A7F4' },
  ],
});
// Only its @font-face is wanted; never use this constant's className or variable (the family is sourceSans).
const _sourceSansLatinExtCommon = localFont({
  src: './fonts/source-sans-3-latin-ext-common.woff2',
  weight: '400 700',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: 'font-family', value: 'sourceSans' },
    { prop: 'unicode-range', value: 'U+100-101,U+104-107,U+10C-10D,U+112-113,U+118-119,U+11E-11F,U+12A-12B,U+130,U+141-144,U+147-148,U+14A-14D,U+150-151,U+158-15B,U+15E-161,U+16A-16B,U+16E-171,U+179-17E,U+186,U+190,U+254,U+25B' },
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
    { prop: 'unicode-range', value: 'U+A1-A6,U+A8-B6,U+B8-FF,U+131,U+152-153,U+2BB-2BC,U+2C6,U+2DA,U+2DC,U+2000-2012,U+2015-2017,U+201E-2025,U+2027-206F,U+20AC,U+2122,U+2212,U+2215,U+FEFF,U+FFFD' },
  ],
});
const sourceSans = localFont({
  src: './fonts/source-sans-3-latin-core.woff2',
  weight: '400 700',
  variable: '--font-source-sans',
  display: 'swap',
  declarations: [
    { prop: 'font-family', value: 'sourceSans' },
    { prop: 'unicode-range', value: 'U+20-7E,U+A0,U+A7,U+B7,U+304,U+308,U+329,U+2013-2014,U+2018-201D,U+2026,U+2191,U+2193' },
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
    { prop: 'unicode-range', value: 'U+A1-A6,U+A8-B6,U+B8-FF,U+131,U+152-153,U+2BB-2BC,U+2C6,U+2DA,U+2DC,U+2000-2012,U+2015-2017,U+201E-2025,U+2027-206F,U+20AC,U+2122,U+2212,U+2215,U+FEFF,U+FFFD' },
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
    { prop: 'unicode-range', value: 'U+20-7E,U+A0,U+A7,U+B7,U+304,U+308,U+329,U+2013-2014,U+2018-201D,U+2026,U+2191,U+2193' },
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
