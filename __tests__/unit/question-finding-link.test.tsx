import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QuestionFindingLink } from '@/components/findings/QuestionFindingLink';

const P = { orgSlug: 'lab', projectId: 'p1', stage: 'pre-processing', questionId: 'Q-PP-12', currentVersionId: 'v3' } as const;

describe('QuestionFindingLink on S-12 (UX-14, FR-FND-01, FR-FND-02)', () => {
  it('UX-14 FR-FND-02: a reviewer gets the raise link with the stage, question and version; a viewer gets none', () => {
    const r = renderToStaticMarkup(<QuestionFindingLink {...P} openFinding={null} canRaise />);
    expect(r).toContain('href="/orgs/lab/projects/p1/findings?raise=1&amp;stage=pre-processing&amp;questionId=Q-PP-12&amp;versionId=v3#raise"');
    expect(r).toContain('Raise a finding about this question');
    expect(renderToStaticMarkup(<QuestionFindingLink {...P} openFinding={null} canRaise={false} />)).toBe('');
  });

  it('UX-14: with no current version the link names the stage and question only', () => {
    const r = renderToStaticMarkup(<QuestionFindingLink {...P} currentVersionId={null} openFinding={null} canRaise />);
    expect(r).toContain('findings?raise=1&amp;stage=pre-processing&amp;questionId=Q-PP-12#raise"');
    expect(r).not.toContain('versionId');
  });

  it('FR-FND-01 (screen): an open finding of the question is linked from S-12', () => {
    expect(renderToStaticMarkup(<QuestionFindingLink {...P} openFinding={{ findingId: 'f7' }} canRaise={false} />))
      .toMatch(/<p>This question has an open finding\. <a[^>]*href="\/orgs\/lab\/projects\/p1\/findings\/f7"[^>]*>View the finding<\/a><\/p>/);
  });

  it('FR-FND-01 FR-FND-02: a reviewer sees both the open finding and the raise link', () => {
    const r = renderToStaticMarkup(<QuestionFindingLink {...P} openFinding={{ findingId: 'f7' }} canRaise />);
    expect(r).toContain('View the finding'); expect(r).toContain('Raise a finding about this question');
    expect(r).not.toContain('Open finding');
  });

  it('R4: an open finding that a decision now closes reads "This question has a finding that can now be closed." with the same link', () => {
    expect(renderToStaticMarkup(<QuestionFindingLink {...P} openFinding={{ findingId: 'f7', closable: true }} canRaise={false} />))
      .toMatch(/<p>This question has a finding that can now be closed\. <a[^>]*href="\/orgs\/lab\/projects\/p1\/findings\/f7"[^>]*>View the finding<\/a><\/p>/);
    expect(renderToStaticMarkup(<QuestionFindingLink {...P} openFinding={{ findingId: 'f7' }} canRaise={false} />))
      .toContain('This question has an open finding.');
  });
});
