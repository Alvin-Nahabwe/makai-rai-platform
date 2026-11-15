import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import type { DocumentType, Stage } from '@/types/record';
import type { IssuedDocumentView } from '@/types/api';
import { GenerateDocumentForm } from '@/components/documents/GenerateDocumentForm';
import { IssuedDocumentsList } from '@/components/documents/IssuedDocumentsList';
import { DocumentTerms, DocumentsLead } from '@/components/documents/DocumentsIntro';
import { NeverSealed } from '@/components/documents/GenerateDocumentForm';
import { PageHeader } from '@/components/ui/PageHeader';
import { TeamExportPanel } from '@/components/export/TeamExportPanel';
import { DOCUMENTS_COPY } from '@/lib/documents/copy';
import { EXPORT_COPY } from '@/lib/export/copy';
import { FINDINGS_COPY } from '@/lib/findings/copy';
import { TERM_DATA_CARD, TERM_FINDING, TERM_FINGERPRINT, TERM_MITIGATION_PLAN, TERM_MODEL_CARD, TERM_SEAL, TERM_STAGE_1, TERM_STAGE_2, TERM_STAGE_3 } from '@/lib/vocabulary/terms';
import { firstUseProblems } from '../helpers/firstUseMarkup';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {} }) }));

/**
 * Lane 6, builder B3 (spec 6, plan 1A Task 9): each checked term's first use on the documents page (S-18) and on both download-records
 * pages (S-20) sits beside its definition. The page components read the database, so each test renders the page's parts in the page's
 * order (app/(authenticated)/orgs/[slug]/projects/[id]/reviews/[reviewId]/documents/page.tsx and the two export pages) and applies the
 * crawl's own rule (lib/vocabulary/firstUse.ts) to the markup. The help lines are the e2e fixture content's, which the crawl reads.
 */

const HELP: Record<DocumentType, string> = {
  data_card: 'Fixture help for the data card: describe the data the system learns from.',
  model_card: 'Fixture help for the model card: describe what the model does and where it stops working.',
  mitigation_plan: 'Fixture help for the mitigation plan: list each finding and what the team will do about it.',
};
const TITLES: Record<DocumentType, string> = { data_card: 'Data card', model_card: 'Model card', mitigation_plan: 'Mitigation plan' };
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

const formProps = (neverSealed: Stage[]) => ({
  orgSlug: 'o', projectId: 'p', reviewId: 'r',
  seals: [{ sealId: 's1', sealNumber: 1, reviewId: 'r', reviewName: 'Pre-processing review 1', sealedAt: '2026-11-01T09:00:00.000Z', latest: true, bytesMatch: true }],
  documents: (['data_card', 'model_card', 'mitigation_plan'] as const).map((type) => ({
    type, title: TITLES[type], help: HELP[type], neverSealedStages: neverSealed, typedFields: [], draft: {},
    fromRecord: type === 'mitigation_plan' ? null : { fields: 35, questions: 20, notRecorded: 12 },
  })),
});
const issued = (id: string): IssuedDocumentView => ({
  id, projectId: 'p', reviewId: 'r', documentType: 'data_card', sha256: SHA, byteSize: 84000,
  issuedBy: { userId: 'u', name: 'Amina N.', formerMember: false }, issuedAt: '2026-11-03T10:42:07.000Z',
  seals: [{ sealId: 's1', sealNumber: 1, reviewId: 'r', reviewName: 'Pre-processing review 1', fingerprint: SHA }], withdrawn: null, erased: null,
});

/** S-18 as the page lays it out: the header and its lead, the terms the page uses, the form, then the issued list. */
function s18(o: { stage?: Stage; neverSealed?: Stage[]; documents?: IssuedDocumentView[]; sealed?: boolean } = {}): string {
  const stage = o.stage ?? 'pre-processing';
  const neverSealed = o.neverSealed ?? [];
  const sealed = o.sealed ?? true;
  const page: ReactElement = (
    <div className="page-content">
      <PageHeader title={DOCUMENTS_COPY.page.heading} lead={<DocumentsLead reviewName={`${FINDINGS_COPY.stages[stage]} review 1`} stage={stage} />} />
      <DocumentTerms stages={neverSealed} finding={sealed} />
      {sealed ? (
        <>
          <section><h2>{DOCUMENTS_COPY.page.chooseHeading}</h2><GenerateDocumentForm {...formProps(neverSealed)} /></section>
          <section><h2>{DOCUMENTS_COPY.page.issuedHeading}</h2><IssuedDocumentsList orgSlug="o" documents={o.documents ?? []} latestSealNumber={1} canWithdraw={false} /></section>
        </>
      ) : <NeverSealed orgSlug="o" projectId="p" reviewId="r" />}
    </div>
  );
  return renderToStaticMarkup(page);
}

