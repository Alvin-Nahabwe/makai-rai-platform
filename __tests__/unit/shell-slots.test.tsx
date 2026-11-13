import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { SignOutWithDraftsGuard } from '@/components/decision/SignOutWithDraftsGuard';
import { NewerLegalTextNotice } from '@/components/legal/NewerLegalTextNotice';

/**
 * The two slots the signed-in shell carries (ported unchanged from the sidebar's test, plan 1A Task 11): the sign-out guard
 * around the rail's Sign out (M-41) and the newer-legal-text notice first in main (M-39). Kept out of __tests__/unit/ui,
 * which runs with no database: the notice reads one.
 */
describe('the slots the shell carries (ported unchanged from the sidebar test)', () => {
  it('M-41: before any press the guard renders its children, and no warning', () => {
    // DEC-b filled the slot: the guard wraps the button to catch a press, and shows M-41 only when this device holds drafts.
    const html = renderToStaticMarkup(<SignOutWithDraftsGuard userId="u1"><button>Sign out</button></SignOutWithDraftsGuard>);
    expect(html).toContain('<button>Sign out</button>');
    expect(html).not.toContain('answers on this device');
  });

  it('M-39: the notice renders nothing for an account offered no newer text', async () => {
    // ACC-a filled the slot (Task 12); an account with no acceptance row is offered nothing (lib/data/acceptances.ts).
    expect(await NewerLegalTextNotice({ userId: 'u1' })).toBeNull();
  });

  it('M-39 M-41: a slot keeps its producer marker until the producer fills it', () => {
    expect(readFileSync('components/legal/NewerLegalTextNotice.tsx', 'utf8')).not.toMatch(/SLOT_STUB/);   // ACC-a, Task 12
    expect(readFileSync('components/decision/SignOutWithDraftsGuard.tsx', 'utf8')).not.toMatch(/SLOT_STUB/);   // DEC-b, Task 7
  });
});
