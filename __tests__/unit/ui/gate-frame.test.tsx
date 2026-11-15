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
// Since plan 1B Task 7 S-05 reads acceptanceChanges: built here from `missing` (each kind missing, first acceptance).
vi.mock('@/lib/data/acceptances', () => ({
  missingAcceptances: data.missing, offeredAcceptances: data.offered,
  acceptanceChanges: async () => ((await data.missing()) as string[]).map((kind) => ({
    kind, current: { kind, version: '1', publishedOn: '2026-10-30', acceptance: 'required', sha256: 'x', text: 'words' }, lastAccepted: null, state: 'missing',
  })),
}));
const idle = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/lib/auth/idleDeadline', () => ({ readSessionDeadlines: idle.read }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));

import { GateFrame, type GateStop } from '@/components/layout/GateFrame';
import { DraftsWarning } from '@/components/layout/GateSignOut';
import { countAccountDrafts } from '@/lib/client/draftKeys';
import { DRAFTS_COPY } from '@/lib/decision/drafts/copy';
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
/** React 19 hoists a preload for the logo's srcSet ahead of a static render; in a page it goes to <head>. Stripped here so the
 *  frame's own markup is what the cases read; LOGO_PRELOAD pins that it is the logo's and nothing else. */
const LOGO_PRELOAD = '<link rel="preload" as="image" imageSrcSet="/logo-makai-white-154.webp 1x, /logo-makai-white-308.webp 2x"/>';
const frameOnly = (html: string) => (html.startsWith(LOGO_PRELOAD) ? html.slice(LOGO_PRELOAD.length) : html);
const signedIn = (route?: readonly GateStop[], wide?: boolean) =>
  frameOnly(renderToStaticMarkup(<GateFrame variant="signed-in" userName="Amina" userId="u1" accountReachable route={route} wide={wide}><h1>Title</h1></GateFrame>));
const publicFrame = (route?: readonly GateStop[]) => frameOnly(renderToStaticMarkup(<GateFrame variant="public" route={route}><h1>Title</h1></GateFrame>));

