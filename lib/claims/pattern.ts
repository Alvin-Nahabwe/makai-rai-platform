/**
 * The words that never appear (FR-PUB-01; SRS 7.5.3, line 2472). A plain module that registers no tests, so a
 * vitest file, a Playwright spec and any later unit can import the one pattern: `__tests__/lint/no-product-claims.test.ts`
 * (source and content), `e2e/claims-crawl.spec.ts` (rendered pages), and the document tests of DOC-a and DOC-b.
 *
 * `CLAIMS_CORE` is FR-PUB-01's own pattern (SRS line 1103) with `\bscored\b` and `\breadiness report\b` added
 * (owner question B26: the SRS pattern misses one of the strings its own *Why* cites). `CLAIMS` adds the rest of
 * the list with its forms. A word the SRS bans in one sense only ("approved" as something the platform gives,
 * "level" as a grade, "progress" or "complete" about a stage or project) is matched in the forms that carry that
 * sense; "complete the form" is not banned. `NEVER_LIST` holds one sentence per word or form that `CLAIMS` must
 * flag, and `MAY_APPEAR` ordinary strings it must not.
 */

export const CLAIMS_CORE =
  /\bcomplian(ce|t)\b|\baudit(-ready| ready|ed)\b|aligned (to|with)\b|\bcertif(y|ied|ication)\b|\baccredit|\bscores?\b|\bscored\b|\breadiness report\b|cannot see your records/i;

/** SRS 7.5.3's list of words that never appear, in the forms that carry the banned sense, on top of `CLAIMS_CORE`. */
/** A text node or string that is only a status label. Tested on each node alone, because it is anchored. */
export const STATUS_LABEL = /^\W*(status:\s*)?(complete(d)?|approved)\W*$/i;

export const NEVER_WORDS = [
  String.raw`\baudit(s|ing|or|ors|able)?\b`,
  String.raw`\bcompl(y|ies|ying|ied)\b`,
  String.raw`\bnon-?complian`,
  String.raw`\balign(s|ing|ment)? (to|with)\b`,
  String.raw`\b(re)?certif(ies|ying|ications|icate|icates)\b`,
  String.raw`\brecertif`,
  // "approved" as something the platform gives (SRS 7.5.3). A status label alone is STATUS_LABEL; the team's own
  // approvals ("data-access approval", "the approvals they require") are the SRS's own wording and stay legal.
  String.raw`\bapproved by (mak-ai|the platform|us)\b`,
  String.raw`\b(mak-ai|platform)[- ]approved\b`,
  String.raw`\bapproval (from|by) (mak-ai|the platform)\b`,
  String.raw`\b(non-?)?conform(s|ed|ing|ity|ities|ance|ant)?\b`,
  String.raw`\bscoring\b`,
  String.raw`\bscore(card|board)s?\b`,
  String.raw`\brat(ing|ings|ed)\b`,
  String.raw`\bgrad(e|es|ed|ing)\b`,
  String.raw`\brank(s|ed|ing|ings)?\b`,
  String.raw`\bmaturity\b`,
  String.raw`\breadiness\b`,
  String.raw`\blevels?\s*[:\-]?\s*(\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten)\b`,
  String.raw`\brisk[- ]levels?\b`,
  String.raw`\blevels? of risk\b`,
  String.raw`\b(?:low|medium|moderate|high|critical)[- ]risk (?:results?|levels?|ratings?|outcomes?|labels?|bands?)\b`,
  String.raw`\bbands?\b`,
  String.raw`\bpass(es|ed|ing)?\b`,
  String.raw`\bfail(s|ed|ing|ure|ures)?\b`,
  String.raw`\bpercentages?\b`,
  String.raw`\bper ?cent(age)?s?\b`,
  String.raw`\d\s?%`,
  String.raw`\bprogress(ed|es|ing)?\b`,
  String.raw`\b(stage|project|review|assessment)s?\b[^.!?\n]{0,30}\bcomplet(e|ed)\b`,
  String.raw`\bcompleted\b`,
  String.raw`\bmark(ed)? (as )?complete(d)?\b`,
  // The imperative or verb, not the adjective: "a complete review" and "the complete project record" are legal.
  String.raw`(?<!\b(?:a|an|the|its|our) )\bcomplet(e|es|ing) (the |this |your |a |each |all )?(project|review|stage)s?\b`,
  String.raw`\b(stage|project|review)s?\b[^.!?\n]{0,30}\bincomplete\b`,
  STATUS_LABEL.source,
  String.raw`\bcomplet(ion|eness)\b`,
  String.raw`\bsever(ity|ities)\b`,
  String.raw`\bgates?[ -][ab]\b`,
  String.raw`\bfacilitator`,
  String.raw`\bworkshops?\b`,
  String.raw`\bai[\s‐-―-]powered\b`,
  String.raw`\bpowered by ai\b`,
  String.raw`\bcan(not|['’]t) see (your|their|a team['’]s|the team['’]s) records\b`,
];

