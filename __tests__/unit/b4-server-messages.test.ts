import { describe, expect, it, vi } from 'vitest';
import { FINDING_MESSAGES } from '@/lib/findings/validate';
import { HTTP_COPY } from '@/lib/http/copy';
import { ValidationFailed } from '@/lib/http/errors';
import { parseOpenReviewRequest } from '@/app/api/v1/orgs/[slug]/projects/[id]/reviews/route';
import { parseSealRequest } from '@/app/api/v1/orgs/[slug]/projects/[id]/reviews/[reviewId]/seals/route';

// The route modules import the session and the data layer for their handlers; only the parsers are called here.
vi.mock('@/lib/auth/context', () => ({ requireOrgContextWithIdentity: vi.fn() }));
vi.mock('@/lib/data/reviews', () => ({ openStageReview: vi.fn() }));
vi.mock('@/lib/data/seals', () => ({ sealStageReview: vi.fn() }));

/**
 * Lane 6, B4, rows E12 to E14 (audit E-API-17 to E-API-19): a body that is not a JSON object and a request id that is not
 * a UUID get the words every route gives them (lib/http/copy.ts), on the finding routes and on routes 12 and 13. FX3 (B4 M7): the parsers are called and the thrown fields read, not the source text.
 */

const UUID = '123e4567-e89b-42d3-a456-426614174000';
const fieldsOf = (run: () => unknown): unknown => {
  try { run(); } catch (e) {
    expect(e).toBeInstanceOf(ValidationFailed);
    return (e as ValidationFailed).extra?.fields;
  }
  throw new Error('the parser did not throw');
};

describe('E12 E13 E14: the body and request id messages', () => {
  it('the finding routes\' messages are the shared ones', () => {
    expect(FINDING_MESSAGES.body).toBe(HTTP_COPY.unreadable);
    expect(FINDING_MESSAGES.requestId).toBe(HTTP_COPY.outOfDate);
    expect(HTTP_COPY.unreadable).toBe('The request could not be read. Reload the page and try again.');
    expect(HTTP_COPY.outOfDate).toBe('This page is out of date. Reload it and try again.');
  });

  it.each([
    ['route 12 (open a review)', parseOpenReviewRequest],
    ['route 13 (seal a review)', parseSealRequest],
  ] as const)('%s refuses a body that is not an object in the shared words', (_name, parse) => {
    for (const body of [null, 'text', 7, ['a']]) {
      expect(fieldsOf(() => parse(body))).toEqual([{ field: 'body', message: HTTP_COPY.unreadable }]);
    }
  });

  it.each([
    ['route 12 (open a review)', parseOpenReviewRequest, { requestId: 'not-a-uuid', stage: 'pre-processing', preparedFor: null }],
    ['route 13 (seal a review)', parseSealRequest, { requestId: 'not-a-uuid' }],
  ] as const)('%s refuses a request id that is not a UUID in the shared words', (_name, parse, body) => {
    expect(fieldsOf(() => parse(body))).toEqual([{ field: 'requestId', message: HTTP_COPY.outOfDate }]);
  });

  it('a valid body passes both parsers unchanged', () => {
    expect(parseOpenReviewRequest({ requestId: UUID, stage: 'pre-processing', preparedFor: null })).toEqual({ requestId: UUID, stage: 'pre-processing', preparedFor: null });
    expect(parseSealRequest({ requestId: UUID })).toEqual({ requestId: UUID });
  });
});
