import { describe, expect, it, vi } from 'vitest';
import { mitigationDueEmail } from '@/lib/email/templates/mitigationDue';
import { mitigationOverdueEmail } from '@/lib/email/templates/mitigationOverdue';
import { MARKER_PATTERN } from '../helpers/markers';
import { EMAIL_COPY } from '@/lib/email/copy';
import { escapeHtml } from '@/lib/email/escape';
import { invitationEmail } from '@/lib/email/templates';
import { accountCreatedEmail } from '@/lib/email/templates/accountCreated';
import { passwordResetEmail } from '@/lib/email/templates/passwordReset';
import { passwordChangedEmail } from '@/lib/email/templates/passwordChanged';
import { lintText } from '../lint/helpers/vocabulary-scan';

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
    expect(mitigationOverdueEmail(IN).text.split('\n\n')[0]).toBe(EMAIL_COPY.reminder.overdueIntro('Makerere CAI Lab', '2 Nov 2026'));
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

  it('16d: the text part of each of the six changed emails, rendered with real inputs, holds no retired phrase', () => {
    vi.stubEnv('NEXTAUTH_URL', 'https://makrai.org');
    try {
      const texts = {
        invitation: invitationEmail({ orgName: IN.orgName, role: 'assessor', acceptUrl: 'https://makrai.org/invitations/abc', expiresAt: new Date('2026-11-04T09:00:00Z') }).text,
        accountCreated: accountCreatedEmail({ orgName: IN.orgName, createdAt: new Date('2026-11-02T08:00:00Z') }).text,
        passwordReset: passwordResetEmail({ resetUrl: 'https://makrai.org/reset-password#abc' }).text,
        passwordChanged: passwordChangedEmail({ changedAt: new Date('2026-11-02T08:00:00Z') }).text,
        mitigationDue: mitigationDueEmail(IN).text,
        mitigationOverdue: mitigationOverdueEmail(IN).text,
      };
      // The vocabulary lint's own scanner, the function it runs over every string it reads.
      expect(Object.entries(texts).flatMap(([name, text]) => lintText(name, text).map((h) => `${h.where}: ${h.match}`))).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
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
