import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DocumentType, Stage } from '@/types/record';
import { loadContent } from '@/lib/content/loader';
import { loadFieldMap } from '@/lib/documents/fieldMaps';
import { DOCUMENT_TITLES, SEALED_NOTE, STATEMENT, CONTROLS_AFTER_APPROVAL, draftLine, sealedNote, WORKING_REPORT_PAGE } from '@/lib/documents/copy';
import { resolveFields } from '@/lib/documents/resolve';
import { draftSnapshot } from '@/lib/data/documents';
import { buildWorkingReportSummary, workingReportPages } from '@/lib/documents/workingReport';
import { RENDERERS, type RenderInput, type ResolvedField } from '@/lib/documents/render';
import { fieldDocumentPage } from '@/lib/documents/render/frame';
import { composeWorkingReport, renderWorkingReportPdf } from '@/lib/documents/render/workingReport';
import { claimMatches } from '@/lib/claims/pattern';
import { pdfPageRuns } from '../helpers/pdfText';
import { REVIEWED_CLAIM_NAMES } from '../helpers/frameworkNames';
import { allowListedQuestionTexts } from '../helpers/contentQuestions';
import { TAKEN, decisionOf, findingOf, fullRecord, recordOf } from '../helpers/draftRecord';

/**
 * Task 8 (path to outputs): the draft working report as a PDF. Design G1, §4 anti-goal 1 (a draft must survive a printout or a
 * screenshot of ONE page without being mistakable for sealed), §7. The running content of the unit tests is the 0.0.1 fixture.
 */

const running = loadContent('0.0.1-fixture');
const recorded = loadContent('0.0.2-fixture');
const LINE = draftLine(TAKEN);
const squash = (s: string): string => s.replace(/\s+/g, ' ');
/** The issued STAMP form (`${title}, issued <UTC second>`), the sealed notes, and any fingerprint: what a draft must never print. */
const ISSUED_STAMP = /, issued \d{1,2} [A-Z][a-z]{2} \d{4} \d\d:\d\d:\d\d UTC/;
const FINGERPRINT = /\b[0-9a-f]{16,}\b|Fingerprint/i;

function assertNotSealed(label: string, text: string): void {
  const t = squash(text);
  expect(t, `${label}: issued stamp`).not.toMatch(ISSUED_STAMP);
  expect(t, `${label}: sealed note`).not.toContain(SEALED_NOTE);
  expect(t, `${label}: sealed note, plural`).not.toContain(sealedNote(2));
  expect(t, `${label}: fingerprint`).not.toMatch(FINGERPRINT);
}

describe('anti-goal 1: a draft PDF cannot be mistaken for a sealed one', () => {
  it('anti-goal 1: every page of a draft PDF carries the draft line, in the header and in the footer', async () => {
    const r = fullRecord(running);
    const card = await renderWorkingReportPdf(composeWorkingReport(r, running, 'data_card').pages, DOCUMENT_TITLES.data_card);
    const cardPages = pdfPageRuns(card.pdf);
    expect(cardPages.length, 'the data card runs to at least three pages').toBeGreaterThanOrEqual(3);
    for (const [i, p] of cardPages.entries()) {
      expect(p, `data card page ${i + 1} header`).toContain(LINE);
      expect(p.some((run) => run.includes(`${DOCUMENT_TITLES.data_card} · ${LINE}`)), `data card page ${i + 1} footer`).toBe(true);
    }

    const all = composeWorkingReport(r, running, 'all');
    const report = await renderWorkingReportPdf(all.pages, all.title);
    const pages = pdfPageRuns(report.pdf);
    expect(pages.length).toBeGreaterThan(cardPages.length);
    expect(pages.every((p) => p.includes(LINE))).toBe(true);
    expect(pages.every((p) => p.some((run) => run.includes(`· ${LINE}`)))).toBe(true);
  });

  it('anti-goal 1: a draft PDF has no fingerprint, no issued stamp, no sealed note', async () => {
    const r = fullRecord(running);
    for (const part of ['all', 'summary', 'data_card', 'model_card', 'mitigation_plan:pre-processing'] as const) {
      const { pages, title } = composeWorkingReport(r, running, part);
      const { pdf, plainText } = await renderWorkingReportPdf(pages, title);
      assertNotSealed(`${part} pdf`, pdfPageRuns(pdf).flat().join(' '));
      assertNotSealed(`${part} text`, plainText);
      expect(plainText, part).toContain(LINE);
    }
  });

  it('the draft footer is the title, the draft line and the statement; the draft header is the draft line alone', () => {
    const map = loadFieldMap('data_card');
    const input: RenderInput = { map, fields: [], stamp: { kind: 'draft', takenAt: TAKEN }, organisationName: 'Org', projectName: 'Project' };
    const { plainText } = fieldDocumentPage(input, 'Data card');
    expect(plainText.split('\n')[0]).toBe(LINE);
    expect(plainText.trimEnd().split('\n').slice(-2)).toEqual([`Data card · ${LINE}`, STATEMENT]);
  });
});