describe('GateFrame, signed in', () => {
  it('I-3: the only element React hoists out of the frame is the logo\'s own preload', () => {
    const html = renderToStaticMarkup(<GateFrame variant="public"><h1>Title</h1></GateFrame>);
    expect(html.startsWith(LOGO_PRELOAD)).toBe(true);
    expect(frameOnly(html)).toMatch(/^<div class="gate gate--public">/);
  });

  it('M-9: an account with no name gets no empty paragraph in the column', () => {
    expect(renderToStaticMarkup(<GateFrame variant="signed-in" userName="" userId="u1" accountReachable>x</GateFrame>)).not.toContain('gate__name');
  });

  it('T1.3: GateFrame links only to /help and signs out', () => {
    expect(hrefs(renderToStaticMarkup(<GateFrame variant="signed-in" userName="Amina" userId="u1" accountReachable>x</GateFrame>))).toEqual(['/help']);
    expect(hrefs(renderToStaticMarkup(<GateFrame variant="signed-in" userName="Amina" userId="u1" accountReachable={false}>x</GateFrame>))).toEqual(['/help']);
  });

  it('the product name is text, not a link; the person\'s name, Help and Sign out are in the column', () => {
    const html = signedIn();
    expect(html).toMatch(/<p class="gate__product">MAK-AI RAI Platform<\/p>/);
    // I-3 (owner's ruling, 15 Nov): the MAK-AI logo (lane 3's white WebP) above the name, decorative (alt=""), not a link.
    expect(html).toMatch(/<div class="gate__brand"><img src="\/logo-makai-white-154\.webp" srcSet="\/logo-makai-white-154\.webp 1x, \/logo-makai-white-308\.webp 2x" width="154" height="36" alt="" decoding="async" class="gate__logo"\/><p class="gate__product">/);
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
  const css = readFileSync('components/layout/gate.css', 'utf8');
  it('renders no header, no main, no Help, no Sign out and no link at all: the public layout has those', () => {
    const html = publicFrame(ROUTE);
    expect(html).not.toMatch(/<header|<main|<form|<a /);
    expect(hrefs(html)).toEqual([]);
    // Ruling L5-26 (design review I-2): the light header names the platform, so the public column shows the logo alone.
    expect(html).toMatch(/^<div class="gate gate--public"><div class="gate__header"><div class="gate__column"><div class="gate__brand"><img src="\/logo-makai-white-154\.webp" srcSet="\/logo-makai-white-154\.webp 1x, \/logo-makai-white-308\.webp 2x" width="154" height="36" alt="" decoding="async" class="gate__logo"\/><\/div>/);
    expect(html).not.toContain('gate__product');
    expect(html).toContain('<div class="gate__main"><div class="gate__card"><h1>Title</h1></div></div>');
  });

  it('L5-26: the platform is named once per viewport: below 1024 px the public band shows no logo, only where the person is', () => {
    expect(css).toMatch(/@media \(max-width: 1023\.98px\) \{\s*\.gate--public \.gate__brand \{\s*display: none;/);
  });

  it('a page whose route changes in the browser passes its own route element in place of the list (D16, a used reset link)', () => {
    const html = frameOnly(renderToStaticMarkup(<GateFrame variant="public" routeSlot={<p id="slot">S</p>}><h1>T</h1></GateFrame>));
    expect(html).toContain('<p id="slot">S</p>');
    expect(html).not.toContain('gate-route');
  });

  it('M-2: on a public page the frame fills what the light header leaves, not a whole viewport under it', () => {
    expect(css).toMatch(/body:has\(\.gate--public\) \{[^}]*display: flex;[^}]*flex-direction: column;[^}]*min-block-size: 100dvh;/);
    expect(css).toMatch(/\.public-layout:has\(> \.gate--public\) \{[^}]*flex: 1 0 auto;[^}]*min-block-size: 0;/);
    expect(css).toMatch(/\.gate--public \{[^}]*min-block-size: 0;/);
  });

  it('CR-1: the logo keeps its proportions when the column is narrower than it', () => {
    expect(css).toMatch(/\.gate__logo \{[^}]*max-inline-size: 100%;[^}]*block-size: auto;/);
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

  it('I-1 (ruling L5-21): below 1024 px the band says where the person is and the next stop the route lists, never a count', () => {
    // No page knows how many gates a person still has to pass (gate 2 runs before gate 3), so no total is printed.
    expect(html).toMatch(/<p class="gate__where">You are here: Accept the terms<\/p>/);
    expect(html).not.toMatch(/gate__next|Next:/);   // this route lists no upcoming stop
    expect(html).not.toMatch(/Step \d|of \d|gate__count/);
    const two = signedIn([{ label: 'Change your password', state: 'current' }, { label: 'Sign in again', state: 'upcoming' }]);
    expect(two).toMatch(/<p class="gate__where">You are here: Change your password<\/p><p class="gate__next">Next: Sign in again<\/p>/);
    expect(two).not.toMatch(/Step \d/);
  });

  it('no route, no list and no position line', () => {
    expect(signedIn()).not.toMatch(/gate-route|gate__where|gate__next/);
    expect(signedIn([])).not.toMatch(/gate-route|gate__where|gate__next/);
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

  it('I-4: the card\'s heading steps down the ramp as the card narrows (22 px, then 18 px) and wraps by whole words only', () => {
    expect(css).toMatch(/\.gate__card \{[^}]*container-type: inline-size;/);
    expect(css).toMatch(/@container \(width < 24rem\) \{\s*\.gate__card h1 \{\s*font-size: var\(--font-size-h2\);/);
    expect(css).toMatch(/@container \(width < 12rem\) \{\s*\.gate__card h1 \{\s*font-size: var\(--font-size-h3\);/);
    expect(css).toMatch(/\.gate__card h1 \{[^}]*overflow-wrap: normal;/);
  });

  it('I-3: the platform\'s name is the column\'s title, white at the 16 px step; the logo sits above it as a block', () => {
    expect(css).toMatch(/\.gate__product \{[^}]*color: var\(--color-shell-ink\);[^}]*font-size: var\(--font-size-body\);[^}]*font-weight: var\(--font-weight-semibold\);/);
    expect(css).not.toMatch(/\.gate__product \{[^}]*--color-shell-muted/);
    expect(css).toMatch(/\.gate__logo \{\s*display: block;/);
  });

  it('I-5 M-2: the column (wide) and the band (narrow) have a 1 px edge in an existing border role, which forced colours keep', () => {
    expect(css).toMatch(/\.gate__header \{[^}]*border-block-end: 1px solid var\(--color-border-container\);/);
    expect(css).toMatch(/@media \(min-width: 1024px\) \{[\s\S]*\.gate__header \{\s*border-block-end: 0;\s*border-inline-end: 1px solid var\(--color-border-container\);/);
    expect(css).not.toMatch(/--color-shell\s*:/);   // no token is redefined here
  });

  it('M-1 M-3: the person block\'s divider is a control-border line; the frame fills the viewport at every width', () => {
    expect(css).toMatch(/border-block-start: 1px solid var\(--color-border-control\);/);
    expect(css).toMatch(/^\.gate \{[^}]*min-block-size: 100vh;/m);
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

describe('Sign out from the frame: S-05\'s press, after M-41 when this device holds this account\'s drafts', () => {
  it('B-1: the press is the one shared module (lib/client/signOutPress.ts), to /login; the frame keeps no press of its own', () => {
    // Code only: the module's comments explain the sign-out it uses.
    const src = readFileSync('components/layout/GateSignOut.tsx', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(src).toMatch(/from '@\/lib\/client\/signOutPress'/);
    expect(src).toMatch(/useSignOutPress\(userId, '\/login'\)/);
    expect(src).not.toMatch(/\bcatch\b|signOutClearingDrafts|next-auth/);
    expect(readFileSync('components/legal/AcceptancesForm.tsx', 'utf8')).toMatch(/from '@\/lib\/client\/signOutPress'/);
    expect(readFileSync('components/legal/AcceptancesForm.tsx', 'utf8')).not.toMatch(/export function signOutPress/);
  });

  it('A-1: the drafts of this account are counted by their keys alone, without the draft store, and another account\'s are not', () => {
    const keys = ['makrai.draft.v1:u1:o:p:q:Q-1', 'makrai.draft.v1:u1:o:p:m:f:new', 'makrai.draft.v1:u10:o:p:q:Q-1', 'makrai.draft.v1:u2:o:p:q:Q-1', 'theme'];
    vi.stubGlobal('localStorage', { length: keys.length, key: (i: number) => keys[i] ?? null });
    expect(countAccountDrafts('u1')).toBe(2);
    expect(countAccountDrafts('u2')).toBe(1);
    expect(countAccountDrafts('')).toBe(0);
    expect(readFileSync('lib/client/draftKeys.ts', 'utf8')).not.toMatch(/from '@\/lib\/client\/drafts'|next-auth/);
    vi.unstubAllGlobals();
  });

  it('A-1: storage that refuses to be read counts as no draft (there is nothing this code could have kept there either)', () => {
    vi.stubGlobal('localStorage', { get length(): number { throw new DOMException('denied', 'SecurityError'); }, key: () => null });
    expect(countAccountDrafts('u1')).toBe(0);
    vi.unstubAllGlobals();
  });

  it('A-1: M-41 in its own words, with Delete them and sign out and Cancel, and Go to them only when My account is reachable', () => {
    const view = (accountReachable: boolean) => renderToStaticMarkup(
      <DraftsWarning count={2} accountReachable={accountReachable} busy={false} onDelete={() => {}} onCancel={() => {}} />);
    const open = view(true);
    expect(open).toMatch(/role="alertdialog"/);
    expect(open).toContain(DRAFTS_COPY.signOut.warning(2));
    expect(open).toMatch(/<a class="ui-button ui-button--secondary" href="\/account#drafts-on-this-device">Go to them<\/a>/);
    expect(textOf(open)).toContain(DRAFTS_COPY.signOut.deleteAndSignOut);
    expect(textOf(open)).toContain(DRAFTS_COPY.signOut.cancel);
    // A flagged account: gate 2 would send My account straight back to S-29, so the choice is not offered.
    const flagged = view(false);
    expect(hrefs(flagged)).toEqual([]);
    expect(textOf(flagged)).not.toContain(DRAFTS_COPY.signOut.goToThem);
    expect(textOf(flagged)).toContain(DRAFTS_COPY.signOut.deleteAndSignOut);
  });

  it('the failure line of a press is in the page from the start, empty', () => {
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
  type FrameProps = { variant: string; userName: string; userId: string; accountReachable: boolean; route?: readonly GateStop[]; wide?: boolean };
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
      // Gate 2 holds a flagged account on S-29, so M-41's Go to them (My account) is not offered to it.
      expect(p.accountReachable).toBe(!must);
    }
  });

  it('/acceptances: Sign in done, Accept the terms current, in the wide card', async () => {
    data.missing.mockResolvedValue(['terms']);
    const Page = (await import('@/app/(gate)/acceptances/page')).default;
    const p = frameOf(await Page());
    expect(p.route).toEqual([{ label: 'Sign in', state: 'done' }, { label: 'Accept the terms', state: 'current' }]);
    expect(p.wide).toBe(true);
    expect(p.accountReachable).toBe(true);   // gate 3 lets My account through (ACCEPTANCE_EXEMPT_PATHS)
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
      { orgId: 'o1', role: 'owner', org: { slug: 'alpha', name: 'Alpha Lab' } },
      { orgId: 'o2', role: 'viewer', org: { slug: 'beta', name: 'Beta Lab' } },
    ]);
    const Page = (await import('@/app/(gate)/page')).default;
    const p = frameOf(await Page());
    expect(p.route).toEqual([{ label: 'Choose an organisation', state: 'current' }, { label: 'Home', state: 'upcoming' }]);
    expect(p.wide).toBe(true);
    expect(p.accountReachable).toBe(true);
    // T1.4: the chooser reads only this person's own memberships and last organisation, by their own id (orgRoleLabel, which
    // words each plate's role since plan 1B Task 8, reads the same memberships by the same id).
    expect(data.memberships.mock.calls.length).toBeGreaterThan(0);
    for (const call of data.memberships.mock.calls) expect(call).toEqual(['u1']);
    expect(data.findUser.mock.calls).toEqual([[{ where: { id: 'u1' }, select: { lastActiveOrgId: true } }]]);
  });

  it('/ with no organisation: the empty state, and no route (no step is certain)', async () => {
    data.findUser.mockResolvedValue({ lastActiveOrgId: null });
    data.memberships.mockResolvedValue([]);
    const Page = (await import('@/app/(gate)/page')).default;
    expect(frameOf(await Page()).route).toBeUndefined();
  });
});
