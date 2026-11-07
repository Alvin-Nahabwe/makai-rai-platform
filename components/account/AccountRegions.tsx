import type { CSSProperties, ReactElement } from 'react';
import Link from 'next/link';
import type { Identity } from '@/lib/auth/identity';
import { MyAcceptances } from '@/components/legal/MyAcceptances';
import { ReminderEmailsSetting } from '@/components/followup/ReminderEmailsSetting';
import { PersonalExportAndDeletion } from '@/components/account/PersonalExportAndDeletion';
import { DraftsOnThisDevice } from '@/components/decision/DraftsOnThisDevice';
import { SignOutEverywhere } from './SignOutEverywhere';

const TARGET: CSSProperties = { display: 'inline-block', minWidth: '24px', minHeight: '24px' };

export interface AccountRegionsProps {
  identity: Identity;
  reminderEmails: boolean;
  lastActiveOwnerOf: string[];
}

/**
 * S-21's regions in W-12's order (SRS lines 2253-2283), from what the page has read, so it renders without the loaders.
 * The page's own regions are each a labelled section: "My account" (name and email, read only: no route changes a name,
 * owner question B22, so neither "Save name" nor "Name saved." appears), "Password" and "Sessions". The slots follow,
 * each owning its own region and texts and rendered with its contract props, never edited here (contract "Screens and
 * slots"): `MyAcceptances` (ACC-a, the read-only record), `ReminderEmailsSetting` (FUP), `PersonalExportAndDeletion`
 * (EXP: "My data" and "Delete my account", M-38 from `lastActiveOwnerOf`) and `DraftsOnThisDevice` (DEC-b).
 */
export function AccountRegions({ identity, reminderEmails, lastActiveOwnerOf }: AccountRegionsProps): ReactElement {
  return (
    <div className="page-content">
      <h1>My account</h1>
      <section aria-labelledby="account-details-heading"><h2 id="account-details-heading">My account</h2>
        <dl>
          <dt>Name</dt>
          <dd>{identity.name}</dd>
          <dt>Email</dt>
          <dd>{identity.email}</dd>
        </dl>
      </section>
      <section aria-labelledby="account-password-heading"><h2 id="account-password-heading">Password</h2>
        <p><Link href="/change-password" style={TARGET}>Change password</Link></p>
      </section>
      <section aria-labelledby="account-sessions-heading"><h2 id="account-sessions-heading">Sessions</h2>
        <div><SignOutEverywhere userId={identity.userId} /></div>
      </section>
      <MyAcceptances userId={identity.userId} />
      <ReminderEmailsSetting enabled={reminderEmails} />
      <PersonalExportAndDeletion userId={identity.userId} lastActiveOwnerOf={lastActiveOwnerOf} />
      <DraftsOnThisDevice userId={identity.userId} />
    </div>
  );
}