describe('issued documents are unchanged by the stamp', () => {
  const baseline = JSON.parse(readFileSync('__tests__/fixtures/render/issued-baseline.json', 'utf8')) as Record<string, { plainText: string; pages: string[][] }>;
  for (const type of ['data_card', 'mitigation_plan'] as const) {
    it(`issued documents render exactly as before (${type}): plain text and printed runs equal those captured before the change`, async () => {
      const map = loadFieldMap(type);
      const fields: ResolvedField[] = map.fields.slice(0, 6).map((f, i) => ({
        fieldId: f.fieldId, label: f.label, section: f.section, text: i === 2 ? null : `Answer ${i} for ${f.fieldId}`, provenance: i % 2 ? 'From Q-PP-12 v1.' : '',
      }));
      const seals = [{ sealId: 's1', sealNumber: 2, reviewId: 'r1', reviewName: 'Pre-processing review 1', fingerprint: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90' }];
      const r = await RENDERERS[type]!({ map, fields, stamp: { kind: 'issued', issuedAt: '2026-11-03T10:42:07.000Z', seals }, organisationName: 'Org', projectName: 'Project' });
      expect(r.plainText).toBe(baseline[type].plainText);
      expect(pdfPageRuns(r.pdf)).toEqual(baseline[type].pages);
    });
  }
});

describe('the whole report', () => {
  it('no draft text of a fully answered fixture report matches the claims pattern', async () => {
    const r = fullRecord(running);
    const all = composeWorkingReport(r, running, 'all');
    const { pdf, plainText } = await renderWorkingReportPdf(all.pages, all.title);
    // The statement names what the document is not, as document-render.test.ts strips it before the same check. The framework's own wording is
    // source text printed verbatim: the reviewed area and control names (as mitigation-plan.test.ts exempts them) and the question stems
    // the owner allowed in claim-allowlist.json; any claim outside them counts.
    const allowed = JSON.parse(readFileSync('__tests__/lint/claim-allowlist.json', 'utf8')) as unknown[];
    const source = [...REVIEWED_CLAIM_NAMES, ...allowListedQuestionTexts(allowed, '__tests__/fixtures/content')].sort((a, b) => b.length - a.length);
    const outside = (t: string) => claimMatches(source.reduce((rest, w) => rest.split(w).join(' '), t));
    const text = plainText.replaceAll(STATEMENT, '');
    const printed = squash(pdfPageRuns(pdf).flat().join(' ')).replaceAll(STATEMENT, '');
    expect(outside(text)).toEqual([]);
    expect(outside(printed)).toEqual([]);
    expect(outside('A model that fails safely.')).not.toEqual([]);   // the check is live
    // It is the whole report: page 1, both cards and a plan for each of the three stages.
    for (const heading of ['Where this project stands', DOCUMENT_TITLES.data_card, DOCUMENT_TITLES.model_card]) expect(plainText).toContain(heading);
    expect(plainText.match(/^Mitigation plan$/gm)).toHaveLength(3);
  });

  it('the part order is defined once, in the render-free module: page 1, data card, model card, then a plan for each stage with answers', () => {
    const one = recordOf(running, { 'in-processing': { decisions: [decisionOf(running, 'Q-IP-01', 'done')] } });
    const none = recordOf(running, {});
    const full = fullRecord(running);
    expect(workingReportPages(full, 'all')).toEqual([
      { kind: 'summary' },
      { kind: 'document', documentType: 'data_card', reviewStage: 'pre-processing' },
      { kind: 'document', documentType: 'model_card', reviewStage: 'in-processing' },
      ...(['pre-processing', 'in-processing', 'post-processing'] as Stage[]).map((reviewStage) => ({ kind: 'document', documentType: 'mitigation_plan' as DocumentType, reviewStage })),
    ]);
    expect(workingReportPages(one, 'all').map((p) => (p.kind === 'summary' ? 'summary' : `${p.documentType}:${p.reviewStage}`))).toEqual([
      'summary', 'data_card:pre-processing', 'model_card:in-processing', 'mitigation_plan:in-processing',
    ]);
    expect(workingReportPages(none, 'all')).toHaveLength(3);
    expect(workingReportPages(full, 'summary')).toEqual([{ kind: 'summary' }]);
    expect(workingReportPages(full, 'model_card')).toEqual([{ kind: 'document', documentType: 'model_card', reviewStage: 'in-processing' }]);
    expect(workingReportPages(none, 'mitigation_plan:post-processing')).toEqual([{ kind: 'document', documentType: 'mitigation_plan', reviewStage: 'post-processing' }]);
  });

  it('the composer takes the running content: a recorded (older) content version is refused', () => {
    const r = fullRecord(running);
    expect(recorded.contentHash).not.toBe(running.contentHash);
    expect(() => composeWorkingReport(r, running, 'all')).not.toThrow();
    expect(() => composeWorkingReport(r, recorded, 'all')).toThrow(/running content/);
  });

  it('page 1 and each draft plan are built from the same record: the plan prints the title page 1 lists', () => {
    const r = recordOf(running, {
      'pre-processing': { decisions: [decisionOf(running, 'Q-PP-09', 'partly')], findings: [findingOf({ id: 'f-09', stage: 'pre-processing', source: 'shortfall', questionId: 'Q-PP-09' })] },
    });
    const title = buildWorkingReportSummary(r, running).nextSteps[0].items[0].title;
    const plan = resolveFields({ ...loadFieldMap('mitigation_plan'), fields: loadFieldMap('mitigation_plan').fields.filter((f) => f.fieldId === 'MP-03') }, draftSnapshot(r, 'mitigation_plan', 'pre-processing'), {});
    expect(plan.fields[0].text).toContain(title);
    const { pages } = composeWorkingReport(r, running, 'all');
    const texts = pages.map((p) => p.plainText);
    expect(texts[0]).toContain(title);
    expect(texts[texts.length - 1]).toContain(title);
  });
});

describe('page 1, "Where this project stands"', () => {
  it('prints how many recorded answers it could not show, only when there are some', () => {
    const base = recordOf(running, { 'pre-processing': { decisions: [decisionOf(running, 'Q-PP-12', 'done')] } });
    const [none] = composeWorkingReport(base, running, 'summary').pages;
    expect(none.plainText).not.toContain(WORKING_REPORT_PAGE.omitted(1));
    expect(none.plainText).not.toMatch(/no longer in the framework/);
    const [one] = composeWorkingReport({ ...base, omittedAnswers: 1 }, running, 'summary').pages;
    expect(one.plainText).toContain(WORKING_REPORT_PAGE.omitted(1));
    const [three] = composeWorkingReport({ ...base, omittedAnswers: 3 }, running, 'summary').pages;
    expect(three.plainText).toContain(WORKING_REPORT_PAGE.omitted(3));
    expect(WORKING_REPORT_PAGE.omitted(3)).toContain('3 recorded answers');
  });

  it('lists next steps by area, then what is in place, then what does not apply, with the question, the answer and no controls until approved', () => {
    const [p] = composeWorkingReport(fullRecord(running), running, 'summary').pages;
    const at = (s: string): number => p.plainText.indexOf(s);
    expect(at(WORKING_REPORT_PAGE.nextSteps)).toBeGreaterThan(0);
    expect(at(WORKING_REPORT_PAGE.inPlace)).toBeGreaterThan(at(WORKING_REPORT_PAGE.nextSteps));
    expect(at(WORKING_REPORT_PAGE.doesNotApply)).toBeGreaterThan(at(WORKING_REPORT_PAGE.inPlace));
    expect(p.plainText).toContain(CONTROLS_AFTER_APPROVAL);
    // The shortfall titles already hold their question's words, so no "Question:" line repeats them.
    expect(p.plainText).not.toContain(`${WORKING_REPORT_PAGE.question}:`);
  });

  it('a team finding on a question keeps the question as its own line, since its title does not say it', () => {
    const r = recordOf(running, {
      'pre-processing': { decisions: [decisionOf(running, 'Q-PP-09', 'partly')], findings: [findingOf({ id: 'f-t', stage: 'pre-processing', questionId: 'Q-PP-09', title: 'The consent forms are out of date' })] },
    });
    const [p] = composeWorkingReport(r, running, 'summary').pages;
    expect(p.plainText).toContain(`${WORKING_REPORT_PAGE.question}: ${running.questions.get('Q-PP-09')!.text}`);
    expect(p.plainText).toContain(`${WORKING_REPORT_PAGE.answer}: Partly`);
  });
});
