import type { ReactElement } from 'react';
import { ListLink } from '@/components/ui/ListLink';

/** The control of a list that has more to show (UX-40): a link to the same page with a larger `shown`. */
export function ShowMoreLink({ href, label }: { href: string; label: 'Show more' | 'Show older' }): ReactElement {
  return <ListLink href={href}>{label}</ListLink>;
}
