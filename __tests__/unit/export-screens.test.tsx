import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PREPARING, REFUSED_TEXT, TeamExportPanel, refusedFrom } from '../../components/export/TeamExportPanel';
import {
  DeleteConfirm, PREPARING_PERSONAL, PersonalExportAndDeletionForm, deletionOutcome,
} from '../../components/account/PersonalExportAndDeletionForm';
import { PersonalExportAndDeletion } from '../../components/account/PersonalExportAndDeletion';
import { TeamExportLink } from '../../components/org/TeamExportLink';
import { DELETION_UNCONFIRMED } from '../../lib/export/messages';
import { PERSONAL_DATA_COPY, phraseLabel } from '../../lib/account/copy';

/**
 * S-20 (TeamExportPanel), the S-21 slot (PersonalExportAndDeletion) and the S-30 slot (TeamExportLink):
 * the words of M-37, M-38, W-12 notes 4 and 5 and S-21's row of 7.4.2 (SRS lines 2276-2291, 2389).
 */

const M38 = 'You are the only owner of Makerere CAI Lab with an active account. Make someone else an owner first, then delete your account.';

describe('S-20 TeamExportPanel', () => {
  it('M-37 FR-EXP-01: S-20 says what will be exported, about how big, as one ZIP file, and says it is preparing after the click', () => {
    const html = renderToStaticMarkup(<TeamExportPanel href="/api/v1/orgs/o/export" scopeName="Maternal-risk triage" aboutBytes={2_400_000} refused={null} />);
    expect(html).toContain('Records of Maternal-risk triage: about 2.4 MB, as one ZIP file.');
    expect(html).toMatch(/<a[^>]*href="\/api\/v1\/orgs\/o\/export"[^>]*>Download records<\/a>/);
    expect(html).toMatch(/role="status"/); // the region PREPARING is written into on click
    expect(html).not.toContain(PREPARING); // not before the click
    expect(PREPARING).toBe('Preparing the export. Large projects can take a few minutes.');
    expect(html).not.toMatch(/role="alert"/);
  });

  it('S-20: the panel has no heading of its own and no label pointing at a missing heading', () => {
    // CONSOLIDATED section 4: the panel's "Download" heading repeated its button; the page's h1 names the page.
    const html = renderToStaticMarkup(<TeamExportPanel href="/api/v1/orgs/o/export" scopeName="Maternal-risk triage" aboutBytes={2_400_000} refused={null} />);
    expect(html).not.toMatch(/<h[1-6][\s>]/);
    expect(html).not.toContain('aria-labelledby');
    expect(html).toMatch(/>Download records<\/a>/);
  });

  it('FR-EXP-01 (owner question B4): S-20 says why an export was refused, for two running and for the hourly limit', () => {
    expect(REFUSED_TEXT).toEqual({ export_busy: 'Two exports are already being prepared. Try again when one has finished.', rate_limited: 'You can start 3 exports an hour. Try again later.' });
    for (const r of ['export_busy', 'rate_limited'] as const) {
      const html = renderToStaticMarkup(<TeamExportPanel href="/api/v1/orgs/o/export" scopeName="Maternal-risk triage" aboutBytes={2_400_000} refused={r} />);
      expect(html).toMatch(new RegExp(`role="alert"[^>]*>${REFUSED_TEXT[r]}<`));
      expect(html).toMatch(/>Download records<\/a>/);
    }
    expect([refusedFrom({ refused: 'export_busy' }), refusedFrom({ refused: 'rate_limited' }), refusedFrom({ refused: '<script>' }),
      refusedFrom({ refused: ['export_busy', 'x'] }), refusedFrom({})]).toEqual(['export_busy', 'rate_limited', null, null, null]);
  });

  it('NFR-SEC-11: a scope name is shown as text, never as markup', () => {
    const html = renderToStaticMarkup(<TeamExportPanel href="/x" scopeName={'<img src=x onerror=alert(1)>'} aboutBytes={0} refused={null} />);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('S-21 PersonalExportAndDeletion', () => {
  it('FR-EXP-02 (7.4.2 S-21): Export my data says Preparing your file... once pressed', () => {
    expect(PREPARING_PERSONAL).toBe('Preparing your file...');
  });

  it('FR-EXP-02: S-21 offers Export my data with what it does and does not include', () => {
    const html = renderToStaticMarkup(<PersonalExportAndDeletionForm userId="u1" lastActiveOwnerOf={[]} />);
    expect(html).toMatch(new RegExp(`<a[^>]*href="/api/users/me/export"[^>]*>${PERSONAL_DATA_COPY.download}</a>`));
    expect(html).toContain(PERSONAL_DATA_COPY.downloadIntro);
    expect(html).toMatch(new RegExp(`<h2[^>]*>${PERSONAL_DATA_COPY.dataHeading}</h2>`));
    expect(html).toMatch(new RegExp(`<h2[^>]*>${PERSONAL_DATA_COPY.deleteHeading}</h2>`));
    expect(html).toContain(PERSONAL_DATA_COPY.deleteConsequence.replace(/"/g, '&quot;'));
    expect(html).toMatch(new RegExp(`<button[^>]*>${PERSONAL_DATA_COPY.deleteTrigger}</button>`));
  });

  it('UX-29 FR-EXP-03: Delete my account confirms inline with a password and the typed phrase, both pasteable, and a button that repeats the action', () => {
    const html = renderToStaticMarkup(<DeleteConfirm userId="u1" onCancel={() => {}} />);
    expect(html).toMatch(/<input[^>]*type="password"[^>]*autoComplete="current-password"|<input[^>]*autoComplete="current-password"[^>]*type="password"/i);
    expect(html).not.toMatch(/onpaste|readonly/i);
    expect(html).toContain(phraseLabel('DELETE MY ACCOUNT'));
    expect(html).toMatch(new RegExp(`<label[^>]*for="[^"]+"[^>]*>${PERSONAL_DATA_COPY.passwordLabel}`));
    expect(html).toMatch(new RegExp(`<button[^>]*>${PERSONAL_DATA_COPY.deleteAction}</button>`));
    expect(html).toMatch(/<button[^>]*>Cancel<\/button>/);
    expect(html).toContain(PERSONAL_DATA_COPY.objectName);
  });

  it('M-38 FR-EXP-03: for a last owner the delete button is replaced by the message naming the organisation', () => {
    const html = renderToStaticMarkup(<PersonalExportAndDeletionForm userId="u1" lastActiveOwnerOf={['Makerere CAI Lab']} />);
    expect(html).toContain(M38);
    expect(html).not.toMatch(/>Delete my account\.\.\.</);
    expect(html).toMatch(new RegExp(`>${PERSONAL_DATA_COPY.download}</a>`)); // the export stays offered
  });

  it('M-38 FR-EXP-03: the server slot renders the form with its contract props', () => {
    expect(renderToStaticMarkup(<PersonalExportAndDeletion userId="u1" lastActiveOwnerOf={['Makerere CAI Lab']} />)).toContain(M38);
    expect(renderToStaticMarkup(<PersonalExportAndDeletion userId="u1" lastActiveOwnerOf={[]} />)).toMatch(/>Delete my account\.\.\.<\/button>/);
  });

  it('FR-EXP-03 UX-29: each answer of route 39 maps to what S-21 shows', () => {
    expect(deletionOutcome(204, null)).toEqual({ kind: 'deleted' });
    expect(deletionOutcome(422, { code: 'validation', fields: [{ field: 'password', message: 'The password is not right.' }] }))
      .toEqual({ kind: 'field', field: 'password', message: 'The password is not right.' });
    expect(deletionOutcome(422, { code: 'validation', fields: [{ field: 'phrase', message: 'Type DELETE MY ACCOUNT exactly.' }] }))
      .toEqual({ kind: 'field', field: 'phrase', message: 'Type DELETE MY ACCOUNT exactly.' });
    expect(deletionOutcome(409, { code: 'last_active_owner', organisation: 'Makerere CAI Lab', error: 'ignored' })).toEqual({ kind: 'refused', message: M38 });
    expect(deletionOutcome(409, { code: 'platform_admin_account', error: 'x' }))
      .toEqual({ kind: 'refused', message: "The platform administrator's account cannot be deleted here. Ask the operator to hand the role over first." });
    // the hourly limit says how long to wait (contract rate_limited: "wait <n> minutes", from retryAfterSeconds)
    expect(deletionOutcome(429, { code: 'rate_limited', retryAfterSeconds: 3535 })).toEqual({ kind: 'too_many', message: 'Too many attempts. Try again in 59 minutes.' });
    expect(deletionOutcome(429, { code: 'rate_limited', retryAfterSeconds: 30 })).toEqual({ kind: 'too_many', message: 'Too many attempts. Try again in 1 minute.' });
    expect(deletionOutcome(429, null)).toEqual({ kind: 'too_many', message: 'Too many attempts. Try again in an hour.' });
    // a 5xx (or no answer) may come after part of the deletion was done, so the result is not known
    for (const status of [500, 502, 503]) {
      expect(deletionOutcome(status, { code: 'internal_error' })).toEqual({ kind: 'unconfirmed', message: DELETION_UNCONFIRMED });
    }
    // a 401 means this session has ended, which a deletion that went through does (a retry after a lost answer)
    expect(deletionOutcome(401, { code: 'unauthenticated' })).toEqual({ kind: 'unconfirmed', message: DELETION_UNCONFIRMED });
    expect(DELETION_UNCONFIRMED).toBe('We could not confirm the deletion. Reload this page: if your account is still here, try again.');
    // other 4xx refusals: a field the form does not have, an unknown 409 code, a 403
    for (const [status, body] of [[422, { fields: [{ field: 'body', message: 'x' }] }], [409, { code: 'other' }], [403, { code: 'cross_origin' }]] as const) {
      expect(deletionOutcome(status, body)).toEqual({ kind: 'not_deleted', message: 'Not deleted. Nothing was changed. Try again.' });
    }
  });
});

describe('S-30 TeamExportLink', () => {
  it('FR-EXP-01 (S-30 slot): the organisation page links to the team export for owners and admins only', () => {
    expect(renderToStaticMarkup(<TeamExportLink orgSlug="o" canExport />)).toMatch(/href="\/orgs\/o\/export"/);
    expect(renderToStaticMarkup(<TeamExportLink orgSlug="o" canExport={false} />)).toBe('');
  });
});
