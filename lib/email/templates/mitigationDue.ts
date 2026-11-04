import type { EmailContent } from '../templates';
import { escapeHtml } from '../escape';
import { formatDay } from '../../format/dates';
import type { CalendarDate } from '../../../types/record';

/**
 * E-04 (FR-FUP-03, SRS 7.5.9 line 2603): a mitigation the reader owns is due. SRS 6.1 and
 * NFR-PRIV-02: only the organisation name, one date and one link; no record text, project name or
 * count. Pure: no I/O; `lib/reminders/job.ts` sends it through lib/email/send.ts.
 */
export type ReminderEmailInput = { orgName: string; dueDate: CalendarDate; dashboardUrl: string };

/** The part E-04 and E-05 share; `when` is the clause after "A mitigation you own in <organisation>". */
export function buildReminderEmail(i: ReminderEmailInput, subject: (org: string) => string, when: string): EmailContent {
  const link = i.dashboardUrl;
  const intro = (org: string) => `A mitigation you own in ${org} ${when}.`;
  const see = 'See your mitigations: ';
  const why = 'You get this email because you own a mitigation that is due.';
  const off = 'You can turn these emails off in My account.';
  return {
    subject: subject(i.orgName),
    text: `${intro(i.orgName)} ${see}${link}. ${why} ${off}`,
    html: [
      `<p>${escapeHtml(intro(i.orgName))}</p>`,
      `<p>${see}<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>.</p>`,
      `<p>${why} ${off}</p>`,
    ].join('\n'),
  };
}

export function mitigationDueEmail(i: ReminderEmailInput): EmailContent {
  return buildReminderEmail(i, (org) => `A mitigation is due today in ${org}`, `is due today, ${formatDay(i.dueDate)}`);
}
