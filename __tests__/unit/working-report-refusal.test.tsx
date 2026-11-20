import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { reportRefusalFrom, reportRefusalLocation } from '@/lib/http/exportRefusal';
import { API_COPY } from '@/lib/http/api/copy';
import { PART_MESSAGE, WORKING_REPORT_BUSY_MESSAGE } from '@/lib/data/workingReportPdf';
import { DownloadRefusal } from '@/components/report/WorkingReportView';

/**
 * Fix wave item 8 (silent-failure audit I1; final review M4): a refused download opened as a page comes back to the report page with
 * `?refused=<reason>`, and the page says why in the route's own words. The query is read against a closed list, so nothing the
 * address carries is shown unless it is one of them; a fault's reference is shown only in the support reference's own shape.
 */
const ID = '0b6d1f0e-8d1c-4f5e-9a3b-2c1d0e9f8a7b';

describe('reportRefusalLocation', () => {
  it('builds the report page of the same project, and refuses a slug or id that does not pass its pattern', () => {
    expect(reportRefusalLocation('acme', ID, 'report_busy')).toBe(`/orgs/acme/projects/${ID}/report?refused=report_busy`);
    expect(reportRefusalLocation('acme', ID, 'internal_error', 'a1b2c3d4')).toBe(`/orgs/acme/projects/${ID}/report?refused=internal_error&reference=a1b2c3d4`);
    expect(reportRefusalLocation('acme', '../x', 'part')).toBeNull();
    expect(reportRefusalLocation('Acme/..', ID, 'part')).toBeNull();
    expect(reportRefusalLocation('acme', ID, 'internal_error', 'not-a-ref')).toBeNull();
  });
});

describe('reportRefusalFrom', () => {
  it('reads only the four reasons, and a fault only with a well-formed reference', () => {
    expect(reportRefusalFrom({ refused: 'report_busy' })).toEqual({ reason: 'report_busy', reference: null });
    expect(reportRefusalFrom({ refused: 'part' })).toEqual({ reason: 'part', reference: null });
    expect(reportRefusalFrom({ refused: 'not_found' })).toEqual({ reason: 'not_found', reference: null });
    expect(reportRefusalFrom({ refused: 'internal_error', reference: 'a1b2c3d4' })).toEqual({ reason: 'internal_error', reference: 'a1b2c3d4' });
    expect(reportRefusalFrom({ refused: 'internal_error', reference: '<script>' })).toBeNull();
    expect(reportRefusalFrom({ refused: 'internal_error' })).toBeNull();
    expect(reportRefusalFrom({ refused: ['part', 'part'] })).toBeNull();
    expect(reportRefusalFrom({ refused: 'export_busy' })).toBeNull();
    expect(reportRefusalFrom({})).toBeNull();
  });
});

describe('DownloadRefusal', () => {
  const text = (r: Parameters<typeof DownloadRefusal>[0]['refusal']) => renderToStaticMarkup(<DownloadRefusal refusal={r} />);
  it('says why in the route\'s own words, as an alert', () => {
    expect(text({ reason: 'report_busy', reference: null })).toContain(WORKING_REPORT_BUSY_MESSAGE);
    expect(text({ reason: 'part', reference: null })).toContain(PART_MESSAGE);
    expect(text({ reason: 'not_found', reference: null })).toContain(API_COPY.notFound);
    expect(text({ reason: 'internal_error', reference: 'a1b2c3d4' })).toContain(API_COPY.internalError('a1b2c3d4'));
    expect(text({ reason: 'part', reference: null })).toMatch(/role="alert"/);
  });
  it('renders nothing with no refusal', () => {
    expect(text(null)).toBe('');
  });
});
