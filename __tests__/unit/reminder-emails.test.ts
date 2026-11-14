import { describe, expect, it } from 'vitest';
import { mitigationDueEmail } from '@/lib/email/templates/mitigationDue';
import { mitigationOverdueEmail } from '@/lib/email/templates/mitigationOverdue';
import { MARKER_PATTERN } from '../helpers/markers';
import { EMAIL_COPY } from '@/lib/email/copy';
import { escapeHtml } from '@/lib/email/escape';

const IN = { orgName: 'Makerere CAI Lab', dueDate: '2026-11-02', dashboardUrl: 'https://makrai.org/orgs/makerere-cai/dashboard' };

describe('E-04 and E-05', () => {
  const URL_ = IN.dashboardUrl;
  const textOf = (intro: string) => `${intro}\n\n${EMAIL_COPY.reminder.linkLead}\n${URL_}\n\n${EMAIL_COPY.reminder.closing}`;
  const htmlOf = (intro: string) =>
    [`<p>${intro}</p>`, `<p>${EMAIL_COPY.reminder.linkLead}</p>`, `<p><a href="${URL_}">${URL_}</a></p>`, `<p>${EMAIL_COPY.reminder.closing}</p>`].join('\n');

  it('FR-FUP-03: E-04 and E-05 carry the 7.5.9 copy', () => {
    expect(mitigationDueEmail(IN).subject).toBe(EMAIL_COPY.reminder.dueSubject('Makerere CAI Lab'));
    expect(mitigationDueEmail(IN).subject).toBe('A mitigation is due today in Makerere CAI Lab');
    expect(mitigationDueEmail(IN).text).toBe(textOf(EMAIL_COPY.reminder.dueIntro('Makerere CAI Lab', '2 Nov 2026')));
    expect(mitigationDueEmail(IN).html).toBe(htmlOf(EMAIL_COPY.reminder.dueIntro('Makerere CAI Lab', '2 Nov 2026')));
    expect(mitigationOverdueEmail(IN).subject).toBe(EMAIL_COPY.reminder.overdueSubject('Makerere CAI Lab'));
    expect(mitigationOverdueEmail(IN).subject).toBe('A mitigation is 7 days overdue in Makerere CAI Lab');
    expect(mitigationOverdueEmail(IN).text).toBe(textOf(EMAIL_COPY.reminder.overdueIntro('Makerere CAI Lab', '2 Nov 2026')));
    expect(mitigationOverdueEmail(IN).html).toBe(htmlOf(EMAIL_COPY.reminder.overdueIntro('Makerere CAI Lab', '2 Nov 2026')));
  });

  it('16d: the rendered words of E-04 and E-05 (the coordinator\'s ruling)', () => {
    expect(mitigationDueEmail(IN).text).toBe(
      'A mitigation assigned to you in Makerere CAI Lab is due today, 2 Nov 2026.\n\nOpen Home to see it:\nhttps://makrai.org/orgs/makerere-cai/dashboard\n\n' +
        'You get this email because this mitigation is assigned to you. You can turn these emails off in My account.',
    );
    expect(mitigationOverdueEmail(IN).text.split('\n\n')[0]).toBe('A mitigation assigned to you in Makerere CAI Lab was due on 2 Nov 2026. It is now 7 days late.');
  });

  it('16d: with & and < in the organisation name the HTML part is escaped and equals the copy', () => {
    const orgName = 'Lab & <Co>';
    expect(mitigationDueEmail({ ...IN, orgName }).html).toBe(htmlOf(EMAIL_COPY.reminder.dueIntro(escapeHtml(orgName), '2 Nov 2026')));
    expect(mitigationOverdueEmail({ ...IN, orgName }).html).toBe(htmlOf(EMAIL_COPY.reminder.overdueIntro(escapeHtml(orgName), '2 Nov 2026')));
  });

  it('16d: no line of either text part holds the link followed by another character', () => {
    for (const e of [mitigationDueEmail(IN), mitigationOverdueEmail(IN)]) {
      expect(e.text.split('\n').filter((l) => l.includes('https://'))).toEqual([URL_]);
    }
  });

  it('NFR-PRIV-02: E-04 and E-05 carry no marker and no count', () => {
    for (const e of [mitigationDueEmail(IN), mitigationOverdueEmail(IN)]) {
      const all = e.subject + e.text + e.html;
      expect(all.match(MARKER_PATTERN)).toBeNull();
      expect(all.replace(/https:\/\/makrai\.org/g, '').replace(/2 Nov 2026/g, '').replace(/7 days/g, '').match(/\d/)).toBeNull();
    }
  });

  it('NFR-PRIV-02 6.1: the organisation name is escaped in the HTML part', () => {
    for (const make of [mitigationDueEmail, mitigationOverdueEmail]) {
      const e = make({ ...IN, orgName: '<img src=x onerror=alert(1)>' });
      expect(e.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(e.html).not.toContain('<img');
    }
  });

  it('NFR-PRIV-04: the link carries only the organisation slug', () => {
    expect(mitigationDueEmail(IN).html).toMatch(/href="https:\/\/makrai\.org\/orgs\/makerere-cai\/dashboard"/);
    expect(mitigationOverdueEmail(IN).html).toMatch(/href="https:\/\/makrai\.org\/orgs\/makerere-cai\/dashboard"/);
  });
});
