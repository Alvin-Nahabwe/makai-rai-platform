import type { ReactElement } from 'react';
import { formatSize } from '@/lib/format/size';
import { PreparingDownload } from './PreparingDownload';

/**
 * S-20's panel (FR-EXP-01, M-37): what will be exported, about how big, as one ZIP file, and a plain
 * "Download export" link to route 20. When route 20 or the proxy refused an earlier press and sent the
 * browser back here with `?refused=` (contract Routes row 20, owner question B4), the reason is shown
 * first, in an alert. Server-rendered: the server pages call `refusedFrom`, and only the link's
 * "Preparing" sentence runs in the browser (PreparingDownload).
 */

export const PREPARING = 'Preparing the export. Large projects can take a few minutes.';
/** Owner question B4. */
export const REFUSED_TEXT: Record<'export_busy' | 'rate_limited', string> = {
  export_busy: 'Two exports are already being prepared. Try again when one has finished.',
  rate_limited: 'You can start 3 exports an hour. Try again later.',
};

/** The `refused` query value S-20 shows a reason for; anything else, a list included, is null. */
export function refusedFrom(searchParams: Record<string, string | string[] | undefined>): 'export_busy' | 'rate_limited' | null {
  const r = searchParams.refused;
  return r === 'export_busy' || r === 'rate_limited' ? r : null;
}

export function TeamExportPanel(p: { href: string; scopeName: string; aboutBytes: number; refused: 'export_busy' | 'rate_limited' | null }): ReactElement {
  return (
    <section aria-labelledby="team-export-heading" className="card">
      <h2 id="team-export-heading">Download</h2>
      {p.refused !== null && <p role="alert" className="auth-error">{REFUSED_TEXT[p.refused]}</p>}
      <p>{`Export ${p.scopeName}: about ${formatSize(p.aboutBytes)} as one ZIP file.`}</p>
      <PreparingDownload href={p.href} label="Download export" preparing={PREPARING} />
    </section>
  );
}
