import { describe, expect, it } from 'vitest';
import type { Stage } from '@/types/record';
import { STAGES } from '@/types/record';
import type { FindingView, UserRef } from '@/types/api';
import { loadContent, runningContent } from '@/lib/content/loader';
import { loadFieldMap } from '@/lib/documents/fieldMaps';
import {
  DOCUMENTS_COPY, MSG_DOCUMENT_CHECK_FAILED, MSG_ISSUE_NO_REPLY, MSG_OTHER_SEAL_CHECK_FAILED, SEALED_NOTE,
  fileErasedLine, findingOnQuestion, questionSource, sealedNote, docTextErasedLine, textErasedLine, wordsThenCode,
} from '@/lib/documents/copy';
import { resolveFields, type DocumentSnapshot, type SealedStage } from '@/lib/documents/resolve';
import { generateReducer } from '@/lib/documents/generate';
import { README_TEXT } from '@/lib/export/readme';
import { parseDocumentRequest } from '@/lib/data/documents';
import { ValidationFailed } from '@/lib/http/errors';

/**
 * Lane 6, builder B3 (plan 1A Task 20): the words documents and downloaded records print, as the sweep rules them. Printed words
 * change only for documents issued from now on: an issued PDF is stored and never rendered again.
 */

const user = (name: string): UserRef => ({ userId: `u-${name}`, name, formerMember: false });

/** One sealed stage whose manifest names `semver` as the content it was sealed on. */
function sealedStage(stage: Stage, semver: string, findings: Array<{ id: string; questionId: string; riskArea?: string; accepted?: boolean }>): SealedStage {
  return {
    stage,
    seal: {
      sealId: `seal-${stage}`, sealNumber: 1, reviewId: `review-${stage}`, reviewName: 'Review 1', fingerprint: 'c0ffee00'.repeat(8),
      sealedAt: '2026-11-14T19:00:00.000Z', sealedBy: user('Olive Owner'), sealedByRole: 'owner', enteredByPeople: 1,
    },
    preparedFor: null,
    manifest: { format: 'makrai.seal/1', content: { semver, contentHash: 'h' }, decisions: [] } as never,
    decisions: new Map(), derived: new Map(),
    findings: findings.map((f) => ({
      finding: {
        id: f.id, projectId: 'p', stage, source: 'shortfall', questionId: f.questionId, decisionVersionId: null, riskArea: f.riskArea ?? null,
        title: null, description: null, raisedBy: user('Asha Assessor'), raisedAt: '2026-11-14T08:00:00.000Z',
        state: (f.accepted === true ? 'closed_accepted_risk' : 'open') as FindingView['state'],
        openMitigations: 0, hasNoMitigation: true, overdueMitigations: 0,
      },
      mitigations: [],
      acceptedRisk: f.accepted === true ? {
        id: `ar-${f.id}`, findingId: f.id, acceptedBy: { kind: 'member', user: user('Olive Owner') }, accepterRole: 'owner', reason: 'Small study.',
        lookAgainNote: null, lookAgainOn: null, enteredBy: user('Olive Owner'), enteredByRole: 'owner', findingSeq: 1,
        receivedAt: '2026-11-14T09:00:00.000Z', erasedFields: [],
      } : null,
      events: [],
    })),
  };
}

/** The resolved fields of `type` from one sealed stage (the mitigation plan's review stage, or the model card's in-processing). */
function resolveOf(type: 'mitigation_plan' | 'model_card', semver: string, findings: Parameters<typeof sealedStage>[2]): ReturnType<typeof resolveFields> {
  const stage: Stage = type === 'mitigation_plan' ? 'pre-processing' : 'in-processing';
  const chosen = sealedStage(stage, semver, findings);
  const stages = Object.fromEntries(STAGES.map((s) => [s, s === stage ? chosen : null])) as DocumentSnapshot['stages'];
  const snap: DocumentSnapshot = {
    documentType: type, reviewStage: stage, chosen, stages, contents: new Map(),
    project: { name: 'Project', description: null, metadata: {} }, organisationName: 'Org', today: '2026-11-14',
    erasures: { evidence: new Map(), findings: new Map(), accepted_risks: new Map(), stage_reviews: new Map(), mitigation_versions: new Map() },
  };
  return resolveFields(loadFieldMap(type), snap, {});
}
const planOf = (semver: string, findings: Parameters<typeof sealedStage>[2]) => resolveOf('mitigation_plan', semver, findings);
const cardOf = (semver: string, findings: Parameters<typeof sealedStage>[2]) => resolveOf('model_card', semver, findings);
const fieldText = (r: ReturnType<typeof resolveFields>, id: string): string => r.fields.find((f) => f.fieldId === id)?.text ?? '';

