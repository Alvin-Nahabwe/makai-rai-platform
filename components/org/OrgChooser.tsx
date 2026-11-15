import type { ReactElement } from 'react';
import { ItemPlate } from '@/components/ui/ItemPlate';
import { ORG_COPY } from '@/lib/org/copy';
import './OrgChooser.css';

export type OrgChoice = { slug: string; name: string; roleLabel: string };

/**
 * S-07's list (plan 1B Task 8, ruling L5-17): one item plate per organisation the person is an active member of, each
 * linking to that organisation's Home and saying the person's role there ("You are an Owner"). `roleLabel` is the role with
 * its article from `roleWithArticle` (lib/org/copy.ts), chosen through the fixed role map, never a raw value. The list keeps
 * role="list" because Safari drops the list role from a list styled `list-style: none`. Server code: ORG_COPY is server-only.
 */
export function OrgChooser({ orgs }: { orgs: ReadonlyArray<OrgChoice> }): ReactElement {
  return (
    <ul className="org-chooser" role="list" aria-label={ORG_COPY.chooser.listLabel}>
      {orgs.map((org) => (
        <li key={org.slug}>
          <ItemPlate title={org.name} href={`/orgs/${org.slug}/dashboard`} state={ORG_COPY.chooser.youAre(org.roleLabel)} />
        </li>
      ))}
    </ul>
  );
}
