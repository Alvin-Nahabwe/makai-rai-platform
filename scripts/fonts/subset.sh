#!/usr/bin/env bash
# Regenerates the latin files per family that app/layout.tsx loads (and Source Sans 3's two latin-ext files), from the originals under fonts/source/
# (the latin subsets next/font/google downloaded, unit FONTS, register row D-279). NFR-PERF-02 (SRS line 3195):
# every public page preloads one file of each family, so the preloaded "core" file holds only printable ASCII and
# the few other characters page copy and typed names use. The rest of the original latin range goes into a "rest"
# file that is not preloaded; a browser fetches it only when a page shows one of its characters.
#
# The two ranges below are the unicode-range values app/layout.tsx declares; __tests__/unit/font-subsets.test.ts
# checks that they split the original range (controls aside), that every glyph of the original is in the file
# whose range declares it, and that this script and the layout agree. Change a range here and in the layout
# together, run this script, and re-pin the four files in __tests__/unit/local-fonts.test.ts.
#
# The WOFF2 bytes depend on fontTools and on the brotli module, so the script refuses other versions than the ones
# that made the committed files (fontTools 4.46.0, brotli 1.1.0) unless SUBSET_ANY_VERSION=1; with other versions
# the fonts are the same but the sha256 pins will differ. Run from the repository root:
#   scripts/fonts/subset.sh
set -euo pipefail

cd "$(dirname "$0")/../.."

# Printable ASCII; the no-break space, en dash and curly quotes that typed names carry; the combining macron,
# diaeresis and dot below that follow an ASCII letter in decomposed (NFD) text; and the section sign, middle dot,
# em dash, ellipsis and up and down arrows that page copy uses.
CORE='U+20-7E,U+A0,U+A7,U+B7,U+304,U+308,U+329,U+2013-2014,U+2018-201D,U+2026,U+2191,U+2193'
# The original latin range (U+??,U+131,U+152-153,...) less CORE, less the C0 and C1 controls and DEL, and less the
# dagger U+2020, which neither latin file maps and both latin-ext files do (EXT_REST below; DM Serif's ext declares it).
REST='U+A1-A6,U+A8-B6,U+B8-FF,U+131,U+152-153,U+2BB-2BC,U+2C6,U+2DA,U+2DC,U+2000-2012,U+2015-2017,U+201E-201F,U+2021-2025,U+2027-206F,U+20AC,U+2122,U+2212,U+2215,U+FEFF,U+FFFD'
# Source Sans 3's latin-ext file (fonts/source/) is cut in two as well. EXT_COMMON: the latin-ext letters names
# commonly carry (Luganda's eng; Kikuyu, Kamba and Meru i and u with tilde; Hausa hooked b and d; Ewe and Yoruba
# letters the file maps; open e and open o; the macron vowels; Polish, Czech, Slovak, Hungarian, Turkish, Romanian,
# Lithuanian and Latvian letters), at most 12,000 B, so such a name on the public invitation page S-04 fetches about
# 11.8 KB, not 60 KB. Croatian D with stroke is left out: with it the face is 12,276 B. EXT_REST: every other code point
# the file maps inside Google's latin-ext range, less the code points core declares (U+0304, U+0308, U+0329), so the
# four faces of the family are disjoint and each declares exactly what it maps.
EXT_COMMON='U+100-107,U+10C-10D,U+112-113,U+116-119,U+11E-11F,U+122-123,U+128-12B,U+130,U+136-137,U+13B-13C,U+141-148,U+14A-14D,U+150-151,U+158-15B,U+15E-161,U+168-16B,U+16E-173,U+179-17E,U+181,U+186,U+18A,U+190,U+192,U+194,U+218-21B,U+253-254,U+256-257,U+25B,U+263,U+28B,U+1E62-1E63'
EXT_REST='U+108-10B,U+10E-111,U+114-115,U+11A-11D,U+120-121,U+124-127,U+12C-12F,U+132-135,U+138-13A,U+13D-140,U+149,U+14E-14F,U+154-157,U+15C-15D,U+162-167,U+16C-16D,U+174-178,U+17F-180,U+18D-18F,U+193,U+196-197,U+19A-19B,U+19E,U+1A0-1A1,U+1AF-1B1,U+1B7,U+1BF-1C3,U+1CD-1DD,U+1E2-1E7,U+1EA-1EB,U+1EE-1F0,U+1F4-1F5,U+1F7-201,U+204-205,U+208-209,U+20C-20D,U+21C-220,U+222-223,U+226-227,U+237,U+23A-23E,U+241-245,U+248-249,U+250-252,U+255,U+258-25A,U+25C-262,U+264-27B,U+27D-285,U+287-28A,U+28C-292,U+294-295,U+298-299,U+29B-29F,U+2A1-2A8,U+2B0-2B4,U+2B7-2B9,U+2BD-2C1,U+2C7-2CC,U+2D0-2D7,U+2DD-2DE,U+2E0-2E4,U+2ED,U+1D25,U+1D2C,U+1D2E,U+1D30-1D31,U+1D33-1D3A,U+1D3C,U+1D3E-1D43,U+1D47-1D4B,U+1D4D,U+1D4F-1D52,U+1D56-1D58,U+1D5B,U+1D6F-1D70,U+1D79,U+1D7B,U+1D7F,U+1D9C,U+1DA0,U+1DAC,U+1DAE,U+1DB0,U+1DBB,U+1DBF,U+1E02-1E03,U+1E06-1E07,U+1E0A-1E11,U+1E16-1E17,U+1E1E-1E2B,U+1E32-1E3B,U+1E3E-1E49,U+1E52-1E53,U+1E56-1E61,U+1E66-1E67,U+1E6A-1E6F,U+1E72-1E73,U+1E7E-1E85,U+1E8E-1E97,U+1E9E-1E9F,U+1EF2-1EF9,U+2020,U+20A1,U+20A3-20A4,U+20A6-20A7,U+20A9,U+20AB,U+20AE,U+20B1-20B2,U+20B4-20B5,U+20B8-20BA,U+20BD,U+2113,U+2C60-2C62,U+2C65-2C66,U+2C71,U+2C7D,U+A722-A725,U+A74E-A74F,U+A75A-A75B,U+A764-A765,U+A779-A787,U+A789,U+A7AD-A7AE,U+A7B3,U+A7B5,U+A7F2-A7F4'

