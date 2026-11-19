'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The rail's Working report link. It is a client part only to know the page: the `@project` slot is rendered for a project's address,
 * not for the page name, so the link reads the pathname the way the rail's own items do (Rail.tsx) and says `aria-current="page"` on
 * the report itself. (Not prefetched: the report reads every stage's answers, and a prefetch from every page of the project would do that unseen.)
 */
export function ReportRailLink({ href, children }: { href: string; children: string }) {
  const current = usePathname() === href;
  return <Link href={href} prefetch={false} className="shell-project__report" aria-current={current ? 'page' : undefined}>{children}</Link>;
}
