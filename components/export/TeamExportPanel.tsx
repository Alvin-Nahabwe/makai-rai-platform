import type { ReactElement } from 'react';
import { formatSize } from '@/lib/format/size';
import { EXPORT_COPY, recordsOf } from '@/lib/export/copy';
import { Callout } from '@/components/ui/Callout';
import { PreparingDownload } from './PreparingDownload';
import './TeamExportPanel.css';

/**
 * S-20's panel (FR-EXP-01, M-37): what will be downloaded, about how big, as one ZIP file, and a plain
 * "Download records" link to route 20. When route 20 or the proxy refused an earlier press and sent the
 * browser back here with `?refused=` (contract Routes row 20, owner question B4), the reason is shown
 * first, in an alert inside a caution callout. Server-rendered: the server pages call `refusedFrom`, and only the
 * link's "Preparing" sentence runs in the browser (PreparingDownload).
 */

export const PREPARING = EXPORT_COPY.panel.preparing;
/** Owner question B4. */
export const REFUSED_TEXT: Record<'export_busy' | 'rate_limited', string> = EXPORT_COPY.panel.refused;

/** The `refused` query value S-20 shows a reason for; anything else, a list included, is null. */
export function refusedFrom(searchParams: Record<string, string | string[] | undefined>): 'export_busy' | 'rate_limited' | null {
  const r = searchParams.refused;
  return r === 'export_busy' || r === 'rate_limited' ? r : null;
}

export function TeamExportPanel(p: { href: string; scopeName: string; aboutBytes: number; refused: 'export_busy' | 'rate_limited' | null }): ReactElement {
  return (
    <div className="export-panel">
      {p.refused !== null && <Callout kind="caution"><p role="alert">{REFUSED_TEXT[p.refused]}</p></Callout>}
      <p className="export-panel__sentence">{recordsOf(p.scopeName, formatSize(p.aboutBytes))}</p>
      <PreparingDownload href={p.href} label={EXPORT_COPY.panel.download} preparing={PREPARING} />
    </div>
  );
}