const SEALED_ON = '0.0.2-fixture';   // its Q-PP-01 reads "Revised in 0.0.2-fixture: ..."; the running content (0.0.1-fixture) does not
const sealedWords = (q: string) => loadContent(SEALED_ON).questions.get(q)!.text;
const currentWords = (q: string) => runningContent().questions.get(q)!.text;

describe('B3 rows A1, A2: erased text and files, at the organisation\'s request (documents are read by outsiders: "the", not "your")', () => {
  it('A1: an erased text reads "Text erased on <date> at the organisation\'s request."', () => {
    expect(docTextErasedLine('2026-11-04')).toBe("Text erased on 4 Nov 2026 at the organisation's request.");
    // On a screen (components/decision/**) the same line speaks to a member: the vocabulary term `erased` (coordinator's ruling, 15 Nov 2026).
    expect(textErasedLine('2026-11-04')).toBe("Text erased on 4 Nov 2026 at your organisation's request.");
  });
  it('A2: an erased file reads "<name>: file erased on <date> at the organisation\'s request." and keeps the fingerprint sentence', () => {
    expect(fileErasedLine('protocol.pdf', '2026-11-04'))
      .toBe("protocol.pdf: file erased on 4 Nov 2026 at the organisation's request. Its fingerprint is kept, so seals that include it still check.");
  });
});

describe('B3 rows A3, A4: a lost reply says what did not happen, why, and what to do (CONSOLIDATED rule 3; section 8 rows 1 and 7)', () => {
  it('A3: an Issue with no reply, or a 5xx, gives the rewritten line; Retry replays the same request id, so "It will not issue twice" stays', () => {
    expect(MSG_ISSUE_NO_REPLY).toBe('Not issued yet. We did not get a reply, so the document may already be issued. Select Retry. It will not issue twice.');
    const issuing = { phase: 'issuing' as const, typed: {}, message: null, retry: false };
    expect(generateReducer(issuing, { kind: 'outcome', outcome: { kind: 'not_saved', reason: 'network' } }).message).toBe(MSG_ISSUE_NO_REPLY);
    expect(generateReducer(issuing, { kind: 'outcome', outcome: { kind: 'rejected', status: 503, body: { error: 'x', code: 'document_issue_busy' } } }).message).toBe(MSG_ISSUE_NO_REPLY);
  });
  it('a seal check that fails on Preview or Issue (500 integrity_failure) says why, never "may already be issued", and offers no Retry: nothing was written', () => {
    for (const phase of ['generating', 'issuing'] as const) {
      const sending = { phase, typed: {}, message: null, retry: false };
      const after = generateReducer(sending, { kind: 'outcome', outcome: { kind: 'rejected', status: 500, body: { error: MSG_OTHER_SEAL_CHECK_FAILED, code: 'integrity_failure' } } });
      expect(after.message).toBe(DOCUMENTS_COPY.refusal.field(phase, MSG_OTHER_SEAL_CHECK_FAILED));
      expect(after.message).not.toBe(MSG_ISSUE_NO_REPLY);
      expect(after.retry).toBe(false);
    }
  });
  it('A4: a withdrawal with no reply gives the same pattern', () => {
    expect(DOCUMENTS_COPY.actions.withdrawLost).toBe('Not withdrawn yet. We did not get a reply, so the document may already be withdrawn. Select Retry. It will not withdraw twice.');
  });
});

describe('B3 rows C1, C2: a finding raised with no title is named by its question\'s words, then its code', () => {
  it('C1: the words come from the content the seal was made on (MP-03 lists the open finding)', () => {
    expect(sealedWords('Q-PP-01')).not.toBe(currentWords('Q-PP-01'));   // the fixture makes the two paths tell apart
    const t = fieldText(planOf(SEALED_ON, [{ id: 'f1', questionId: 'Q-PP-01' }]), 'MP-03');
    expect(t).toContain(`1. ${findingOnQuestion(sealedWords('Q-PP-01'), 'Q-PP-01')}`);
    expect(findingOnQuestion('Is it fair?', 'Q-PP-01')).toBe('Finding on the question: Is it fair? (Q-PP-01)');
    expect(t).not.toContain('Finding on Q-PP-01');
  });
  it('C1: a seal made on a content version this deployment does not list takes the current words of the question (model card MC-23)', () => {
    // The mitigation plan cannot reach this path: MP-04 and MP-07 read the seal's content and refuse an unlisted version.
    expect(() => planOf('9.9.9', [{ id: 'f1', questionId: 'Q-PP-01' }])).toThrow(/unknown_content_version/);
    // MC-23 lists findings of the risk areas IP-01, IP-02 and IP-04.
    const t = fieldText(cardOf('9.9.9', [{ id: 'f1', questionId: 'Q-PP-01', riskArea: 'IP-01' }]), 'MC-23');
    expect(t).toContain(`1. ${findingOnQuestion(currentWords('Q-PP-01'), 'Q-PP-01')}`);
    expect(fieldText(cardOf(SEALED_ON, [{ id: 'f1', questionId: 'Q-PP-01', riskArea: 'IP-01' }]), 'MC-23')).toContain(`1. ${findingOnQuestion(sealedWords('Q-PP-01'), 'Q-PP-01')}`);
  });
  it('C2: the accepted risks lists (MP-06, MC-25) name the finding the same way, on both paths', () => {
    expect(fieldText(planOf(SEALED_ON, [{ id: 'f2', questionId: 'Q-PP-01', accepted: true }]), 'MP-06'))
      .toContain(`1. ${findingOnQuestion(sealedWords('Q-PP-01'), 'Q-PP-01')}\nAccepted by: Olive Owner`);
    expect(fieldText(cardOf('9.9.9', [{ id: 'f2', questionId: 'Q-PP-01', accepted: true }]), 'MC-25'))
      .toContain(`1. ${findingOnQuestion(currentWords('Q-PP-01'), 'Q-PP-01')}\nAccepted by: Olive Owner`);
  });
});

