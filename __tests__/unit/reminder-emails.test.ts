import { describe, expect, it } from 'vitest';
import { mitigationDueEmail } from '@/lib/email/templates/mitigationDue';
import { mitigationOverdueEmail } from '@/lib/email/templates/mitigationOverdue';
import { MARKER_PATTERN } from '../helpers/markers';

const IN = { orgName: 'Makerere CAI Lab', dueDate: '2026-11-02', dashboardUrl: 'https://makrai.org/orgs/makerere-cai/dashboard' };

describe('E-04 and E-05', () => {
  it('FR-FUP-03: E-04 and E-05 carry the 7.5.9 copy', () => {
    expect(mitigationDueEmail(IN).subject).toBe('A mitigation is due today in Makerere CAI Lab');
    expect(mitigationDueEmail(IN).text).toBe('A mitigation you own in Makerere CAI Lab is due today, 2 Nov 2026. See your mitigations: https://makrai.org/orgs/makerere-cai/dashboard. You get this email because you own a mitigation that is due. You can turn these emails off in My account.');
    expect(mitigationOverdueEmail(IN).subject).toBe('A mitigation is 7 days overdue in Makerere CAI Lab');
    expect(mitigationOverdueEmail(IN).text).toContain('A mitigation you own in Makerere CAI Lab was due 2 Nov 2026. See your mitigations:');
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
