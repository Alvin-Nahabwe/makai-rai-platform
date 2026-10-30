import type { OrgRole } from '@prisma/client';
import type { ReactElement } from 'react';

export type WelcomeNoticeProps = { orgName: string; role: OrgRole };

/**
 * "Welcome to <organisation>. Your role is <role>." when the dashboard query has `welcome=1`. A slot of its screen (contract "Screens and slots"): the screen's owner renders it, ACC-a fills it.
 */
// SLOT_STUB: ACC-a
export function WelcomeNotice(_props: WelcomeNoticeProps): ReactElement | null {
  return null;
}
