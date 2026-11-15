import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const nav = vi.hoisted(() => ({ redirect: vi.fn((to: string) => { throw new Error(`REDIRECT ${to}`); }) }));
vi.mock('next/navigation', () => ({ redirect: nav.redirect, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('next-auth/react', () => ({ signOut: vi.fn() }));

const identity = vi.hoisted(() => ({
  current: { userId: 'u1', email: 'a@example.invalid', name: 'Amina Namusoke', platformRole: 'assessor', mustChangePassword: false } as {
    userId: string; email: string; name: string | null; platformRole: 'admin' | 'assessor'; mustChangePassword: boolean;
  },
}));
const data = vi.hoisted(() => ({
  memberships: vi.fn(),
  findUser: vi.fn(),
  missing: vi.fn(),
  offered: vi.fn(),
}));
const soft = vi.hoisted(() => ({ identity: vi.fn() }));
vi.mock('@/lib/auth/identity', () => ({ requireIdentity: async () => identity.current, tryResolveIdentity: soft.identity }));
vi.mock('@/lib/data/preauth', () => ({ membershipsForUser: data.memberships }));
vi.mock('@/lib/data/identity', () => ({ identityDb: { user: { findUnique: data.findUser } } }));
vi.mock('@/lib/data/acceptances', () => ({ missingAcceptances: data.missing, offeredAcceptances: data.offered }));
const idle = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/lib/auth/idleDeadline', () => ({ readSessionDeadlines: idle.read }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));

import { GateFrame, type GateStop } from '@/components/layout/GateFrame';
import { signOutFailure, signOutFromGate } from '@/components/layout/GateSignOut';
import { ACCEPTANCES_COPY } from '@/lib/legal/acceptances/copy';
import { GATE_COPY } from '@/lib/shell/copy';
import { MAIN_CONTENT_ID } from '@/components/layout/SkipLink';
import { textOf } from '@/__tests__/helpers/markup';

/**
 * Plan 1B Task 1 and the lead's ruling L5-1: the gate frame. The Route's rail with no navigation in it: the navy column with
 * the product name, the steps of the door the person is going through (the current one enlarged, "You are here"), and, when
 * signed in, the person's name, Help and Sign out; the page's content in a white card beside it (below 1024 px, under a navy
 * band). No org-scoped link, no percentage, no tick, no orange on the navy.
 */

const hrefs = (html: string) => [...html.matchAll(/\shref="([^"]*)"/g)].map((m) => m[1]);
const ROUTE: readonly GateStop[] = [
  { label: 'Sign in', state: 'done' },
  { label: 'Accept the terms', state: 'current' },
];
const signedIn = (route?: readonly GateStop[], wide?: boolean) =>
  renderToStaticMarkup(<GateFrame variant="signed-in" userName="Amina" userId="u1" route={route} wide={wide}><h1>Title</h1></GateFrame>);
const publicFrame = (route?: readonly GateStop[]) => renderToStaticMarkup(<GateFrame variant="public" route={route}><h1>Title</h1></GateFrame>);

describe('GateFrame, signed in', () => {
  it('T1.3: GateFrame links only to /help and signs out', () => {
    expect(hrefs(renderToStaticMarkup(<GateFrame variant="signed-in" userName="Amina" userId="u1">x</GateFrame>))).toEqual(['/help']);
  });

  it('the product name is text, not a link; the person\'s name, Help and Sign out are in the column', () => {
    const html = signedIn();
    expect(html).toMatch(/<p class="gate__product">MAK-AI RAI Platform<\/p>/);
    expect(textOf(html)).toContain('Amina');
    expect(html).toMatch(/<a class="gate__help" href="\/help">Help<\/a>/);
    expect(textOf(html)).toContain(GATE_COPY.signOut);
  });

  it('Sign out works before hydration: a form that goes to next-auth\'s own sign-out, which asks and posts with its CSRF token', () => {
    const html = signedIn();
    const form = /<form [^>]*>/.exec(html)?.[0] ?? '';
    expect(form).toMatch(/ class="gate__signout"/);
    expect(form).toMatch(/ method="get"/);
    expect(form).toMatch(/ action="\/api\/auth\/signout"/);
    expect(html).toMatch(/<input type="hidden" name="callbackUrl" value="\/login"\/>/);
    expect(html).toMatch(/<button type="submit" class="shell-rail__signout">/);
  });

  it('one banner (the navy column) and one main, the skip link\'s target, around the card', () => {
    const html = signedIn();
    expect(html.match(/<header\b/g)).toHaveLength(1);
    expect(html.match(/<main\b/g)).toHaveLength(1);
    expect(html).toContain(`<main id="${MAIN_CONTENT_ID}" tabindex="-1" class="gate__main"><div class="gate__card"><h1>Title</h1></div></main>`);
    expect(html).toMatch(/^<div class="gate gate--signed-in"><header class="gate__header">/);
  });

  it('wide gives the card the wider measure (acceptances, the chooser)', () => {
    expect(signedIn(undefined, true)).toMatch(/^<div class="gate gate--signed-in gate--wide">/);
  });
});

describe('GateFrame, public (inside the (public) layout\'s own header and main)', () => {
  it('renders no header, no main, no Help, no Sign out and no link at all: the public layout has those', () => {
    const html = publicFrame(ROUTE);
    expect(html).not.toMatch(/<header|<main|<form|<a /);
    expect(hrefs(html)).toEqual([]);
    expect(html).toMatch(/^<div class="gate gate--public"><div class="gate__header"><div class="gate__column"><p class="gate__product">MAK-AI RAI Platform<\/p>/);
    expect(html).toContain('<div class="gate__main"><div class="gate__card"><h1>Title</h1></div></div>');
  });
});

describe('GateRoute: the steps of this door, drawn as a short route', () => {
  const html = signedIn(ROUTE);

  it('a labelled ordered list that keeps its list role when unstyled (Safari)', () => {
    expect(html).toMatch(new RegExp(`<ol class="gate-route" role="list" aria-label="${GATE_COPY.routeLabel}">`));
    expect(html.match(/<li class="gate-route__stop[^"]*">/g)).toHaveLength(2);
  });

  it('the current stop says aria-current="step", is marked "You are here" and is the only current one', () => {
    expect(html.match(/aria-current=/g)).toHaveLength(1);
    expect(html).toMatch(/<li class="gate-route__stop gate-route__stop--current"><span class="gate-route__mark" aria-hidden="true"><\/span><span class="gate-route__label" aria-current="step"><span class="gate-route__here">You are here<\/span> ?Accept the terms<\/span><\/li>/);
  });

  it('a done stop carries the visually hidden "(done)", and no tick: every mark is an empty span drawn by CSS, hidden', () => {
    expect(html).toMatch(/<li class="gate-route__stop gate-route__stop--done"><span class="gate-route__mark" aria-hidden="true"><\/span><span class="gate-route__label">Sign in <span class="visually-hidden">\(done\)<\/span><\/span><\/li>/);
    const list = /<ol [\s\S]*?<\/ol>/.exec(html)?.[0] ?? 'MISSING';
    expect(list).not.toMatch(/<svg|<progress|role="progressbar"|%|MISSING/);
    expect(html).not.toMatch(/<progress|role="progressbar"|%/);
  });

  it('below 1024 px the band says where the person is and, with more than one stop, which step of how many', () => {
    expect(html).toMatch(/<p class="gate__where">You are here: Accept the terms<\/p>/);
    expect(html).toMatch(/<p class="gate__count">Step 2 of 2<\/p>/);
    const one = signedIn([{ label: 'Change your password', state: 'current' }]);
    expect(one).toMatch(/You are here: Change your password/);
    expect(one).not.toMatch(/gate__count|Step 1 of 1/);
  });

  it('no route, no list and no position line', () => {
    expect(signedIn()).not.toMatch(/gate-route|gate__where|gate__count/);
    expect(signedIn([])).not.toMatch(/gate-route|gate__where|gate__count/);
  });

  it('a route with no current stop, or with two, is refused (exactly one "You are here")', () => {
    expect(() => signedIn([{ label: 'a', state: 'done' }])).toThrow(/exactly one current stop/);
    expect(() => signedIn([{ label: 'a', state: 'current' }, { label: 'b', state: 'current' }])).toThrow(/exactly one current stop/);
  });
});

describe('gate.css', () => {
  const css = readFileSync('components/layout/gate.css', 'utf8');
  const src = readFileSync('components/layout/GateFrame.tsx', 'utf8');

  it('GateFrame imports its own stylesheet; it is not a kit sheet', () => {
    expect(src).toMatch(/^import '\.\/gate\.css';$/m);
  });

  it('wide from 1024 px, the shell\'s breakpoint: the navy column at the rail\'s width beside the ground', () => {
    expect(css).toMatch(/@media \(min-width: 1024px\)/);
    expect(css).toMatch(/grid-template-columns: var\(--rail-width\) minmax\(0, 1fr\)/);
    expect(css).toMatch(/background-color: var\(--color-shell\)/);
    expect(css).toMatch(/background-color: var\(--color-ground\)/);
  });

  it('the card: surface, container border, surface radius, 30rem or 40rem wide, an h1 at the 30 px step', () => {
    expect(css).toMatch(/\.gate__card \{[^}]*background-color: var\(--color-surface\);[^}]*border: 1px solid var\(--color-border-container\);[^}]*border-radius: var\(--radius-surface\);/);
    expect(css).toMatch(/max-inline-size: 30rem/);
    expect(css).toMatch(/\.gate--wide \.gate__card \{[^}]*max-inline-size: 40rem/);
    expect(css).toMatch(/\.gate__card h1 \{[^}]*font-size: var\(--font-size-h1\);[^}]*color: var\(--color-heading\)/);
  });

  it('spec 7.1: no orange anywhere in the frame\'s sheet (never orange text on navy), and nothing animates', () => {
    expect(css).not.toMatch(/--color-action|--color-focus|#9A4D10|transition|animation/i);
  });

  it('spec 7.2: marks are borders, not backgrounds, so forced colours keep them; done 16 px filled, current 24 px with a 4 px ring', () => {
    const mark = /\.gate-route__mark \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(mark).toMatch(/inline-size: 16px/);
    expect(mark).toMatch(/border: 2px solid/);
    expect(mark).not.toMatch(/background/);
    expect(css).toMatch(/\.gate-route__stop--done \.gate-route__mark \{[^}]*border-width: 8px/);
    expect(css).toMatch(/\.gate-route__stop--current \.gate-route__mark \{[^}]*inline-size: 24px;[^}]*block-size: 24px;[^}]*border-width: 4px/);
  });
});

