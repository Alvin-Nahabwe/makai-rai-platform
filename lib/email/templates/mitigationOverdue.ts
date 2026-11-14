import type { EmailContent } from '../templates';
import { EMAIL_COPY } from '../copy';
import { formatDay } from '../../format/dates';
import { buildReminderEmail, type ReminderEmailInput } from './mitigationDue';

/** E-05 (FR-FUP-03, SRS 7.5.9 line 2604): seven days after the due date. Same content rules as E-04. */
export function mitigationOverdueEmail(i: ReminderEmailInput): EmailContent {
  const date = formatDay(i.dueDate);
  return buildReminderEmail(i, EMAIL_COPY.reminder.overdueSubject(i.orgName), (org) => EMAIL_COPY.reminder.overdueIntro(org, date));
}
