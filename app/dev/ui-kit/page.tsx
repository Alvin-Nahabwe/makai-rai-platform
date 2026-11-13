import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import type { ReactElement, ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import { ICONS } from '@/components/ui/icons';
import { LocalTime } from '@/components/ui/LocalTime';
import { RouteRow, type RouteRowStop } from '@/components/ui/RouteRow';
import { SavedMark } from '@/components/ui/SavedMark';
import { StatusMark } from '@/components/ui/StatusMark';
import type { IconName, StatusMarkKind } from '@/components/ui/types';
import { tallyOf } from '@/lib/ui/marks';
import { devGalleryShown } from '@/lib/ui/devGallery';
import { MAIN_CONTENT_ID } from '@/components/layout/SkipLink';
import { PRODUCT_NAME } from '@/lib/ui/title';
import { SavedDemo } from './SavedDemo';

/**
 * The development gallery (plan 1A Task 3): every components/ui component in every state, for the browser spec
 * e2e/ui-kit.spec.ts and for looking at. It is not user-facing and answers 404 in production (lib/ui/devGallery.ts).
 * Each component has one section below; a later task adds its component as one more section. The sample text here is
 * gallery text, not interface words, so it is written inline.
 */

export const metadata: Metadata = { title: `UI kit · Development · ${PRODUCT_NAME}`, robots: { index: false } };

const KINDS: readonly StatusMarkKind[] = ['done', 'partly', 'not_yet', 'not_applicable', 'does_not_apply', 'scope_answered', 'no_decision'];
const SIZES = [16, 20, 24] as const;

/** 22 questions, the length of the longest stage, with the fourth current. */
const ROUTE: readonly RouteRowStop[] = Array.from({ length: 22 }, (_, i) => {
  const kind: StatusMarkKind = i === 0 ? 'scope_answered' : (['done', 'done', 'partly', 'not_yet', 'not_applicable', 'does_not_apply', 'no_decision'] as const)[i % 7];
  return { id: `q${i + 1}`, kind, title: `Sample question ${i + 1}`, href: `#q${i + 1}`, current: i === 3, scopeAnswer: i === 0 ? 'yes' : undefined };
});

function KitSection({ id, title, children }: { id: string; title: string; children: ReactNode }): ReactElement {
  return (
    <section id={id} aria-labelledby={`${id}-title`} data-kit-section={id}>
      <h2 id={`${id}-title`}>{title}</h2>
      {children}
    </section>
  );
}

function StateTable({ caption, rows }: { caption: string; rows: ReadonlyArray<readonly [string, ReactNode]> }): ReactElement {
  return (
    <table>
      <caption>{caption}</caption>
      <thead><tr><th scope="col">State</th><th scope="col">Rendered</th></tr></thead>
      <tbody>{rows.map(([state, node]) => <tr key={state}><th scope="row">{state}</th><td>{node}</td></tr>)}</tbody>
    </table>
  );
}

export default async function UiKitPage(): Promise<ReactElement> {
  await connection(); // the environment is read per request: CI builds first and sets the test seam only on the server
  // notFound() answers status 404 only before streaming starts; once a loading.tsx or <Suspense> above this page has
  // streamed, the status stays 200 with the not-found UI (node_modules/next/dist/docs/01-app/03-api-reference/
  // 03-file-conventions/not-found.md:15 and :45). Keep both out of app/dev/ while the 404 is the production guard.
  if (!devGalleryShown(process.env)) notFound();
  const iconNames = Object.keys(ICONS) as IconName[];
  return (
    <main id={MAIN_CONTENT_ID} className="container">
      <h1>UI kit</h1>
      <p>Every interface component in every state. Development only: this page is not served in production.</p>

      <KitSection id="icons" title="Icons">
        <StateTable caption="Each icon at 20 px beside its name" rows={iconNames.map((name) => [name, <span key={name} data-icon={name}><Icon name={name} /> {name}</span>])} />
        <StateTable caption="Sizes" rows={([16, 18, 20, 24] as const).map((size) => [`${size} px`, <span key={size}><Icon name="info" size={size} /> Information</span>])} />
      </KitSection>

      <KitSection id="status-marks" title="Status marks">
        {SIZES.map((size) => (
          <StateTable key={size} caption={`Every kind at ${size} px`} rows={KINDS.map((kind) => [kind, <StatusMark key={kind} kind={kind} size={size} scopeAnswer="yes" />])} />
        ))}
        <StateTable caption="Words and answers" rows={[
          ['done, no evidence', <StatusMark key="ne" kind="done" noEvidence />],
          ['answer: no', <StatusMark key="no" kind="scope_answered" scopeAnswer="no" />],
          ['answer: not sure', <StatusMark key="ns" kind="scope_answered" scopeAnswer="not_sure" />],
          ['answer not given', <StatusMark key="na" kind="scope_answered" />],
          ['words hidden', <StatusMark key="wh" kind="partly" words="hidden" />],
        ]} />
      </KitSection>

      <KitSection id="route-row" title="Route row">
        <RouteRow label="Sample stage" stops={ROUTE} tally={tallyOf(ROUTE.map((s) => s.kind), 2)} />
        <h3>Without addresses, none current</h3>
        <RouteRow label="Sample stage, read only" stops={ROUTE.slice(0, 5).map(({ href: _href, current: _current, ...stop }) => stop)} tally={tallyOf(ROUTE.slice(0, 5).map((s) => s.kind), 0)} />
        <h3>Nothing recorded</h3>
        <RouteRow label="Sample empty stage" stops={[]} tally={{}} />
      </KitSection>

      <KitSection id="saved-mark" title="Saved mark">
        <SavedDemo />
        <StateTable caption="States" rows={[
          ['empty', <SavedMark key="e" saved={null} live={false} />],
          ['version 1, no decided date', <SavedMark key="1" saved={{ version: 1, savedAt: '2026-11-11T08:23:00.000Z', decidedOn: null }} live={false} />],
          ['version 2, with history', <SavedMark key="2" saved={{ version: 2, savedAt: '2026-11-11T08:23:00.000Z', decidedOn: '2026-02-11' }} historyHref="#saved-mark" live={false} />],
          ['version 3, month precision, no history link', <SavedMark key="3" saved={{ version: 3, savedAt: '2026-11-11T08:23:00.000Z', decidedOn: '2026-02' }} live={false} />],
        ]} />
      </KitSection>

      <KitSection id="local-time" title="Local time">
        <StateTable caption="Server render says UTC; the reader's zone replaces it after hydration" rows={[
          ['day and time', <LocalTime key="t" at="2026-11-11T08:23:00.000Z" />],
          ['day only', <LocalTime key="d" at="2026-11-11T08:23:00.000Z" dateOnly />],
        ]} />
      </KitSection>
    </main>
  );
}