/**
 * What no word of the interface, a document or an email may match. The README, a developer's document that
 * records the project's own history, is held to `CLAIMS_CORE` only.
 */
export const CLAIMS = new RegExp(`${CLAIMS_CORE.source}|${NEVER_WORDS.join('|')}`, 'i');


// SRS 7.5.3 (line 2472): "these words and their forms never appear" in the interface, documents and emails.
// One synthetic page per entry holds one sentence with the word; the pattern must flag it. The qualified words
// ("approved" as something the platform gives, "level" as a grade, "progress" or "complete" about a stage or
// project) are flagged in the forms that carry the qualifier; their bare uses ("complete the form") are not banned.
export const NEVER_LIST: Array<[word: string, sentence: string]> = [
  ['compliance', 'Our compliance guide'], ['compliant', 'This record is compliant'],
  ['audit', 'Open the audit log'], ['audits', 'Teams run audits'], ['audited', 'Every record is audited'],
  ['auditing', 'Auditing your data'], ['audit-ready', 'Audit-ready documents'], ['auditor', 'Share it with an auditor'],
  ['certified', 'A certified team'], ['certification', 'Certification of the stage'], ['certify', 'We certify the stage'],
  ['certificate', 'Download the certificate'], ['accredited', 'An accredited body'],
  ['aligned with', 'Aligned with a standard'], ['alignment with', 'Alignment with a standard'],
  ['conforms to', 'It conforms to the standard'], ['conformity', 'Conformity checks'],
  ['score', 'The score'], ['scores', 'Scores for each area'], ['scored', 'Answers are scored'], ['scoring', 'Scoring rules'],
  ['rating', 'The rating of the team'], ['ratings', 'Ratings per area'], ['rated', 'Rated high'],
  ['grade', 'A grade for each area'], ['grades', 'Grades per stage'], ['graded', 'Graded answers'], ['grading', 'Grading rules'],
  ['rank', 'Rank the areas'], ['ranks', 'It ranks teams'], ['ranked', 'Areas are ranked'], ['ranking', 'A ranking of teams'],
  ['maturity', 'Maturity of the team'], ['readiness', 'Readiness for review'],
  ['level (as a grade)', 'Level 3 reached'], ['risk level', 'Risk level: high'], ['risk level (a low-risk result)', 'A low-risk result'],
  ['band', 'Band B'], ['bands', 'Bands of answers'],
  ['pass', 'Pass'], ['passed', 'The stage passed'], ['fail', 'Fail'], ['failed', 'The review failed'],
  ['percentage', 'A percentage of items'], ['%', '40% of items have a decision'],
  ['progress (about a stage)', 'Progress through the stage'],
  ['complete (about a stage)', 'This stage is complete'], ['complete (about a project)', 'The project was completed'],
  ['mark as complete', 'Mark as complete'], ['completion', 'Completion of the stage'],
  ['severity', 'Severity of the finding'],
  ['Gate A', 'Gate A review'], ['Gate B', 'Gate B review'], ['facilitator', 'Ask your facilitator'],
  ['workshop', 'Join the workshop'], ['AI-powered', 'AI-powered checks'],
  // Forms found by review: statuses, plurals, agent nouns, spellings and spacings of the words above.
  ['complete (mark stage as)', 'Mark stage as complete'], ['complete (have completed)', 'You have completed this stage.'],
  ['complete (completed stages)', 'Completed stages: 3 of 5'], ['complete (stage 2 is)', 'Stage 2 is complete'],
  ['complete (has been completed)', 'The stage has been completed.'], ['complete (status label)', 'Project status: Completed'],
  ['complete (mark complete)', 'Mark complete'], ['complete (imperative)', 'Complete this stage'],
  ['complies', 'This system complies with ISO/IEC 42001.'], ['noncompliant', 'Flag noncompliant systems.'],
  ['scorecard', 'Your scorecard'], ['percent', '40 percent of items have a decision'], ['per cent', '40 per cent of items'],
  ['level 0', 'Level 0: not started'], ['level two', 'Your team is at level two.'], ['level-3', 'A level-3 team'],
  ['risk-level', 'A risk-level badge'], ['level of risk', 'The level of risk is high.'],
  ['powered by AI', 'Checks powered by AI'], ['AI powered', 'AI powered suggestions'], ['AI-powered (U+2011)', 'AI\u2011powered checks'],
  ['auditable', 'Every decision is auditable.'], ['progressed', 'The stage has progressed to review.'],
  ['progressing', 'Progressing well'], ['Gates A and B', 'Gates A and B'], ['Gate-A', 'Gate-A review'],
  ['conformant', 'Conformant with ISO/IEC 42001'], ['nonconformity', 'Two nonconformities were found'],
  ['certifying', 'Certifying body'], ['recertification', 'Recertification due'], ['severities', 'Severities'],
  // C4 round 1 (CR-2): the most likely ways the banned senses appear.
  ['complete (a status label alone)', 'Complete'], ['completed (a status label alone)', 'Completed'],
  ['complete your project', 'Complete your project'], ['complete the review', 'Complete the review'],
  ['level: B', 'Level: B'], ['level III', 'Level III'], ['level A', 'Level A'],
  ['failure', 'A robustness failure'], ['failures', 'Two failures were found'],
  // C4 round 2 (ruled): "approved" is banned as something the platform gives; the SRS needs the team's own approvals.
  ['approved (a status label alone)', 'Approved'], ['approved by the platform', 'Approved by MAK-AI'],
  ['platform-approved', 'A platform-approved plan'], ['approval from the platform', 'Needs approval from the platform'],
  // C4 round 2 (M-1): more ways the banned senses appear.
  ['level: 3', 'Level: 3'], ['status: complete', 'Status: Complete'], ['complete with a full stop', 'Complete.'],
  ['completing the stage', 'Completing the stage'], ['completes the stage', 'The team completes the stage'],
  ['complete a stage', 'Complete a stage'], ['complete each stage', 'Complete each stage'], ['complete all stages', 'Complete all stages'],
  ['incomplete (about a stage)', 'Stage 2: incomplete'],
  ['cannot see (apostrophe)', 'We can\u2019t see your records'], ['cannot see (plain apostrophe)', "We can't see your records"],
];
// Words that share letters with the list and are ordinary: they must stay unflagged.
export const MAY_APPEAR = [
  'Enter your password', 'Operating hours', 'Integrated records', 'Generated from this team\'s own records', 'Migrated data',
  'Upgrade your browser', 'A gradient fill', 'Bypass the proxy', 'A branded button', 'Bandwidth', 'A passage', 'Passport photo',
  'Complete the form', 'An incomplete answer', 'Compass', 'Sign in to continue', 'Create a project', 'Save your decision',
  // The SRS's own team-approval wording (lines 3932, 3963, 3994, 4021, 4055, 4101-4102) and ordinary uses of "level" and "complete".
  'Waiting for data or data-access approval', 'An ethics approval letter or its reference', 'Pending approvals',
  'The team has obtained the approvals and registrations they require', 'Approvals are easy to lose track of', 'A missing approval can stop a deployment',
  'The level I expect', 'A level a reader can follow', 'A complete review of the literature', 'The complete project record',
  'Authority', 'Frank discussion', 'A progressive web app', 'Your decision is saved', 'Try again',
  'Complete your profile', 'A complex query', 'Reply to this message', 'Approximately two minutes', 'You can see your records',
];


/**
 * "Level" as a grade with a numeral or a letter ("Level: B", "Level III"). Tested without the `i` flag, so the
 * word must be capitalised and "the level I expect" is not a claim; the lower-case "level 3" is in `CLAIMS`.
 */
export const LEVEL_LABEL = /\bLevels?\s*[:-]?\s*([IVX]+|[A-E])\b/;

/** True when `text` holds any word of the list: `CLAIMS` or `LEVEL_LABEL`. */
export function isClaim(text: string): boolean {
  return CLAIMS.test(text) || LEVEL_LABEL.test(text);
}

/** Every match of the list in `text`, in the order found. */
export function claimMatches(text: string): Array<{ text: string; index: number }> {
  return [
    ...[...text.matchAll(new RegExp(CLAIMS.source, CLAIMS.flags.replace('g', '') + 'g'))],
    ...[...text.matchAll(new RegExp(LEVEL_LABEL.source, 'g'))],
  ].map((m) => ({ text: m[0], index: m.index ?? 0 }));
}