# One interpreter both reports the versions and subsets, so the check is about the code that writes the files.
python3 -c 'import fontTools.subset, brotli' 2>/dev/null || { echo 'python3 cannot import fontTools.subset and brotli' >&2; exit 1; }
versions="$(python3 -c 'import fontTools, brotli; print(fontTools.version, brotli.__version__)')"
echo "fontTools and brotli: $versions"
if [ "$versions" != '4.46.0 1.1.0' ] && [ "${SUBSET_ANY_VERSION:-}" != 1 ]; then
  echo 'the committed files were made with fontTools 4.46.0 and brotli 1.1.0; set SUBSET_ANY_VERSION=1 to go on' >&2
  exit 1
fi

# Every file is written to a temporary directory first, so a failed run replaces none of the committed files.
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
for family in source-sans-3 dm-serif-display; do
  src="fonts/source/${family}-latin.woff2"
  for part in core rest; do
    if [ "$part" = core ]; then range="$CORE"; else range="$REST"; fi
    # Every layout feature and every name record is kept, so the subset shapes and names itself as the original did.
    python3 -m fontTools.subset "$src" \
      --unicodes="$range" \
      --layout-features='*' \
      --name-IDs='*' \
      --name-languages='*' \
      --notdef-outline \
      --flavor=woff2 \
      --output-file="$out/${family}-latin-${part}.woff2"
  done
done
for part in common rest; do
  if [ "$part" = common ]; then range="$EXT_COMMON"; else range="$EXT_REST"; fi
  python3 -m fontTools.subset fonts/source/source-sans-3-latin-ext.woff2 \
    --unicodes="$range" \
    --layout-features='*' \
    --name-IDs='*' \
    --name-languages='*' \
    --notdef-outline \
    --flavor=woff2 \
    --output-file="$out/source-sans-3-latin-ext-${part}.woff2"
done
for f in "$out"/*.woff2; do
  mv "$f" app/fonts/
  echo "app/fonts/$(basename "$f") $(wc -c < "app/fonts/$(basename "$f")") bytes"
done
