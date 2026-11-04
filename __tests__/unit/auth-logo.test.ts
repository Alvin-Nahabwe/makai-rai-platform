import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * NFR-PERF-02 (SRS line 3195: every public page at most 220 KB on first visit). S-01, S-02 and S-03 show the logo as a plain
 * <img> of a file already sized for it, so next/image's client runtime and its optimizer round trip leave those pages
 * (cuts C and D of the V-prog finding). The logo is drawn 48 px high (`.auth-logo` in app/globals.css) at the file's
 * 7646:1454 aspect, so about 252 px wide: the 1x file is 252 x 48 and the 2x file 504 x 96. The width, height and alt
 * attributes stay as they were, so the box before the image loads and the accessible name are unchanged.
 */
const PAGES = ['app/(public)/login/page.tsx', 'app/(public)/forgot-password/page.tsx', 'app/(public)/reset-password/page.tsx'];

/** Width and height from a PNG's IHDR chunk. */
function pngSize(path: string): { width: number; height: number } {
  const b = readFileSync(path);
  expect(b.subarray(1, 4).toString('latin1'), `${path} is a PNG`).toBe('PNG');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

describe('the logo on S-01, S-02 and S-03', () => {
  it.each(PAGES)('NFR-PERF-02: %s draws the pre-sized logo with a plain <img>, not next/image', (page) => {
    const src = readFileSync(page, 'utf8');
    expect(src).not.toMatch(/from 'next\/image'/);
    const img = /<img\b[^>]*\/>/.exec(src)?.[0] ?? '';
    expect(img).toContain('src="/logo-makai-252.png"');
    expect(img).toContain('srcSet="/logo-makai-252.png 1x, /logo-makai-504.png 2x"');
    expect(img).toContain('alt="MAK-AI"');
    expect(img).toContain('className="auth-logo"');
    expect(img).toMatch(/width=\{200\}/);
    expect(img).toMatch(/height=\{60\}/);
  });

  it('NFR-PERF-02: the logo files are sized for the drawn 48 px height, at 1x and 2x, and small', () => {
    expect(pngSize('public/logo-makai-252.png')).toEqual({ width: 252, height: 48 });
    expect(pngSize('public/logo-makai-504.png')).toEqual({ width: 504, height: 96 });
    expect(readFileSync('public/logo-makai-252.png').length).toBeLessThan(8_000);
    expect(readFileSync('app/globals.css', 'utf8')).toMatch(/\.auth-logo \{[^}]*height: 48px;/);
  });
});
