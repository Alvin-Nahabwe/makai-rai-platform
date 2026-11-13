import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import type { ReactElement, ReactNode } from 'react';
import { Banner } from '@/components/ui/Banner';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Checkbox, CheckboxGroup } from '@/components/ui/Checkbox';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { ICONS } from '@/components/ui/icons';
import { LocalTime } from '@/components/ui/LocalTime';
import { RadioCards } from '@/components/ui/RadioCards';
import { RouteRow, type RouteRowStop } from '@/components/ui/RouteRow';
import { SavedMark } from '@/components/ui/SavedMark';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { StatusMark } from '@/components/ui/StatusMark';
import { StatusRegion } from '@/components/ui/StatusRegion';
import { TextInput } from '@/components/ui/TextInput';
import type { IconName, StatusMarkKind } from '@/components/ui/types';
import { tallyOf } from '@/lib/ui/marks';
import { devGalleryShown } from '@/lib/ui/devGallery';
import { MAIN_CONTENT_ID } from '@/components/layout/SkipLink';
import { PRODUCT_NAME } from '@/lib/ui/title';
import { BusySubmitDemo, DateStates, DecidedOnDemo, ErrorSummaryDemo, InPlaceDemo, ReasonDemo, StatusDemo, TextAreaStates } from './FormDemos';
import { DialogDemo, InlineConfirmDemo, StatusRegionDemo } from './FeedbackDemos';
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