describe('Sign out from the frame (signOutClearingDrafts, as S-05\'s sign out)', () => {
  it('says it is working, then signs out to /login clearing this account\'s drafts, once however often it is pressed', async () => {
    const out = vi.fn(async () => {});
    const shown: string[] = [];
    const press = signOutFromGate(async () => ({ signOutClearingDrafts: out }), (p) => shown.push(p));
    await Promise.all([press('u1'), press('u1')]);
    expect(out.mock.calls).toEqual([['u1', '/login']]);
    expect(shown).toEqual(['working']);
  });

  it('T16-31: if the module cannot load or the sign-out request fails, the person is told they are still signed in, and nothing navigates', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const load of [
      async () => { throw new Error('chunk'); },
      async () => ({ signOutClearingDrafts: async () => { throw new TypeError('Failed to fetch'); } }),
    ]) {
      const shown: string[] = [];
      const press = signOutFromGate(load as never, (p) => shown.push(p));
      await press('u1');
      expect(shown).toEqual(['working', 'stillSignedIn']);
      await press('u1');   // pressable again after a failure
      expect(shown).toEqual(['working', 'stillSignedIn', 'working', 'stillSignedIn']);
    }
    // Only the kind of error is logged, never its message.
    for (const call of warn.mock.calls) expect(call.join(' ')).not.toMatch(/chunk|Failed to fetch/);
    warn.mockRestore();
  });

  it('the failure line is S-05\'s sentence, in an alert region that is in the page from the start', () => {
    expect(signOutFailure('stillSignedIn')).toBe(ACCEPTANCES_COPY.stillSignedIn);
    expect(signOutFailure('working')).toBeNull();
    expect(signedIn()).toMatch(/<div role="alert" class="ui-status ui-status--error"><\/div>/);
  });
});

