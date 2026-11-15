import { TERM_PRODUCT } from '@/lib/vocabulary/terms';
import { HOME_UNSAVED_COPY } from '@/lib/home/unsaved/copy';

/**
 * The words of Home (spec 9.1; plan 1B Task 10's HOME_COPY, verbatim where the plan gives them). Server only: no file
 * with 'use client' imports it (ruling X-2); the unsaved-changes line's words are in lib/home/unsaved/copy.ts for that
 * reason. The follow-up words Home shares with the project page (Overdue, the due lines, the erased text, "Assigned to")
 * are the project page's, in lib/project/copy.ts. Sentences the plan does not give are marked "new" and listed in the
 * task report for the owner.
 */
export const HOME_COPY = Object.freeze({
  titles: Object.freeze({ home: 'Home' }),
  /** 9.1 (1). The page's one h1, except after joining, when the welcome line is (`lib/org/copy.ts` welcomeLine). */
  welcomeBack: (name: string) => `Welcome back, ${name}.`,
  /** New (design review #12): the first visit's h1; "back" is not true on a person's first sight of an empty organisation. */
  welcomeFirst: (name: string) => `Welcome, ${name}.`,
  /** New (the sketch's lead, with spec 9.1's "since your last saved change"): shown only when all three parts are on the page. */
  recorderLead: "Here is your next step, what others have done since your last saved change, and where your team's project stands.",
  nextStepHeading: 'Your next step',
  reasonNextOpen: (stage: string, day: string) => `You last saved in ${stage} on ${day}. This is the next question there with no decision.`,
  reasonLastSaved: (day: string) => `You last saved here on ${day}.`,
  reasonFirstOpen: 'You have not saved a decision in this organisation yet. This is the first question with no decision.',
  continueRecording: 'Continue recording',
  chooseAnother: 'Choose another question',
  otherProjects: (n: number) => (n === 1 ? 'You have 1 other project.' : `You have ${n} other projects.`),
  allProjects: 'All projects',
  /** 9.1 (3); audit B row 36. */
  assignedHeading: 'Assigned to you',
  assignedNone: 'No mitigations are assigned to you.',
  /** 9.1 (4). */
  sinceHeading: (day: string) => `Since your last saved change (${day})`,
  sinceDecisions: (who: string, n: number, stage: string) => (n === 1 ? `${who} saved 1 decision in ${stage}.` : `${who} saved ${n} decisions in ${stage}.`),
  /** The plan's singular; the plural is new (a group counts every finding that person raised in that stage that day). */
  sinceFindings: (who: string, n: number, stage: string) => (n === 1 ? `${who} raised a finding in ${stage}.` : `${who} raised ${n} findings in ${stage}.`),
  /** The plan's singular; the plural is new. */
  sinceSeals: (who: string, n: number, stage: string) => (n === 1 ? `${who} sealed a review of ${stage}.` : `${who} sealed ${n} reviews of ${stage}.`),
  sinceNone: 'Nobody else has saved anything since then.',
  sinceMore: 'Showing the 10 most recent changes.',
  /** A person who left: the vocabulary's "former member", as the question page writes it. */
  formerMember: (name: string) => `${name} (former member)`,
  /** Audit B row on S-10. Each stage name is followed by its Definition (TERM_STAGE_1..3), review M9. */
  stagesLead: 'You can work on the stages in any order.',
  /** New: the stage plate's last line, "Next: …" (the sketch's "Next stop", in the spec's words). */
  next: 'Next:',
  /** New: the stage that holds the person's next step names it by its place, as the next-step card does. */
  nextHere: (position: string) => `${position}, your next step`,
  /** New: any other stage with an open question. */
  nextFirstOf: (n: number) => (n === 1 ? 'the one question with no decision' : `the first of ${n} questions with no decision`),
  /** New: after the red word "Overdue" (spec 7.1: red only on the word), the count in ink. */
  overdueCount: (n: number) => (n === 1 ? ': 1 mitigation' : `: ${n} mitigations`),
  leadOverdueHeading: 'Overdue mitigations',
  leadNoMitigationHeading: 'Findings with no mitigation yet',
  /** New (fix round 2, design review #7): a lead row's owner, in ink; the reader's own item says "you". */
  assignedToName: (name: string) => `Assigned to ${name}`,
  assignedToReader: 'Assigned to you',
  /** New (lane lead, fix round 1): each lead list shows its first rows, then this link to the whole list. */
  leadOverdueAll: (n: number) => (n === 1 ? 'See the overdue mitigation' : 'See all overdue mitigations'),
  leadNoMitigationAll: (n: number) => (n === 1 ? 'See the finding with no mitigation yet' : 'See all findings with no mitigation yet'),
  reviewerUnsealed: 'Reviews not sealed yet',
  reviewerChanged: 'Sealed reviews with changes since',
  reviewerRaised: 'Findings you raised',
  /** New: each Reviewer list says so when it is empty, so the three headings always stand. */
  reviewerUnsealedNone: 'No review is waiting to be sealed.',
  reviewerChangedNone: 'No sealed review has changed since its seal.',
  reviewerRaisedNone: 'No finding you raised is still open.',
  viewerRecent: 'Recorded in the last 14 days',
  /** New. */
  viewerRecentNone: 'Nobody has saved anything in the last 14 days.',
  viewerOpen: 'Still open',
  /** "A place where your team records its decisions about one AI system, and why." */
  firstTimeLead: TERM_PRODUCT.definition,
  firstTimeCreate: 'Create a project',
  /** 9.1 verbatim. */
  firstTimeAsk: 'Ask an Owner, Admin or Assessor to create your project.',
  /** Archived projects only (B#31): the All projects link follows it. The page is headed "Projects" (lane lead, fix round 1). */
  noActiveProjects: 'No active projects. Your archived projects are on the Projects page.',
  unsaved: HOME_UNSAVED_COPY.unsaved,
});
