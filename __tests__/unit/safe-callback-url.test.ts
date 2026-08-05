import { describe, it, expect } from 'vitest';
import { safeCallbackUrl } from '../../lib/safe-callback-url';

/**
 * Regression coverage for the open-redirect `silent-failure-hunter` found in
 * the Task 8 diff: `callbackUrl.startsWith('/')` alone passes `//evil.com`
 * and `/\evil.com`, both of which the WHATWG URL parser (and therefore
 * Next's own router) resolves to a DIFFERENT origin, turning a successful
 * login into a hard-navigation off this app.
 */
describe('safeCallbackUrl', () => {
  it('defaults to / when absent', () => {
    expect(safeCallbackUrl(null)).toBe('/');
  });

  it('allows a plain in-app path', () => {
    expect(safeCallbackUrl('/invitations/abc123')).toBe('/invitations/abc123');
  });

  it('rejects a protocol-relative payload (//evil.com)', () => {
    expect(safeCallbackUrl('//evil.com')).toBe('/');
  });

  it('rejects a backslash payload (/\\evil.com), which URL parsers treat as //', () => {
    expect(safeCallbackUrl('/\\evil.com')).toBe('/');
  });

  it('rejects an absolute external URL', () => {
    expect(safeCallbackUrl('https://evil.com')).toBe('/');
  });

  it('rejects a protocol-relative payload with extra leading slashes', () => {
    expect(safeCallbackUrl('///evil.com')).toBe('/');
  });
});
