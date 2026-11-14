import type { EmailContent } from '../templates';
import { escapeHtml } from '../escape';
import { EMAIL_COPY } from '../copy';
import { formatDay } from '../../format/dates';
import type { CalendarDate } from '../../../types/record';

/**
 * E-04 (FR-FUP-03, SRS 7.5.9 line 2603): a mitigation assigned to the reader is due. SRS 6.1 and
 * NFR-PRIV-02: only the organisation name, one date and one link; no record text, project name or
 * count. Pure: no I/O; `lib/reminders/job.ts` sends it through lib/email/send.ts.
 */
export type ReminderEmailInput = { orgName: string; dueDate: CalendarDate; dashboardUrl: string };

/** The part E-04 and E-05 share; `intro` is the first paragraph, built from `EMAIL_COPY.reminder` with the organisation as written. */
export function buildReminderEmail(i: ReminderEmailInput, subject: string, intro: (organisation: string) => string): EmailContent {
  const { reminder } = EMAIL_COPY;
  return {
    subject,
    text: [intro(i.orgName), `${reminder.linkLead}\n${i.dashboardUrl}`, reminder.closing].join('\n\n'),
    html: [
      `<p>${intro(escapeHtml(i.orgName))}</p>`,
      `<p>${reminder.linkLead}</p>`,
      `<p><a href="${escapeHtml(i.dashboardUrl)}">${escapeHtml(i.dashboardUrl)}</a></p>`,
      `<p>${reminder.closing}</p>`,
    ].join('\n'),
  };
}

export function mitigationDueEmail(i: ReminderEmailInput): EmailContent {
  const date = formatDay(i.dueDate);
  return buildReminderEmail(i, EMAIL_COPY.reminder.dueSubject(i.orgName), (org) => EMAIL_COPY.reminder.dueIntro(org, date));
}
