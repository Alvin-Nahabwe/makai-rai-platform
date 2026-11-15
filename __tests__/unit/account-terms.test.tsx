import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Identity } from '@/lib/auth/identity';
import { REMINDER_SETTING_COPY } from '@/lib/followup/copy';
import { TERM_MITIGATION } from '@/lib/vocabulary/terms';
import { firstUseProblems } from '../helpers/firstUseHtml';

/**
 * Lane 6, FX2 (B5 review I1): S-21's first use of "mitigation" is the reminder setting's label. The page (a server
 * component) marks the word with `Term` and hands the client setting the mitigation's `Definition`; the checkbox names
 * it with aria-describedby (spec 6; definitions-howto.md). The other slots are not under test, so they render nothing.
 */
vi.mock('@/components/legal/MyAcceptances', () => ({ MyAcceptances: () => null }));
vi.mock('@/components/account/PersonalExportAndDeletion', () => ({ PersonalExportAndDeletion: () => null }));
vi.mock('@/components/decision/DraftsOnThisDevice', () => ({ DraftsOnThisDevice: () => null }));
vi.mock('next-auth/react', () => ({ signOut: vi.fn() }));
vi.mock('next/navigation', async (orig) => ({ ...(await orig<typeof import('next/navigation')>()), useRouter: () => ({ push: vi.fn() }) }));

const { AccountRegions } = await import('@/components/account/AccountRegions');
const id: Identity = { userId: 'u1', email: 'amina@fixture.test', name: 'Amina N.', platformRole: 'assessor', mustChangePassword: false };

describe('S-21 first-use definitions', () => {
  const out = renderToStaticMarkup(<AccountRegions identity={id} reminderEmails lastActiveOwnerOf={[]} />);

  it('the reminder label marks "mitigation", the checkbox names its definition, which sits right after the label', () => {
    const [before, after] = REMINDER_SETTING_COPY.label.split('mitigation');
    expect(out).toMatch(new RegExp(`<label[^>]*>${before}<span data-term="${TERM_MITIGATION.id}">mitigation</span>${after}</label><p[^>]*><span class="ui-definition" id="account-mitigation-definition" data-definition="${TERM_MITIGATION.id}">${TERM_MITIGATION.definition}</span></p>`));
    expect(out).toMatch(/<input[^>]*type="checkbox"[^>]*aria-describedby="account-mitigation-definition"/);
    expect(firstUseProblems(out, ['Amina N.', id.email])).toEqual([]);
  });

  it('the client setting does not import the vocabulary (ruling X-2): the page hands it the nodes', () => {
    const src = readFileSync('components/followup/ReminderEmailsSetting.tsx', 'utf8');
    expect(src.startsWith("'use client'")).toBe(true);
    expect(src).not.toMatch(/lib\/vocabulary/);
  });
});
