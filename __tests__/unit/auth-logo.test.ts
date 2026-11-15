import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AUTH_COPY } from '@/lib/auth/copy';

/**
 * NFR-PERF-02 (SRS line 3195: every public page at most 220 KB on first visit). S-01, S-02 and S-03 once showed the logo as
 * a plain <img> of a file already sized for it, so next/image's client runtime and its optimizer round trip left those pages
 * (cuts C and D of the V-prog finding). Since plan 1B Task 2 the pages are in the gate frame and the logo is the frame
 * column's, put there by the shared logo component (owner's ruling I-3, lead's ruling L5-8): the card draws none. What this
 * file still guards is the property the plain <img> bought: no next/image runtime on these public pages. The logo files
 * stay, for the shared logo component.
 */
const PAGES = ['app/(public)/login/page.tsx', 'app/(public)/forgot-password/page.tsx', 'app/(public)/reset-password/page.tsx'];
const CLIENTS = ['app/(public)/login/LoginClient.tsx', 'app/(public)/forgot-password/ForgotPasswordClient.tsx', 'app/(public)/reset-password/ResetPasswordClient.tsx',
  'components/auth/AuthCard.tsx', 'components/auth/PasswordField.tsx', 'components/layout/GateFrame.tsx'];

/** Width and height from a PNG's IHDR chunk. */
function pngSize(path: string): { width: number; height: number } {
  const b = readFileSync(path);
  expect(b.subarray(1, 4).toString('latin1'), `${path} is a PNG`).toBe('PNG');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

describe('the logo on S-01, S-02 and S-03', () => {
  it.each(PAGES)('NFR-PERF-02 (ruling L5-8): %s loads no next/image runtime and draws no logo in its card', (page) => {
    for (const f of [page, ...CLIENTS]) expect(readFileSync(f, 'utf8'), f).not.toMatch(/from 'next\/image'|import\('next\/image'\)/);
    expect(readFileSync(page, 'utf8')).not.toMatch(/<img\b|<Image\b/);
    expect(AUTH_COPY.logoAlt, 'the logo\'s accessible name, for the pages that still draw it').toBe('MAK-AI');
  });

  it('NFR-PERF-02: the old logo files keep their sizes and stay small, and no rule draws them as .auth-logo any more', () => {
    expect(pngSize('public/logo-makai-252.png')).toEqual({ width: 252, height: 48 });
    expect(pngSize('public/logo-makai-504.png')).toEqual({ width: 504, height: 96 });
    expect(readFileSync('public/logo-makai-252.png').length).toBeLessThan(8_000);
    // No page draws the logo with `.auth-logo` since plan 1B Task 2, so the rule left app/globals.css with it (an unused
    // class fails __tests__/lint/s04-first-visit-weight.test.ts); the shared logo component will size its own.
    expect(readFileSync('app/globals.css', 'utf8')).not.toMatch(/\.auth-logo\b/);
  });
});
