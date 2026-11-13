'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from '@/components/ui/Icon';
import { SHELL_COPY } from '@/lib/shell/copy';
import type { ShellOrg } from '@/lib/shell/types';
import './shell.css';

const LIST_ID = 'shell-org-list';

/**
 * The organisation switcher (plan 1A Task 11, ruling L2-53). One organisation is its name, with no control. Two or more are a
 * disclosure: a button naming the open organisation, and a list of the person's organisations under it, in the rail's flow.
 * Switching is a navigation to the other organisation's address, never a change of state, so browser tabs stay independent.
 *
 * The name comes only from `orgs`, the person's own organisations: an address naming another organisation shows no name for
 * it (S-31). The list's links are rendered only while it is open, so no hidden link comes first in the page. It is open only
 * at the address where it was opened, so it closes when the address changes, with no effect.
 */
export default function OrgSwitcher({ orgs, currentSlug }: { orgs: readonly ShellOrg[]; currentSlug: string | null }) {
  const pathname = usePathname();
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt !== null && openAt === pathname;
  const current = orgs.find((o) => o.slug === currentSlug);

  if (orgs.length === 1) {
    return (
      <div className="shell-org">
        <span className="shell-org__name">{orgs[0].name}</span>
      </div>
    );
  }
  return (
    <div className="shell-org">
      <button type="button" className="shell-org__button" aria-expanded={open} aria-controls={LIST_ID}
        onClick={() => setOpenAt(open ? null : pathname)}>
        {current ? <span className="shell-org__name">{current.name}</span> : null}
        <span className="shell-org__action">{SHELL_COPY.switchOrganisation}</span>
        <Icon name="chevron-down" />
      </button>
      <ul id={LIST_ID} className="shell-org__list" hidden={!open}>
        {open
          ? orgs.map((o) => (
            <li key={o.slug}>
              <Link href={`/orgs/${o.slug}/dashboard`} className="shell-org__link" aria-current={o.slug === currentSlug ? 'true' : undefined}>
                {o.name}
              </Link>
            </li>
          ))
          : null}
      </ul>
    </div>
  );
}
