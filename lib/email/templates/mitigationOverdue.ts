import type { EmailContent } from '../templates';
import { formatDay } from '../../format/dates';
import { buildReminderEmail, type ReminderEmailInput } from './mitigationDue';

/** E-05 (FR-FUP-03, SRS 7.5.9 line 2604): seven days after the due date. Same content rules as E-04. */
export function mitigationOverdueEmail(i: ReminderEmailInput): EmailContent {
  return buildReminderEmail(i, (org) => `A mitigation is 7 days overdue in ${org}`, `was due ${formatDay(i.dueDate)}`);
}
