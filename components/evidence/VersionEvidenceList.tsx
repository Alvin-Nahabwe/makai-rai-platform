import type { ReactElement } from 'react';
import { DownloadLink } from '@/components/ui/DownloadLink';
import { EVIDENCE_COPY } from '@/lib/evidence/copy';
import { formatDay } from '@/lib/format/dates';
import { evidenceKind, isOwnHost, stripBidiControls, webLink } from '@/lib/evidence/format';
import { publicOrigin } from '@/lib/publicOrigin';
import type { EvidenceItemView } from '@/types/api';
import './VersionEvidenceList.css';

export type VersionEvidenceListProps = { orgSlug: string; items: EvidenceItemView[] };

/**
 * The platform's configured public origin, read on the SERVER (it reads AUTH_URL or NEXTAUTH_URL, which the browser does
 * not have), or null when none is configured: then no link is called the platform's own and every web link keeps "opens
 * another site" (coordinator, T3c item 8). A client tree is handed the value as a prop, never reads it itself, so the
 * server's render and the browser's agree.
 */
export function platformOrigin(): string | null {
  try {
    return publicOrigin();
  } catch {
    return null; // No origin configured: nothing is "own", the warning stays on every link.
  }
}

/** The name a person sees for an item, bidi controls removed (E14). A link without a label is named by its address. */
export function evidenceDisplayName(item: EvidenceItemView): string {
  return stripBidiControls(item.fileName ?? item.label ?? item.url ?? EVIDENCE_COPY.list.fallbackName);
}

/**
 * One item as text: a file is a download link stating its kind and size (UX-39), a link is a plain anchor only when
 * its address parses as http or https (never next/link, which prefetches: FR-EVD-03), named "<name> (<host>, opens
 * another site)" from webLink's one parse, or "<name> (<host>)" when the host is the platform's own (`ownOrigin`, from
 * platformOrigin(); null: none is own), and an erased file reads its name, then
 * "File erased on {date} at your organisation's request." (copy audit B#277, answer Q16) with no link. Every file name sits inside `<bdi>` so a right-to-left override cannot reorder its neighbours.
 */
export function EvidenceItemText({ orgSlug, item, ownOrigin }: { orgSlug: string; item: EvidenceItemView; ownOrigin: string | null }): ReactElement {
  if (item.kind === 'link') {
    if (item.url === null) return <>{EVIDENCE_COPY.list.linkAddressErased}</>;
    // T3 item 8 (security, routed from lane 1): ONE parse gives the href and the host shown (webLink), so a name, or an
    // address such as "https:evil.example" that a browser on this page reads as a same-site path, cannot show one site and
    // go to another. Names and addresses shown have no bidi controls (E14).
    const address = stripBidiControls(item.url);
    const label = item.label === null ? null : stripBidiControls(item.label);
    const web = webLink(item.url);
    if (web === null) {
      // Not a web address: its name and the whole cleaned address as text; no link and no claim to open a site.
      return label === null ? <bdi>{address}</bdi> : <><bdi>{label}</bdi>{' ('}<bdi>{address}</bdi>{')'}</>;
    }
    // The name (the author's, or else the address), then the host it really goes to, inside the link so its name says it.
    return (
      <a href={web.href} rel="noopener noreferrer">
        <bdi>{label ?? address}</bdi>{' '}
        <span className="evidence-item__host">
          {ownOrigin !== null && isOwnHost(web.host, ownOrigin) ? EVIDENCE_COPY.list.linkToOwn(web.host) : EVIDENCE_COPY.list.linkTo(web.host)}
        </span>
      </a>
    );
  }
  const name = item.fileName === null ? null : stripBidiControls(item.fileName);
  if (item.erased !== null) {
    return (
      <>
        {name === null ? EVIDENCE_COPY.list.fileNameErased : <bdi>{name}</bdi>}
        {EVIDENCE_COPY.list.fileErased(formatDay(item.erased.erasedOn))}
      </>
    );
  }
  const label = name ?? EVIDENCE_COPY.list.fileNameErased;
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
  const ownOrigin = platformOrigin();
  return (
    <ul>
      {items.map((item) => (
        <li key={item.id}><EvidenceItemText orgSlug={orgSlug} item={item} ownOrigin={ownOrigin} /></li>
      ))}
    </ul>
  );
}
