import type { OrgRole } from '@prisma/client';
import type { ReactElement } from 'react';

export type WelcomeNoticeProps = { orgName: string; role: OrgRole };

/**
 * "Welcome to <organisation>. Your role is <role>." when the dashboard query has `welcome=1` (7.4.2 row S-04 / S-05; gap
 * G033), in role="status". The organisation name is a text node. A slot of its screen (contract "Screens and slots"): the
 * screen's owner renders it, ACC-a fills it.
 */
export function WelcomeNotice({ orgName, role }: WelcomeNoticeProps): ReactElement | null {
  return (
    <p role="status" style={{ marginBottom: 'var(--space-4)' }}>
      {`Welcome to ${orgName}. Your role is ${role}.`}
    </p>
  );
}
