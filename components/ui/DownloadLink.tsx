import type { ReactElement } from 'react';
import { formatSize } from '@/lib/format/size';

/**
 * A link to a file that states its kind and size in its text (UX-39): "Model card template (HTML, 12 KB)",
 * so a person knows what they are about to download before they start.
 */
export function DownloadLink({ href, label, kind, bytes }: { href: string; label: string; kind: string; bytes: number }): ReactElement {
  return <a href={href} download>{`${label} (${kind}, ${formatSize(bytes)})`}</a>;
}