describe('B3 row C12 and D18: words before codes; a source line that says its lead-in once', () => {
  it('C12: a risk area prints its name, then its code', () => {
    expect(wordsThenCode('Techno-solutionist Bias', 'PP-01')).toBe('Techno-solutionist Bias (PP-01)');
  });
  it('D18: an open finding prints "Source: question <Q-id>", not "Source: From question", and its area name first', () => {
    const r = planOf(SEALED_ON, [{ id: 'f1', questionId: 'Q-PP-01', riskArea: 'PP-01' }]);
    const t = r.fields.find((f) => f.fieldId === 'MP-03')?.text ?? '';
    expect(t).not.toContain('Source: From question');
    expect(t).toContain(`Source: ${questionSource('Q-PP-01')}\nRisk area: ${wordsThenCode('Techno-solutionist Bias', 'PP-01')}`);
    expect(questionSource('Q-PP-01', 3)).toBe('question Q-PP-01 (decision version 3)');
    expect(questionSource('Q-PP-01')).toBe('question Q-PP-01');
  });
  it('D18: the sealed note is singular for one seal and plural for a document drawn from more than one', () => {
    expect(sealedNote(1)).toBe(SEALED_NOTE);
    expect(sealedNote(2)).toBe('The platform keeps the seals this document is made from. No outside body has time-stamped them.');
    expect(sealedNote(3)).toBe(sealedNote(2));
  });
});

describe('B3 rows F3 and E13: the integrity and body messages of lib/data/documents.ts', () => {
  it('F3: the PDF route\'s failure gives LD-12\'s words with the reference shown beside them; a document not made says why', () => {
    expect(MSG_DOCUMENT_CHECK_FAILED).toBe('This document failed its safety check, so it was not opened. Write to MAK-AI and give the reference shown with this message.');
    expect(MSG_OTHER_SEAL_CHECK_FAILED).toBe('This document was not made because a seal of another stage no longer matches the record.');
  });
  it('E13: a body that is not a JSON object is refused with the sweep\'s sentence', () => {
    const refused = (body: unknown): string => {
      try { parseDocumentRequest(body, false); } catch (e) { if (e instanceof ValidationFailed) return (e.extra as { fields: Array<{ message: string }> }).fields[0].message; throw e; }
      throw new Error('not refused');
    };
    expect(refused(null)).toBe('The request could not be read. Reload the page and try again.');
    expect(refused([])).toBe(DOCUMENTS_COPY.fieldMessages.unreadable);
  });
});

describe('B3 row A5: the README of downloaded records (C 401, C 402, C 408; G-d3)', () => {
  const lines = README_TEXT.split('\n');
  it('G-d3: the title and the opening sentence', () => {
    expect(lines[0]).toBe('MAK-AI RAI Platform: downloaded records');
    expect(README_TEXT).toContain("This ZIP file holds your organisation's records, or one project's, as they stood when they were downloaded.");
  });
  it('C 401: export.json in plain words, the format id kept, no repository path; C 402: the evidence folder; documents still held', () => {
    expect(README_TEXT).toContain('- export.json: every record in this ZIP file, in the format makrai.team-export/1.');
    expect(README_TEXT).not.toContain('docs/formats');
    expect(README_TEXT).toContain('Some characters are removed from the names, and long names are shortened. The original name is in export.json under fileName.');
    expect(README_TEXT).toContain('- documents/: the PDF of every issued document still held, named with its document id and .pdf.');
  });
  it('C 408: erased items without "operator", "controller" or "tombstone"; links name the ZIP file, not "the archive"', () => {
    expect(README_TEXT).toContain("Where MAK-AI erased a file or text at your organisation's request, the item stays in export.json with the erased value empty. A separate entry records when and why it was erased.");
    expect(README_TEXT).not.toMatch(/operator|controller|tombstone|archive/i);
    expect(README_TEXT).toContain('no file for it is in the ZIP file');
  });
});
