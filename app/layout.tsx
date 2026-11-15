import type { Metadata } from 'next';
import localFont from 'next/font/local';
import OfflineBanner from '@/components/layout/OfflineBanner';
import SkipLink from '@/components/layout/SkipLink';
import Footer from '@/components/layout/Footer';
import { PRODUCT_NAME } from '@/lib/ui/title';
import './globals.css';

// Overpass is served from app/fonts (its licence sits beside it), so no build fetches from Google. next/font/local puts
// `declarations` on every @font-face of one call, so each subset file has its own call with its own unicode-range.
// The calls declare one font-family that equals the name of the core constant, because the CSS variable is built from
// that name. Turbopack needs the values written out, so the ranges repeat. Four files (NFR-PERF-02,
// scripts/fonts/subset.sh):
//  - core: printable ASCII, the characters typed names add (no-break space, en dash, curly quotes, the NFD marks
//    U+0304, U+0308, U+0329) and the few others page copy uses; the only file preloaded, on every page;
//  - rest: the rest of Google's latin range, and the combining marks U+0300-0301, U+0303, U+0309 and U+0323 that the
//    latin file maps (a decomposed name finds them in this file, not in ext-rest; not in core, so no accented letter can
//    be composed from the preloaded file), fetched only by a page that shows one of these characters;
//  - latin-ext, cut in two: ext-common, the latin-ext letters names commonly carry (13,952 B), and ext-rest, every
//    other code point the latin-ext file maps, the dagger U+2020 included. Their ranges are disjoint from each other
//    and from core and rest, and each declares exactly what its file maps, so an inviter's name with U+014B, U+0169 or
//    U+018A on S-04 fetches the 13,952 B file, not the 46,080 B original.
// Where two files of a family cover a code point, a browser tries the one declared last first and falls through to the
// next whose range covers it when that file has no glyph. Each latin-ext call comes first, as in Google's stylesheet.
// Only core is preloaded (next/font adds the preload link with crossorigin); preloading the others would put their
// bytes on every page. Core's fallback is next/font's size-adjusted Arial, which keeps the text where it is when the
// font swaps in; the three others declare no fallback of their own.
// Only its @font-face is wanted; never use this constant's className or variable (the family is overpass).
const _overpassLatinExtRest = localFont({
  src: './fonts/overpass-latin-ext-rest.woff2',
  weight: '400 700',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: 'font-family', value: 'overpass' },
    { prop: 'unicode-range', value: 'U+102-103,U+108-10B,U+10E-111,U+114-115,U+11A-11D,U+120-121,U+124-127,U+12C-12D,U+132-135,U+138-13A,U+13D-140,U+149,U+14E-14F,U+154-157,U+15C-15D,U+162-167,U+16C-16D,U+174-178,U+17F,U+187-189,U+18E-18F,U+191,U+193,U+196-199,U+19D,U+1A0-1A1,U+1A4-1A5,U+1A9,U+1AC-1B4,U+1B7,U+1C0-1F5,U+1F8-21B,U+21E-21F,U+226-233,U+237,U+242-245,U+24B-24C,U+250-252,U+259,U+25F-261,U+265-266,U+268-269,U+26E-26F,U+272,U+279,U+27D-27E,U+283,U+288-28A,U+28C-28E,U+292,U+294-295,U+29E,U+2A1-2A4,U+2A6-2A7,U+2A9-2AC,U+2B0,U+2B2,U+2B7-2BA,U+2C7,U+2C9,U+2D6,U+2DD,U+2E1-2E3,U+1E04-1E05,U+1E0C-1E0F,U+1E12-1E13,U+1E20-1E21,U+1E24-1E25,U+1E2E-1E2F,U+1E36-1E37,U+1E3C-1E3F,U+1E44-1E47,U+1E4A-1E4D,U+1E50-1E53,U+1E6C-1E71,U+1E80-1E85,U+1E92-1E93,U+1E9E,U+1EF2-1EF9,U+2020,U+20A1-20AB,U+20AD-20BF,U+2113,U+2C64,U+2C6D,U+2C72-2C73,U+A78B-A78D,U+A7AA' },
  ],
});
// Only its @font-face is wanted; never use this constant's className or variable (the family is overpass).
const _overpassLatinExtCommon = localFont({
  src: './fonts/overpass-latin-ext-common.woff2',
  weight: '400 700',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: 'font-family', value: 'overpass' },
    { prop: 'unicode-range', value: 'U+100-101,U+104-107,U+10C-10D,U+112-113,U+116-119,U+11E-11F,U+122-123,U+128-12B,U+12E-130,U+136-137,U+13B-13C,U+141-148,U+14A-14D,U+150-151,U+158-15B,U+15E-161,U+168-16B,U+16E-173,U+179-17E,U+181,U+186,U+18A,U+190,U+192,U+194,U+253-254,U+256-257,U+25B,U+263,U+28B,U+1E62-1E63' },
  ],
});
// Only its @font-face is wanted; never use this constant's className or variable (the family is overpass).
const _overpassLatinRest = localFont({
  src: './fonts/overpass-latin-rest.woff2',
  weight: '400 700',
  display: 'swap',
  preload: false,
  adjustFontFallback: false,
  declarations: [
    { prop: 'font-family', value: 'overpass' },
    { prop: 'unicode-range', value: 'U+A1-A6,U+A8-B6,U+B8-FF,U+131,U+152-153,U+2BB-2BC,U+2C6,U+2DA,U+2DC,U+300-301,U+303,U+309,U+323,U+2000-2012,U+2015-2017,U+201E-201F,U+2021-2025,U+2027-206F,U+20AC,U+2122,U+2212,U+2215,U+FEFF,U+FFFD' },
  ],
});
const overpass = localFont({
  src: './fonts/overpass-latin-core.woff2',
  weight: '400 700',
  variable: '--font-overpass',
  display: 'swap',
  adjustFontFallback: 'Arial',
  declarations: [
    { prop: 'font-family', value: 'overpass' },
    { prop: 'unicode-range', value: 'U+20-7E,U+A0,U+A7,U+B7,U+304,U+308,U+329,U+2013-2014,U+2018-201D,U+2026,U+2191,U+2193' },
  ],
});

export const metadata: Metadata = {
  title: PRODUCT_NAME,
  description: 'Assess and improve responsible AI practices across the ML lifecycle',
  icons: { icon: '/favicon.png', apple: '/favicon-192.png' },
};

// Applied before first paint so a user's saved theme choice doesn't flash the
// wrong colours. When no explicit choice is stored, CSS `prefers-color-scheme`
// takes over.
const themeInitScript = `(function(){try{var t=localStorage.getItem('theme');if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={overpass.variable} suppressHydrationWarning>
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