const VARIANTS = ['primary', 'secondary', 'quiet', 'destructive'] as const;
const PEOPLE = [{ value: 'u1', label: 'Amina Namusoke' }, { value: 'u2', label: 'Joseph Okello' }];
const ROLES = [{ value: 'role:dpo', label: 'Data protection officer' }, { value: 'role:ethics', label: 'Ethics committee' }];

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
  // 03-file-conventions/not-found.md:15 and :45). While the 404 is the production guard, keep every one of them out of
  // the path above this page: no loading.tsx in app/dev/ui-kit/ or app/dev/, no root app/loading.tsx, and no <Suspense>
  // around {children} in app/layout.tsx (none of them exists today).
  if (!devGalleryShown(process.env)) notFound();
  const iconNames = Object.keys(ICONS) as IconName[];
  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="container">
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

      <KitSection id="buttons" title="Buttons">
        <p>Hover, focus and pressed are each button&rsquo;s own browser states; busy and disabled are shown below.</p>
        {VARIANTS.map((variant) => (
          <StateTable key={variant} caption={`The ${variant} button`} rows={[
            ['default', <Button key="d" variant={variant}>Save decision</Button>],
            ['compact', <Button key="c" variant={variant} size="compact">Save decision</Button>],
            ['icon at the start', <Button key="s" variant={variant} icon="paperclip">Add evidence</Button>],
            ['icon at the end', <Button key="e" variant={variant} icon="chevron-right" iconPosition="end">Next question</Button>],
            ['busy', <Button key="b" variant={variant} busy>Saving</Button>],
            ['disabled', <Button key="x" variant={variant} disabled>Save decision</Button>],
          ]} />
        ))}
        <StateTable caption="A link drawn as a button" rows={[
          ['secondary', <ButtonLink key="s" variant="secondary" href="#buttons">Back to the buttons</ButtonLink>],
          ['quiet, icon', <ButtonLink key="q" variant="quiet" href="#text-input" icon="arrow-up">Text box</ButtonLink>],
        ]} />
        <BusySubmitDemo />
      </KitSection>

      <KitSection id="text-input" title="Text box">
        <TextInput id="kit-name" name="kit-name" label="Project name" hint="The name your team uses for it." />
        <TextInput id="kit-email" name="kit-email" type="email" label="Email address" required autoComplete="email" spellCheck={false} width="medium" />
        <TextInput id="kit-code" name="kit-code" label="Short code" width="short" />
        <TextInput id="kit-error" name="kit-error" label="Organisation name" hint="As it appears on your letterhead." error="Enter the organisation's name." required />
        <TextInput id="kit-readonly" name="kit-readonly" label="Sign-in email" defaultValue="amina@example.org" readOnly />
        <TextInput id="kit-disabled" name="kit-disabled" label="Project name, while saving" defaultValue="Maternal health triage" disabled />
        <TextInput id="kit-password" name="kit-password" type="password" label="Password" autoComplete="new-password" hint="At least 12 characters." />
      </KitSection>

      <KitSection id="text-area" title="Text area">
        <ReasonDemo />
        <TextAreaStates />
      </KitSection>

      <KitSection id="select" title="Select">
        <Select id="kit-decided-by" name="kit-decided-by" label="Decided by" required placeholder="Choose a person or a role" defaultValue=""
          groups={[{ label: 'Members of this team', options: PEOPLE }, { label: 'A role outside the team', options: ROLES }]} />
        <Select id="kit-select-plain" name="kit-select-plain" label="Assigned to" hint="Only members can be assigned." options={PEOPLE} defaultValue="u2" />
        <Select id="kit-select-error" name="kit-select-error" label="Decided by, with an error" placeholder="Choose a person or a role" defaultValue=""
          options={PEOPLE} error="Choose who decided." />
        <Select id="kit-select-disabled" name="kit-select-disabled" label="Decided by, while saving" options={PEOPLE} defaultValue="u1" disabled />
      </KitSection>

      <KitSection id="radio-cards" title="Radio cards">
        <StatusDemo />
        <RadioCards name="kit-scope" legend="Does the data hold personal information?" legendHint="Answer for the data this project uses." columns={2}
          options={[{ value: 'yes', label: 'Yes', help: 'It contains sensitive or personal information.' }, { value: 'no', label: 'No', help: 'It does not.' }, { value: 'not_sure', label: 'Not sure' }]} />
        <RadioCards name="kit-status-error" legend="Status, with an error" error="Choose a status." required
          options={[{ value: 'done', label: 'Done', mark: 'done' }, { value: 'partly', label: 'Partly', mark: 'partly' }]} />
        <RadioCards name="kit-status-disabled" legend="Status, while saving" disabled defaultValue="partly"
          options={[{ value: 'done', label: 'Done', mark: 'done' }, { value: 'partly', label: 'Partly', mark: 'partly' }]} />
      </KitSection>

      <KitSection id="checkbox" title="Checkbox">
        <Checkbox id="kit-agree" name="kit-agree" label="Send me an email when a finding is assigned to me" hint="You can change this on My account." />
        <Checkbox id="kit-agree-checked" name="kit-agree-checked" label="Keep me signed in on this device" defaultChecked />
        <Checkbox id="kit-agree-error" name="kit-agree-error" label="I have read the consent to storage abroad" error="Tick this to go on." />
        <InPlaceDemo />
        <CheckboxGroup name="kit-in-place-disabled" legend="Which of these are in place? While saving" disabled defaultValues={['policy']}
          options={[{ value: 'policy', label: 'A written policy' }, { value: 'owner', label: 'A named owner' }]} />
      </KitSection>

      <KitSection id="date-field" title="Date">
        <DecidedOnDemo />
        <DateStates />
      </KitSection>

      <KitSection id="error-summary" title="Error summary">
        <ErrorSummaryDemo />
        <p>With no errors the summary renders nothing.</p>
      </KitSection>

      <KitSection id="callout" title="Callout">
        <Callout kind="note" title="Before you start">Read the guidance for this stage. It takes about ten minutes.</Callout>
        <Callout kind="note">A note without a title.</Callout>
        <Callout kind="caution" title="This cannot be undone">Once sealed, the stage review cannot be changed. A new version starts a new review.</Callout>
        <Callout kind="caution">A caution without a title.</Callout>
      </KitSection>

      <KitSection id="status-region" title="Status region">
        <StatusRegionDemo />
        <StateTable caption="States" rows={[
          ['empty, polite', <StatusRegion key="e" message={null} />],
          ['message', <StatusRegion key="m" message="Sample decision saved as version 2." />],
          ['error', <StatusRegion key="x" message="The sample answer was not saved. Your words are kept on this device." tone="error" />],
        ]} />
      </KitSection>

      <KitSection id="banner" title="Banner">
        <Banner kind="offline">You are offline. This is a sample banner.</Banner>
        <Banner kind="archived" title="This sample project is archived">Nothing in it can be changed. Owners and admins can unarchive it from All projects.</Banner>
        <Banner kind="session" title="You were signed out" action={<ButtonLink variant="secondary" href="#banner">Sign in again</ButtonLink>}>Your answer on this page is kept.</Banner>
        <Banner kind="info" action={<Link href="#banner">Read the sample guidance</Link>}>A sample notice with a link as its action.</Banner>
      </KitSection>

      <KitSection id="skeleton" title="Skeleton">
        <StateTable caption="Variants, static: nothing moves" rows={[
          ['text', <Skeleton key="t" label="Loading the sample text" />],
          ['plate', <Skeleton key="p" label="Loading the sample question" variant="plate" lines={2} />],
          ['table', <Skeleton key="b" label="Loading the sample table" variant="table" lines={4} />],
        ]} />
      </KitSection>

      <KitSection id="empty-state" title="Empty state">
        <EmptyState title="No findings yet" action={<ButtonLink variant="secondary" href="#empty-state">Open the sample stage</ButtonLink>}>
          Findings appear here when the team records a decision of Partly or Not yet.
        </EmptyState>
        <EmptyState title="No members invited">Invited people appear here until they accept.</EmptyState>
      </KitSection>

      <KitSection id="inline-confirm" title="Inline confirmation">
        <InlineConfirmDemo />
      </KitSection>

      <KitSection id="dialog" title="Dialog">
        <DialogDemo />
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
