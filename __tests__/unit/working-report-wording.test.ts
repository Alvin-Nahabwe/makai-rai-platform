import { describe, expect, it } from 'vitest';
import { loadContent } from '@/lib/content/loader';
import { emptyFieldText, NOT_RECORDED, NOT_RECORDED_YET, STAGE_TERMS, WORKING_REPORT_PAGE as W } from '@/lib/documents/copy';
import { loadFieldMap } from '@/lib/documents/fieldMaps';
import { buildWorkingReportSummary } from '@/lib/documents/workingReport';
import { fieldDocumentPage } from '@/lib/documents/render/frame';
import { summaryPage } from '@/lib/documents/render/summaryPage';
import type { RenderInput } from '@/lib/documents/render';
import { contentWith } from '../helpers/contentWith';
import { TAKEN, fullRecord } from '../helpers/draftRecord';

/**
 * Fix wave item 11 (final review M1, M2): the screen and the PDF of the working report say one thing one way. The screen's wording is
 * kept (no test pinned the PDF's): an empty draft field reads "Not recorded yet" (an issued document keeps "Not recorded"); an open
 * item's place reads "<stage>, question <id>"; a control's notebook reads "notebook available".
 */
const running = loadContent('0.0.1-fixture');
const meta = { organisationName: 'Org', projectName: 'Project' };

describe('an empty field', () => {
  it('one rule: a draft says Not recorded yet, an issued document Not recorded', () => {
    expect(emptyFieldText('draft')).toBe(NOT_RECORDED_YET);
    expect(emptyFieldText('issued')).toBe(NOT_RECORDED);
  });
  it('the draft PDF prints the screen\'s words for a field with no text', () => {
    const map = loadFieldMap('data_card');
    const field = { fieldId: 'DC-01', label: 'L', section: 'S', text: null, provenance: '' };
    const input: RenderInput = { map, fields: [field] as unknown as RenderInput['fields'], stamp: { kind: 'draft', takenAt: TAKEN, omitted: 0 }, organisationName: 'Org', projectName: 'Project' };
    expect(fieldDocumentPage(input, 'Data card').plainText.split('\n')).toContain(NOT_RECORDED_YET);
  });
});

describe('page 1 of the PDF', () => {
  it('places an open item as the screen does: "<stage>, question <id>"', () => {
    const s = buildWorkingReportSummary(fullRecord(running), running);
    const item = s.nextSteps.flatMap((g) => g.items).find((i) => i.questionId !== null)!;
    const text = summaryPage(s, meta).plainText;
    expect(text).toContain(W.placeOf(STAGE_TERMS[item.stage].term, item.questionId));
    expect(text).not.toContain(' · question ');
  });
  it('words a control\'s notebook as the screen does: "notebook available"', () => {
    const approved = contentWith({ controlSuggestionsApproved: true });
    const text = summaryPage(buildWorkingReportSummary(fullRecord(approved), approved), meta).plainText;
    expect(text).toContain(`${W.hasNotebook}: `);
    expect(text).not.toContain('Download notebook');
  });
});
