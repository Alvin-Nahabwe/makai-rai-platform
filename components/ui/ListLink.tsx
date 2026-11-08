import Link from 'next/link';
import type { LinkProps } from 'next/link';
import type { ReactElement, ReactNode } from 'react';

/**
 * A `next/link` that never prefetches (UX-37): a long list of links would fetch pages nobody opens
 * (`prefetch={false}`: "Prefetching will never happen both on entering the viewport and on hover",
 * node_modules/next/dist/docs/01-app/03-api-reference/02-components/link.md:294-304). The other props pass
 * through; `prefetch` cannot be switched back on.
 */
export function ListLink(props: LinkProps & { children: ReactNode; className?: string }): ReactElement {
  return <Link {...props} prefetch={false} />;
}
