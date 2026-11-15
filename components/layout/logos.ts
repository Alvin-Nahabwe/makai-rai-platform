/**
 * The two partner logos the shell and the footer draw, as sized copies made from the white originals in public/
 * (logo-makai-white.png, 5348 x 1253; logo-dswb-white.png, 400 x 128, restored from d18e3349^) with ImageMagick at 1x and
 * 2x of the drawn size: lossy WebP at quality 70 (alpha too), the coordinator's ruling of 15 November 2026 to keep S-04
 * inside NFR-PERF-02 (on navy at 1x and 3x it shows no visible loss; PSNR 44 to 52 dB against the earlier files). Both are
 * the white variants, drawn only on the navy of the rail, the top bar and the footer band, which stay navy in both themes.
 * Plain <img> elements of files already sized, so next/image's client runtime stays off the public pages (NFR-PERF-02).
 */
export const MAKAI_LOGO = Object.freeze({
  src: '/logo-makai-white-154.webp',
  srcSet: '/logo-makai-white-154.webp 1x, /logo-makai-white-308.webp 2x',
  width: 154,
  height: 36,
});

/**
 * The same white logo at the rail's full content width (248 px rail, less 2 x 12 px of scroll padding and 2 x 8 px of brand
 * padding = 208 px, less the rail's 1 px edge = 207 px), so its tagline is as large as the rail allows. Sized copies of logo-makai-white.png made as above
 * (ImageMagick, WebP q70, 207 and 414 px wide). Drawn only in the rail's brand.
 */
export const MAKAI_LOGO_RAIL = Object.freeze({
  src: '/logo-makai-white-207.webp',
  srcSet: '/logo-makai-white-207.webp 1x, /logo-makai-white-414.webp 2x',
  width: 207,
  height: 48,
});

export const DSWB_LOGO = Object.freeze({
  src: '/logo-dswb-white-125.webp',
  srcSet: '/logo-dswb-white-125.webp 1x, /logo-dswb-white-250.webp 2x',
  width: 125,
  height: 40,
});
