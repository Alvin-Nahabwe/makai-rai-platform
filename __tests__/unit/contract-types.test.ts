import { describe, it, expect, expectTypeOf } from 'vitest';
import { STAGES, OUTSIDE_ROLES, DOCUMENT_TYPES, type WriteOutcome, type Decider, type DecisionVersionRow } from '@/types/record';
import { ACCEPTED_KINDS, CONSENT_TYPE_FOR } from '@/types/legal';
import type { SealManifestV1 } from '@/types/seal';
import type { RequestIdBody, InviteMemberRequest, ResendInvitationRequest, ChangeRoleRequest } from '@/types/api';

describe('contract types', () => {
  it('FR-PRJ-02: three stages in order', () => {
    expect(STAGES).toEqual(['pre-processing', 'in-processing', 'post-processing']);
  });
  it('FR-DEC-01: the seven outside roles', () => {
    expect(OUTSIDE_ROLES).toEqual(['principal_investigator', 'supervisor', 'ethics_committee',
      'data_access_committee', 'institutional_dpo', 'funder', 'other']);
  });
  it('FR-DOC-01: documents in the S-18 order', () => {
    expect(DOCUMENT_TYPES).toEqual(['data_card', 'model_card', 'mitigation_plan']);
  });
  it('FR-ACC-03: three accepted kinds map to ConsentType values', () => {
    expect(ACCEPTED_KINDS).toEqual(['terms', 'privacy', 'cross-border-consent']);
    expect(CONSENT_TYPE_FOR).toEqual({ terms: 'terms_of_service', privacy: 'privacy_policy',
      'cross-border-consent': 'cross_border_storage' });
  });
  it('FR-REV-03 (5.3 item 10): every manifest seal key is required; FR-DEC-07: write outcomes and rows', () => {
    expectTypeOf<SealManifestV1['seal']['preparedFor']>().toEqualTypeOf<{ d: string } | null>();
    expectTypeOf<WriteOutcome<number>>().toEqualTypeOf<{ replayed: boolean; value: number }>();
    expectTypeOf<Decider>().toMatchTypeOf<{ kind: 'member' | 'outside_role' }>();
    expectTypeOf<DecisionVersionRow['requestId']>().toEqualTypeOf<string>();
  });
  it('NFR-INT-02 (owner answer A1): RequestIdBody holds only requestId, and the member writes carry one', () => {
    expectTypeOf<RequestIdBody>().toEqualTypeOf<{ requestId: string }>();
    expectTypeOf<InviteMemberRequest['requestId']>().toEqualTypeOf<string>();
    expectTypeOf<ResendInvitationRequest['requestId']>().toEqualTypeOf<string>();
    expectTypeOf<ChangeRoleRequest['requestId']>().toEqualTypeOf<string>();
  });
});