describe('the (gate) layout\'s idle warning (UX-43)', () => {
  it('signed out, it renders the page only: no deadline read, no log line (the page\'s own gate sends the visitor to sign in)', async () => {
    const Layout = (await import('@/app/(gate)/layout')).default;
    soft.identity.mockResolvedValue(null);
    idle.read.mockClear();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(renderToStaticMarkup(await Layout({ children: <p>page</p> }))).toBe('<p>page</p>');
    expect(idle.read).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('signed in, it renders the warning from the session deadlines, and none with one fixed log line when they cannot be read', async () => {
    const Layout = (await import('@/app/(gate)/layout')).default;
    soft.identity.mockResolvedValue(identity.current);
    idle.read.mockResolvedValue({ secondsLeft: 3000, absoluteSecondsLeft: 500000 });
    expect(renderToStaticMarkup(await Layout({ children: <p>page</p> }))).toContain('data-seconds-left="3000"');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    idle.read.mockResolvedValue(null);
    const html = renderToStaticMarkup(await Layout({ children: <p>page</p> }));
    expect(html).not.toContain('data-seconds-left');
    expect(html).toContain('<p>page</p>');
    expect(error.mock.calls).toEqual([['idle_deadline_unreadable']]);
    error.mockRestore();
  });
});

describe('the gate pages pass a route of true stops', () => {
  type FrameProps = { variant: string; userName: string; userId: string; route?: readonly GateStop[]; wide?: boolean };
  /** The GateFrame element a page returns (each page renders the frame itself; the layout cannot know the page). */
  const frameOf = (el: unknown) => (el as ReactElement<FrameProps>).props;

  beforeEach(() => {
    vi.clearAllMocks();
    identity.current = { userId: 'u1', email: 'a@example.invalid', name: 'Amina Namusoke', platformRole: 'assessor', mustChangePassword: false };
  });

  it('/change-password: Change your password, then Sign in again (the change signs out everywhere), forced or not', async () => {
    const Page = (await import('@/app/(gate)/change-password/page')).default;
    for (const must of [true, false]) {
      identity.current = { ...identity.current, mustChangePassword: must };
      const p = frameOf(await Page());
      expect(p.variant).toBe('signed-in');
      expect(p.userId).toBe('u1');
      expect(p.userName).toBe('Amina Namusoke');
      expect(p.route).toEqual([{ label: 'Change your password', state: 'current' }, { label: 'Sign in again', state: 'upcoming' }]);
    }
  });

  it('/acceptances: Sign in done, Accept the terms current, in the wide card', async () => {
    data.missing.mockResolvedValue(['terms']);
    const Page = (await import('@/app/(gate)/acceptances/page')).default;
    const p = frameOf(await Page());
    expect(p.route).toEqual([{ label: 'Sign in', state: 'done' }, { label: 'Accept the terms', state: 'current' }]);
    expect(p.wide).toBe(true);
  });

  it('T1.5: / sends the MAK-AI administrator to /admin/organisations before reading any membership', async () => {
    identity.current = { ...identity.current, platformRole: 'admin' };
    const Page = (await import('@/app/(gate)/page')).default;
    await expect(Page()).rejects.toThrow('REDIRECT /admin/organisations');
    expect(data.memberships).not.toHaveBeenCalled();
    expect(data.findUser).not.toHaveBeenCalled();
  });

  it('/ with organisations to choose from: Choose an organisation current, Home upcoming, in the wide card', async () => {
    data.findUser.mockResolvedValue({ lastActiveOrgId: null });
    data.memberships.mockResolvedValue([
      { orgId: 'o1', org: { slug: 'alpha', name: 'Alpha Lab' } },
      { orgId: 'o2', org: { slug: 'beta', name: 'Beta Lab' } },
    ]);
    const Page = (await import('@/app/(gate)/page')).default;
    const p = frameOf(await Page());
    expect(p.route).toEqual([{ label: 'Choose an organisation', state: 'current' }, { label: 'Home', state: 'upcoming' }]);
    expect(p.wide).toBe(true);
  });

  it('/ with no organisation: the empty state, and no route (no step is certain)', async () => {
    data.findUser.mockResolvedValue({ lastActiveOrgId: null });
    data.memberships.mockResolvedValue([]);
    const Page = (await import('@/app/(gate)/page')).default;
    expect(frameOf(await Page()).route).toBeUndefined();
  });
});
