import type { CSSProperties, ReactElement } from 'react';
import Link from 'next/link';
import type { Identity } from '@/lib/auth/identity';
import { MyAcceptances } from '@/components/legal/MyAcceptances';
import { ReminderEmailsSetting } from '@/components/followup/ReminderEmailsSetting';
import { PersonalExportAndDeletion } from '@/components/account/PersonalExportAndDeletion';
import { DraftsOnThisDevice } from '@/components/decision/DraftsOnThisDevice';
import { ACCOUNT_COPY } from '@/lib/account/copy';
import { SignOutEverywhere } from './SignOutEverywhere';

const TARGET: CSSProperties = { display: 'inline-block', minWidth: '24px', minHeight: '24px' };
// The page's h1, sections and slots in one column, 2rem apart; a heading sits close to its own content.
// One column that may shrink below its content's width (minmax(0, 1fr)): a long unbroken email must wrap or scroll inside its
// own section, not widen every section of the page on a phone.
const REGIONS: CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 'var(--space-8)' };
// A name or an email with no space or hyphen wraps inside its own line box.
const UNBROKEN: CSSProperties = { overflowWrap: 'anywhere' };
const SECTION_HEADING: CSSProperties = { marginBottom: 'var(--space-2)' };

export interface AccountRegionsProps {
  identity: Identity;
  reminderEmails: boolean;
  lastActiveOwnerOf: string[];
}

/**
 * S-21's regions in W-12's order (SRS lines 2253-2283), from what the page has read, so it renders without the loaders.
 * The page's own regions are each a labelled section: "Name and email" (read only: no route changes a name,
 * owner question B22, so neither "Save name" nor "Name saved." appears), "Password" and "Signed-in devices". The slots follow,
 * each owning its own region and texts and rendered with its contract props, never edited here (contract "Screens and
 * slots"): `MyAcceptances` (ACC-a, the read-only record), `ReminderEmailsSetting` (FUP), `PersonalExportAndDeletion`
 * (EXP: "My data" and "Delete my account", M-38 from `lastActiveOwnerOf`) and `DraftsOnThisDevice` (DEC-b).
 */
export function AccountRegions({ identity, reminderEmails, lastActiveOwnerOf }: AccountRegionsProps): ReactElement {
  const t = ACCOUNT_COPY.page;
  return (
    <div className="page-content" style={REGIONS}>
      <h1>{t.heading}</h1>
      <section aria-labelledby="account-details-heading"><h2 id="account-details-heading" style={SECTION_HEADING}>{t.detailsHeading}</h2>
        <dl>
          <dt>{t.name}</dt>
          <dd style={UNBROKEN}>{identity.name}</dd>
          <dt>{t.email}</dt>
          <dd style={UNBROKEN}>{identity.email}</dd>
        </dl>
      </section>
      <section aria-labelledby="account-password-heading"><h2 id="account-password-heading" style={SECTION_HEADING}>{t.passwordHeading}</h2>
        <p><Link href="/change-password" style={TARGET}>{t.changePassword}</Link></p>
      </section>
      <section aria-labelledby="account-sessions-heading"><h2 id="account-sessions-heading" style={SECTION_HEADING}>{t.devicesHeading}</h2>
        <div><SignOutEverywhere userId={identity.userId} /></div>
      </section>
      <MyAcceptances userId={identity.userId} />
      <ReminderEmailsSetting enabled={reminderEmails} />
      <PersonalExportAndDeletion userId={identity.userId} lastActiveOwnerOf={lastActiveOwnerOf} />
      <DraftsOnThisDevice userId={identity.userId} />
    </div>
  );
}
