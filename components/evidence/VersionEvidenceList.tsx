import type { ReactElement } from 'react';
import { DownloadLink } from '@/components/ui/DownloadLink';
import { formatDay } from '@/lib/format/dates';
import { evidenceKind, stripBidiControls } from '@/lib/evidence/format';
import { isHttpUrl } from '@/lib/evidence/link';
import type { EvidenceItemView } from '@/types/api';

export type VersionEvidenceListProps = { orgSlug: string; items: EvidenceItemView[] };

/** The name a person sees for an item, bidi controls removed (E14). A link without a label is named by its address. */
export function evidenceDisplayName(item: EvidenceItemView): string {
  return stripBidiControls(item.fileName ?? item.label ?? item.url ?? 'Evidence');
}

/**
 * One item as text: a file is a download link stating its kind and size (UX-39), a link is a plain anchor only when
 * its address is http or https (never next/link, which prefetches: FR-EVD-03), and an erased file reads the 7.5.6
 * line with no link. Every file name sits inside `<bdi>` so a right-to-left override cannot reorder its neighbours.
 */
export function EvidenceItemText({ orgSlug, item }: { orgSlug: string; item: EvidenceItemView }): ReactElement {
  if (item.kind === 'link') {
    if (item.url === null) return <>Link address erased</>;
    const label = item.label === null ? null : stripBidiControls(item.label);
    return (
      <>
        {isHttpUrl(item.url) ? <a href={item.url} rel="noopener noreferrer">{label ?? item.url}</a> : <>{label ?? item.url}</>}
        {label === null ? null : <>{' ('}{item.url}{')'}</>}
      </>
    );
  }
  const name = item.fileName === null ? null : stripBidiControls(item.fileName);
  if (item.erased !== null) {
    return (
      <>
        {name === null ? 'File name erased' : <bdi>{name}</bdi>}
        {` . File erased on ${formatDay(item.erased.erasedOn)} on the organisation's instruction. Its fingerprint is kept, so seals that include it still check.`}
      </>
    );
  }
  const label = name ?? 'File name erased';
  if (item.byteSize === null || item.mimeType === null) return <bdi>{label}</bdi>;
  return (
    <bdi>
      <DownloadLink href={`/api/v1/orgs/${encodeURIComponent(orgSlug)}/evidence/${encodeURIComponent(item.id)}`} label={label}
        kind={evidenceKind(item.mimeType)} bytes={item.byteSize} />
    </bdi>
  );
}

/**
 * The evidence of one decision version, with the erased label (FR-EVD-05). A slot of its screen (contract "Screens and
 * slots"): the screen's owner renders it, EVD fills it.
 */
export function VersionEvidenceList({ orgSlug, items }: VersionEvidenceListProps): ReactElement | null {
  if (items.length === 0) return null;
  return (
    <ul>
      {items.map((item) => (
        <li key={item.id}><EvidenceItemText orgSlug={orgSlug} item={item} /></li>
      ))}
    </ul>
  );
}
