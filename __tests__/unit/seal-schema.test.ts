import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/* eslint-disable @typescript-eslint/no-explicit-any -- a JSON Schema document is read as untyped data. */
const s: any = JSON.parse(readFileSync('docs/formats/seal-1.schema.json', 'utf8'));
const required = (def: any): string[] => [...def.required].sort();

describe('docs/formats/seal-1.schema.json (SRS 5.4)', () => {
  it('FR-REV-03 (5.4): the JSON Schema requires every manifest key and allows null where the type does', () => {
    expect(s.properties.format.const).toBe('makrai.seal/1');
    expect(s.required.sort()).toEqual(['content', 'decisions', 'findings', 'format', 'organisation', 'project', 'seal']);
    expect(s.$defs.seal.required.sort()).toEqual(['id', 'number', 'preparedFor', 'sealedAt', 'sealedBy', 'sealedByRole', 'stage', 'stageReviewId']);
    expect(s.$defs.evidence.required.sort()).toEqual(['fileName', 'id', 'kind', 'label', 'sha256', 'url']);
  });

  it('FR-REV-03 (5.4): no object of the format may carry a key the format does not name', () => {
    const closed: string[] = [];
    const walk = (node: any, path: string) => {
      if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}[${i}]`));
      if (typeof node !== 'object' || node === null) return;
      if (node.type === 'object' || node.properties) closed.push(`${path}:${node.additionalProperties === false}`);
      for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
    };
    walk(s, '$');
    expect(closed.length).toBeGreaterThan(10);
    expect(closed.filter((c) => !c.endsWith(':true'))).toEqual([]);
  });

  it('FR-REV-03 (5.4): the free-text fields are salted digests or null, never text', () => {
    const digest = { $ref: '#/$defs/saltedDigest' };
    const nullable = { anyOf: [digest, { type: 'null' }] };
    expect(s.$defs.saltedDigest.required).toEqual(['d']);
    expect(s.$defs.saltedDigest.properties.d.pattern).toBe('^[0-9a-f]{64}$');
    expect(s.$defs.seal.properties.preparedFor).toEqual(nullable);
    for (const k of ['fileName', 'url', 'label']) expect(s.$defs.evidence.properties[k], k).toEqual(nullable);
    for (const k of ['what', 'changeNote', 'closureNote', 'cancelReason']) expect(s.$defs.mitigation.properties[k], k).toEqual(nullable);
    for (const k of ['title', 'description']) expect(s.$defs.finding.properties[k], k).toEqual(nullable);
    for (const k of ['reason', 'lookAgainNote']) expect(s.$defs.acceptedRisk.properties[k], k).toEqual(nullable);
    expect(s.$defs.findingEvent.properties.reason).toEqual(nullable);
    expect(s.$defs.decision.properties.reason).toEqual(nullable);
  });

  it('FR-REV-03 (5.3 item 10): each decision shape, finding part and mitigation names every key the manifest always carries', () => {
    expect(s.$defs.decisions ?? s.properties.decisions.items.oneOf).toBeTruthy();
    const shapes = s.properties.decisions.items.oneOf.map((o: any) => required(o.$ref ? s.$defs[o.$ref.split('/').pop()] : o));
    expect(shapes).toEqual([
      ['none', 'question', 'withdrawal'],
      ['content', 'derived', 'from', 'question'],
      ['content', 'declaredDate', 'declaredPrecision', 'decidedBy', 'enteredBy', 'enteredByRole', 'evidence', 'id', 'number', 'optionsInPlace',
        'question', 'reason', 'reasonCode', 'receivedAt', 'scopeAnswer', 'status'].sort(),
    ]);
    expect(required(s.$defs.finding)).toEqual(['acceptedRisk', 'decisionVersion', 'description', 'events', 'id', 'mitigations', 'question', 'riskArea', 'source', 'state', 'title']);
    expect(required(s.$defs.findingEvent)).toEqual(['by', 'findingSeq', 'id', 'kind', 'reason']);
    expect(required(s.$defs.mitigation)).toEqual(['cancelReason', 'changeNote', 'closureNote', 'dueDate', 'enteredBy', 'enteredByRole', 'evidence', 'findingSeq', 'followsControl', 'kind', 'mitigationId', 'number', 'owner', 'status', 'versionId', 'what']);
    expect(required(s.$defs.acceptedRisk)).toEqual(['acceptedBy', 'accepterRole', 'enteredBy', 'enteredByRole', 'findingSeq', 'id', 'lookAgainDate', 'lookAgainNote', 'reason'].sort());
    expect(required(s.$defs.decider)).toEqual(['outsideRole', 'userId']);
    expect(required(s.$defs.content)).toEqual(['contentHash', 'semver']);
  });

  it('FR-REV-03 (5.4): the closed word lists are the types\' own', () => {
    expect(s.$defs.stage.enum).toEqual(['pre-processing', 'in-processing', 'post-processing']);
    expect(s.$defs.orgRole.enum).toEqual(['owner', 'admin', 'assessor', 'reviewer', 'viewer']);
    expect(s.$defs.outsideRole.enum).toEqual(['principal_investigator', 'supervisor', 'ethics_committee', 'data_access_committee', 'institutional_dpo', 'funder', 'other']);
    expect(s.$defs.evidence.properties.kind.enum).toEqual(['file', 'link']);
    expect(s.$defs.decision.properties.status.anyOf[0].enum).toEqual(['done', 'partly', 'not_yet', 'not_applicable', 'withdrawn']);
    expect(s.$defs.decision.properties.declaredPrecision.enum).toEqual(['day', 'month', 'year']);
    expect(s.$defs.finding.properties.state.enum).toEqual(['open', 'closed_mitigation', 'closed_accepted_risk', 'withdrawn']);
    expect(s.$defs.finding.properties.source.enum).toEqual(['shortfall', 'team']);
    expect(s.$defs.findingEvent.properties.kind.enum).toEqual(['reopened', 'withdrawn']);
    expect(s.$defs.mitigation.properties.status.enum).toEqual(['planned', 'in_progress', 'done', 'cancelled']);
    expect(s.$defs.mitigation.properties.kind.enum).toEqual(['action', 'decision_changed', 'decision_withdrawn']);
  });

  it('FR-REV-03 (5.4): times are UTC with milliseconds, dates are calendar or declared, and numbers are whole', () => {
    expect(new RegExp(s.$defs.utcInstant.pattern).test('2026-11-02T08:00:00.000Z')).toBe(true);
    expect(new RegExp(s.$defs.utcInstant.pattern).test('2026-11-02T08:00:00Z')).toBe(false);
    for (const ok of ['2026', '2026-10', '2026-10-12']) expect(new RegExp(s.$defs.declaredDate.pattern).test(ok), ok).toBe(true);
    for (const bad of ['26', '2026-1', '2026-10-1', '2026-10-12T00:00']) expect(new RegExp(s.$defs.declaredDate.pattern).test(bad), bad).toBe(false);
    expect(new RegExp(s.$defs.calendarDate.pattern).test('2026-10-12')).toBe(true);
    expect(new RegExp(s.$defs.calendarDate.pattern).test('2026-10')).toBe(false);
    for (const [name, def] of [['seal.number', s.$defs.seal.properties.number], ['decision.number', s.$defs.decision.properties.number], ['mitigation.number', s.$defs.mitigation.properties.number], ['mitigation.findingSeq', s.$defs.mitigation.properties.findingSeq], ['event.findingSeq', s.$defs.findingEvent.properties.findingSeq], ['risk.findingSeq', s.$defs.acceptedRisk.properties.findingSeq]] as const)
      expect([name, def.type, def.minimum]).toEqual([name, 'integer', 1]);
  });
});