const pair = (html: string, id: string) => [html.includes(`data-term="${id}"`), html.includes(`data-definition="${id}"`)];

describe('S-18, the documents page: every checked term\'s first use is beside its definition', () => {
  it('spec 6: the crawl\'s lines (data card, model card, mitigation plan, finding in the fixture help, seal, the stage names) hold no violation', () => {
    const html = s18({ neverSealed: ['in-processing', 'post-processing'] });
    expect(firstUseProblems(html)).toEqual([]);
    for (const t of [TERM_STAGE_1, TERM_STAGE_2, TERM_STAGE_3, TERM_SEAL, TERM_FINDING, TERM_DATA_CARD, TERM_MODEL_CARD, TERM_MITIGATION_PLAN]) expect([t.id, ...pair(html, t.id)]).toEqual([t.id, true, true]);
  });

  it('the rule is live: without the terms under the heading, the fixture help would be the first use of "finding" and the never-sealed note of "seal"', () => {
    const html = renderToStaticMarkup(<GenerateDocumentForm {...formProps(['in-processing'])} />);
    expect(firstUseProblems(html).map((v) => v.id)).toEqual(expect.arrayContaining([TERM_FINDING.id, TERM_SEAL.id, TERM_STAGE_2.id]));
    expect(firstUseProblems(html).map((v) => v.id)).not.toContain(TERM_DATA_CARD.id);
  });

  it('spec 6, D1: the review\'s own stage name is defined in the lead; another stage is defined only when the page names it', () => {
    const html = s18({ stage: 'in-processing' });
    expect(firstUseProblems(html)).toEqual([]);
    expect(pair(html, TERM_STAGE_2.id)).toEqual([true, true]);
    expect(pair(html, TERM_STAGE_3.id)).toEqual([false, false]);
  });

  it('spec 6: the fingerprint of an issued document is defined at its first use, once, on the first line of the list', () => {
    const html = s18({ documents: [issued('d1'), issued('d2')] });
    expect(firstUseProblems(html)).toEqual([]);
    expect(html.match(/data-definition="fingerprint"/g)).toHaveLength(1);
    expect(pair(html, TERM_FINGERPRINT.id)).toEqual([true, true]);
  });

  it('spec 6: a review with no seal defines seal before "Seal this review first", and defines no term it does not use', () => {
    const html = s18({ sealed: false });
    expect(firstUseProblems(html)).toEqual([]);
    expect(pair(html, TERM_SEAL.id)).toEqual([true, true]);
    expect(pair(html, TERM_FINDING.id)).toEqual([false, false]);
  });

  it('ruling X-5: the issued state of the form, shown once, carries the fingerprint definition right after its status line', async () => {
    const { IssuedNotice } = await import('@/components/documents/GenerateDocumentForm');
    const html = renderToStaticMarkup(<IssuedNotice orgSlug="o" projectId="p" reviewId="r" issued={issued('d1')} />);
    expect(firstUseProblems(html)).toEqual([]);
    expect(pair(html, TERM_FINGERPRINT.id)).toEqual([true, true]);
  });
});

describe('S-20, both download-records pages: no checked term is used, so none is defined', () => {
  it('spec 6: the organisation page and the project page hold no checked term and no definition', () => {
    for (const html of [
      renderToStaticMarkup(<div><PageHeader title={EXPORT_COPY.titles.downloadRecords} lead={<p>{EXPORT_COPY.intro.organisation}</p>} /><TeamExportPanel href="/x" scopeName="Org" aboutBytes={2400000} refused="export_busy" /></div>),
      renderToStaticMarkup(<div><PageHeader title={EXPORT_COPY.titles.downloadRecords} /><p>{EXPORT_COPY.intro.project}</p><TeamExportPanel href="/x" scopeName="Project" aboutBytes={2400000} refused="rate_limited" /></div>),
    ]) {
      expect(firstUseProblems(html)).toEqual([]);
      expect(html).not.toContain('data-term=');
      expect(html).not.toContain('data-definition=');
    }
  });
});
