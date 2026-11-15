import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FINDING_MESSAGES } from '@/lib/findings/validate';
import { HTTP_COPY } from '@/lib/http/copy';

/**
 * Lane 6, B4, rows E12 to E14 (audit E-API-17 to E-API-19): a body that is not a JSON object and a request id that is not
 * a UUID get the words every route gives them (lib/http/copy.ts), on the finding routes and on routes 12 and 13.
 */

const ROUTES = [
  'app/api/v1/orgs/[slug]/projects/[id]/reviews/route.ts',
  'app/api/v1/orgs/[slug]/projects/[id]/reviews/[reviewId]/seals/route.ts',
];

describe('E12 E13 E14: the body and request id messages', () => {
  it('the finding routes\' messages are the shared ones', () => {
    expect(FINDING_MESSAGES.body).toBe(HTTP_COPY.unreadable);
    expect(FINDING_MESSAGES.requestId).toBe(HTTP_COPY.outOfDate);
    expect(HTTP_COPY.unreadable).toBe('The request could not be read. Reload the page and try again.');
    expect(HTTP_COPY.outOfDate).toBe('This page is out of date. Reload it and try again.');
  });

  it.each(ROUTES)('%s refuses a body and a request id in the shared words, not the old developer texts', (file) => {
    const src = readFileSync(file, 'utf8');
    expect(src).toContain("{ field: 'body', message: HTTP_COPY.unreadable }");
    expect(src).toMatch(/field: 'requestId', message: HTTP_COPY\.outOfDate/);
    expect(src).not.toMatch(/must be a JSON object|must be a UUID/);
  });
});
