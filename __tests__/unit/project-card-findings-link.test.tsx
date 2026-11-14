import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectCard } from '@/components/dashboard/ProjectCard';
import { HOME_COPY } from '@/lib/home/copy';

const C = HOME_COPY.card;

describe('R5 (S10): the Home project card links each stage\'s open findings', () => {
  it('R5: "N open findings" links to that stage\'s findings when N is above 0, and is plain text at 0; the line reads as before', () => {
    const html = renderToStaticMarkup(<ProjectCard orgSlug="o" project={{ id: 'p', name: 'P', descriptiveLine: '' }} counts={{
      'pre-processing': { openFindings: 2, overdueMitigations: 1 },
      'in-processing': { openFindings: 0, overdueMitigations: 0 },
      'post-processing': { openFindings: 1, overdueMitigations: 0 },
    }} />);
    expect(html).toMatch(/<li>Pre-processing: <a[^>]*href="\/orgs\/o\/projects\/p\/findings\?stage=pre-processing"[^>]*>2 open findings<\/a>, 1 overdue mitigation<\/li>/);
    expect(html).toMatch(/<a[^>]*href="\/orgs\/o\/projects\/p\/findings\?stage=post-processing"[^>]*>1 open finding<\/a>/);
    expect(html).toContain(`<li>${C.line('In-processing', '0 open findings', '0 overdue mitigations')}</li>`);
    expect(html).not.toContain('stage=in-processing');
  });
});
