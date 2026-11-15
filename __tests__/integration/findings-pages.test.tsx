import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OrgRole } from '@prisma/client';
import type { Identity } from '@/lib/auth/identity';
import { FindingsPageView } from '@/components/findings/FindingsPageView';
import { AcceptRiskForm } from '@/components/findings/AcceptRiskForm';
import { FindingPageView } from '@/components/findings/FindingPageView';
import { MitigationForm } from '@/components/findings/MitigationForm';
import { loadFindingPage, loadFindingsPage, type FindingPageData } from '@/lib/findings/pageData';
import { closeByDecision, openShortfallForQuestion } from '@/lib/data/findings';
import { loadQuestionPanel } from '@/lib/question/panel';
import { FINDINGS_COPY } from '@/lib/findings/copy';
import { onlyRolesCanText } from '@/lib/findings/messages';
import { deciderLabel, OUTSIDE_ROLE_LABELS } from '@/lib/decision/copy';
import { runningContent } from '@/lib/content/loader';
import { resetDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { sessionFor } from '../helpers/authSession';
import { HOSTILE_STRINGS, hostileText } from '../helpers/hostile';
import {
  addAcceptedRisk, addDecision, addFinding, addFindingEvent, addMitigationVersion, addProject, buildOrg, ctxFor, type OrgFixture,
} from '../helpers/recordFixture';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

let fx: OrgFixture;
let contentVersionId: string;
const identityOf = (role: OrgRole) => ({ userId: fx.members[role].userId } as Identity);
const loadPage = (role: OrgRole, projectId: string, stage: Parameters<typeof loadFindingsPage>[2]['stage'] = null, raise: Parameters<typeof loadFindingsPage>[2]['raise'] = null) =>
  loadFindingsPage(ctxFor(fx, role), identityOf(role), { projectId, stage, raise });
const renderList = async (role: OrgRole, projectId: string, stage: Parameters<typeof loadFindingsPage>[2]['stage'] = null) =>
  renderToStaticMarkup(<FindingsPageView data={await loadPage(role, projectId, stage)} />);

/** Awaits a page module's default export with `params` and `searchParams` as resolved Promises. */
async function renderPage(which: 'findings' | 'finding', params: { slug: string; id: string; findingId?: string }, searchParams: Record<string, string> = {}): Promise<string> {
  if (which === 'finding') {
    const mod = await import('@/app/(authenticated)/orgs/[slug]/projects/[id]/findings/[findingId]/page');
    return renderToStaticMarkup(await mod.default({ params: Promise.resolve(params as { slug: string; id: string; findingId: string }) }));
  }
  const mod = await import('@/app/(authenticated)/orgs/[slug]/projects/[id]/findings/page');
  return renderToStaticMarkup(await mod.default({ params: Promise.resolve(params), searchParams: Promise.resolve(searchParams) }));
}
const pageData = (role: OrgRole, projectId: string, findingId: string): Promise<FindingPageData> =>
  loadFindingPage(ctxFor(fx, role), identityOf(role), { projectId, findingId });
const renderFinding = async (f: { id: string; projectId: string }, role: OrgRole = 'reviewer') => renderToStaticMarkup(<FindingPageView data={await pageData(role, f.projectId, f.id)} />);
const NOT_FOUND = { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' };

beforeEach(async () => {
  await resetDb();
  contentVersionId = (await useFixtureContent('0.0.1-fixture')).contentVersionId;
  fx = await buildOrg();
});

/** One finding of every kind in one project: the fixture UX-15's test names. */
async function everyKind() {
  const p = await addProject(fx);
  const stage = 'pre-processing' as const;
  const sf = async (questionId: string) => {
    const raising = await addDecision(fx, p.id, { stage, questionId, contentVersionId, status: 'not_yet' });
    return { raising, f: await addFinding(fx, p.id, { stage, source: 'shortfall', questionId, decisionVersionId: raising.id }) };
  };
  const done = await sf('Q-PP-01'); await addDecision(fx, p.id, { stage, questionId: 'Q-PP-01', contentVersionId, status: 'done' });
  const gone = await sf('Q-PP-02'); await addDecision(fx, p.id, { stage, questionId: 'Q-PP-02', contentVersionId, status: 'withdrawn', withdrawalCode: 'entered_in_error' });
  const none = await addFinding(fx, p.id, { stage, source: 'team' });
  const late = await addFinding(fx, p.id, { stage, source: 'team' });
  await addMitigationVersion(fx, late.id, { status: 'planned', owner: 'assessor', dueDate: '2020-01-01' });
  const plain = await addFinding(fx, p.id, { stage, source: 'team' });
  await addMitigationVersion(fx, plain.id, { status: 'planned', owner: 'assessor', dueDate: '2099-01-01' });
  const again = await addFinding(fx, p.id, { stage, source: 'team' });
  await addAcceptedRisk(fx, again.id, { acceptedBy: { kind: 'outside_role', role: 'ethics_committee' }, lookAgainOn: '2020-01-01' });
  const closed = await addFinding(fx, p.id, { stage, source: 'team' });
  await addMitigationVersion(fx, closed.id, { status: 'done', owner: 'assessor', dueDate: '2026-12-01' });
  const withdrawn = await addFinding(fx, p.id, { stage, source: 'team' });
  await addFindingEvent(fx, withdrawn.id, { kind: 'withdrawn', by: 'owner' });
  return { p, done, gone, none, late, plain, again, closed, withdrawn };
}

/** The walk's path (B2): a Not yet decision, its finding, a Planned mitigation, then the decision changed to Done. */
async function blockedWalk(o: { mitigation?: boolean; status?: 'planned' | 'in_progress'; archived?: boolean; to?: 'done' | 'withdrawn' | 'gate' } = {}) {
  const p = await addProject(fx, o.archived === true ? { archived: true } : {});
  const stage = 'pre-processing' as const;
  const questionId = o.to === 'gate' ? 'Q-PP-13' : 'Q-PP-01';
  const raising = await addDecision(fx, p.id, { stage, questionId, contentVersionId, status: 'not_yet' });
  const f = { ...(await addFinding(fx, p.id, { stage, source: 'shortfall', questionId, decisionVersionId: raising.id })), projectId: p.id };
  const m = o.mitigation === false ? null : await addMitigationVersion(fx, f.id, { status: o.status ?? 'planned', owner: 'assessor', dueDate: '2099-01-01' });
  const done = o.to === 'withdrawn' ? await addDecision(fx, p.id, { stage, questionId, contentVersionId, status: 'withdrawn', withdrawalCode: 'entered_in_error' })
    : o.to === 'gate' ? await addDecision(fx, p.id, { stage, questionId: 'Q-PP-GATE-SENSITIVE', contentVersionId, scopeAnswer: 'no' })
      : await addDecision(fx, p.id, { stage, questionId, contentVersionId, status: 'done' });
  return { f, m, done };
}

/** "Close finding" pressed: the service route 11 calls, as an assessor. */
const pressClose = (w: { f: { id: string; projectId: string }; done: { id: string } }) => closeByDecision(
  ctxFor(fx, 'assessor'), { userId: fx.members.assessor.userId, role: 'assessor' },
  { requestId: randomUUID(), decisionVersionId: w.done.id, projectId: w.f.projectId, findingId: w.f.id }, 'd'.repeat(64),
);

describe('S-14 the findings list (UX-15, UX-06, UX-07, FR-FND-07, FR-FND-08)', () => {
  it('UX-15 FR-FND-07: S-14 shows each kind under its UX-15 heading in order, and withdrawn ones only under Withdrawn', async () => {
    const k = await everyKind();
    const html = await renderList('reviewer', k.p.id);
    const L = FINDINGS_COPY.list;
    const order: Array<string | RegExp> = [L.decisionDone, L.decisionWithdrawn, /Pre-processing<\/span>: \d+ findings?/, L.noMitigation,
      L.overdue, L.lookAgain, L.closed, L.withdrawn];   // the stage heading carries its count (R13-9)
    const at = (h: string | RegExp) => html.search(typeof h === 'string' ? new RegExp(`>${h}<`) : new RegExp(`>${h.source}<`));
    expect(order.map(at).every((i) => i >= 0)).toBe(true);
    expect(order.map(at)).toEqual([...order.map(at)].sort((a, b) => a - b));
    expect(html.split(k.withdrawn.id).length - 1).toBe(1);
    // Each finding sits in exactly one group (the withdrawn and the to-close ones are not repeated under the stage).
    for (const f of [k.done.f, k.gone.f, k.none, k.late, k.plain, k.again, k.closed, k.withdrawn]) expect(html.split(`/findings/${f.id}"`).length - 1, f.id).toBe(1);
  });

  it('UX-06 (R12-16): every state label on S-14 is a status-label element and none carries the warning class', async () => {
    const k = await everyKind();
    const html = await renderList('reviewer', k.p.id);
    const states = [...html.matchAll(/<[a-z]+ [^>]*class="([^"]*\bstatus-label\b[^"]*)"[^>]*>([^<]*)</g)];
    expect(states.map((m) => m[2])).toEqual(expect.arrayContaining([FINDINGS_COPY.labels.open, FINDINGS_COPY.labels.closedByMitigation, FINDINGS_COPY.labels.withdrawn, FINDINGS_COPY.labels.closedByAcceptedRiskBy(OUTSIDE_ROLE_LABELS.ethics_committee)]));
    expect(states.every((m) => !/status-label--warning/.test(m[1]))).toBe(true);
  });

  it('UX-07 FR-RM-04 (R13-9, owner default B40): each stage heading on S-14 carries its own count, "1 finding" for one, and no element holds the sum', async () => {
    const q = await addProject(fx, { name: 'Counts' });
    for (let i = 0; i < 2; i++) await addFinding(fx, q.id, { stage: 'pre-processing', source: 'team' });
    await addFinding(fx, q.id, { stage: 'in-processing', source: 'team' });
    const html = await renderList('reviewer', q.id);
    // The heading marks the stage's name as a defined term (spec 6), so the name ends in its Term's closing tag.
    const heading = (stage: string, n: number) => `>${stage}</span>${FINDINGS_COPY.labels.stageCountRest(n)}<`;
    expect(html).toContain(heading('Pre-processing', 2)); expect(html).toContain(heading('In-processing', 1));
    expect(html).not.toMatch(/\b3 findings?\b/);                                   // 2 + 1 appears on no element
    const filtered = await renderList('reviewer', q.id, 'pre-processing');
    expect(filtered).toContain(heading('Pre-processing', 2)); expect(filtered).not.toContain('id="g-in-processing"');   // the stage filter keeps the count of what is listed
  });

  it('UX-40 UX-07: a list shows 50 findings and "Show more", and the stage heading still counts its whole group', async () => {
    const q = await addProject(fx, { name: 'Many' });
    for (let i = 0; i < 52; i++) await addFinding(fx, q.id, { stage: 'pre-processing', source: 'team' });
    const html = await renderList('reviewer', q.id);
    expect(html).toContain(`>Pre-processing</span>${FINDINGS_COPY.labels.stageCountRest(52)}<`);
    expect(html.match(/\/findings\/[0-9a-f-]{36}"/g)).toHaveLength(50);
    expect(html).toMatch(/href="\/orgs\/[^"]+\/findings\?shown=100"[^>]*>Show more</);
  });

  it('FR-FND-06 UX-15: a to-close finding carries its Close it button when the role can mitigate, and none for a reviewer', async () => {
    const k = await everyKind();
    const asAssessor = await renderList('assessor', k.p.id);
    // One button each for the decision now done and the decision withdrawn, named with the finding's title.
    expect(asAssessor.split(`aria-label="${FINDINGS_COPY.closeByDecision.ariaLabel('')}`).length - 1).toBe(2);
    expect(asAssessor).toContain(`>${FINDINGS_COPY.closeByDecision.label}</button>`);
    expect(await renderList('reviewer', k.p.id)).not.toContain(FINDINGS_COPY.closeByDecision.label);
  });

  it('FR-FND-01 (screen): a shortfall is titled by its question text and sourced from its version; a team finding is "Raised by the team"', async () => {
    const k = await everyKind();
    const html = await renderList('viewer', k.p.id);
    expect(html).toContain(FINDINGS_COPY.labels.fromDecisionWith('Not yet'));
    expect(html).toContain(FINDINGS_COPY.labels.raisedByTeam);
  });

  it('FR-FND-02 FR-FND-08: members see their findings on S-14, and a non-member gets 404', async () => {
    const k = await everyKind();
    const stranger = await buildOrg({ label: 'b' });
    sessionFor(fx.members.viewer.userId);
    expect(await renderPage('findings', { slug: fx.org.slug, id: k.p.id })).toContain('Findings');
    sessionFor(stranger.members.owner.userId);
    await expect(renderPage('findings', { slug: fx.org.slug, id: k.p.id })).rejects.toMatchObject(NOT_FOUND);
  });

  it('NFR-SEC-02: S-14 of a project of another organisation answers 404', async () => {
    const stranger = await buildOrg({ label: 'c' });
    const foreign = await addProject(stranger);
    sessionFor(fx.members.owner.userId);
    await expect(renderPage('findings', { slug: fx.org.slug, id: foreign.id })).rejects.toMatchObject(NOT_FOUND);
  });

  it('NFR-SEC-11: hostile titles render as text on S-14', async () => {
    const hostile = buildHostileOrg();
    fx = await hostile;
    const p = await addProject(fx);
    await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team' });
    const html = await renderList('reviewer', p.id);
    for (const s of HOSTILE_STRINGS.slice(0, 2)) expect(html).not.toContain(s);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toMatch(/href="javascript:/);
  });

  it('UX-31 FR-PRJ-03: an archived project shows the banner and no raise, close or mitigation control', async () => {
    const k = await everyKind();
    const archived = await addProject(fx, { archived: true });
    await addFinding(fx, archived.id, { stage: 'pre-processing', source: 'team' });
    const html = await renderList('owner', archived.id);
    expect(html).toContain('This project is archived. Nothing in it can be changed.');
    expect(html).not.toMatch(new RegExp(`<form|${FINDINGS_COPY.closeByDecision.label}`));
    expect(k.p.id).not.toBe(archived.id);
  });

  it('FR-FND-02 FR-FND-08 (screen): a project with no finding shows the S-14 empty text', async () => {
    const p = await addProject(fx);
    expect(await renderList('viewer', p.id)).toContain(FINDINGS_COPY.list.emptyProject);
  });
});

/** A question's text in the content the pages run on (the fixture content). */
function questionText(id: string): string {
  const q = runningContent().questions.get(id);
  if (q === undefined) throw new Error(`no question ${id} in the fixture content`);
  return q.text;
}

function buildHostileOrg(): Promise<OrgFixture> {
  return buildOrg({ label: 'h', text: hostileText });
}

// ─── S-15 and the raise form (Task 4) ───────────────────────────────────────────────────────────

describe('S-15 the finding page and the S-14 raise form (FR-FND-02, FR-FND-03, FR-FND-05, FR-FND-07, UX-14, UX-16, UX-17, UX-29)', () => {
  const team = async (opts: { questionId?: string; decisionVersionId?: string; by?: OrgRole; project?: { id: string } } = {}) => {
    const p = opts.project ?? await addProject(fx);
    const f = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team', by: opts.by ?? 'reviewer', questionId: opts.questionId ?? null, decisionVersionId: opts.decisionVersionId ?? null });
    return { ...f, projectId: p.id };
  };

  it('FR-FND-02: S-15 of a team finding about a question shows "About question <id> (version n)"', async () => {
    const p = await addProject(fx);
    await addDecision(fx, p.id, { stage: 'pre-processing', questionId: 'Q-PP-12', contentVersionId, status: 'partly' });
    const v2 = await addDecision(fx, p.id, { stage: 'pre-processing', questionId: 'Q-PP-12', contentVersionId, status: 'partly' });
    const f = await team({ project: p, questionId: 'Q-PP-12', decisionVersionId: v2.id });
    expect(await renderFinding(f)).toContain(`${FINDINGS_COPY.finding.aboutQuestion} <bdi>${questionText('Q-PP-12')}</bdi>`);
  });

  it('UX-14 FR-FND-02: the raise form opened from S-12 has the stage and the question\'s first risk area filled in', async () => {
    const p = await addProject(fx);
    const v = await addDecision(fx, p.id, { stage: 'pre-processing', questionId: 'Q-PP-12', contentVersionId, status: 'done' });
    const html = renderToStaticMarkup(<FindingsPageView data={await loadPage('reviewer', p.id, null, { stage: 'pre-processing', questionId: 'Q-PP-12', versionId: v.id })} />);
    expect(html).toMatch(/<option[^>]*value="pre-processing"[^>]*selected/);
    expect(html).toMatch(/<option[^>]*value="PP-07"[^>]*selected/);          // Q-PP-12's gaps in the fixture content are ['PP-07']
    expect(html).toContain(`${FINDINGS_COPY.raise.aboutQuestion} <bdi>${questionText('Q-PP-12')}</bdi>`);
  });

  it('UX-14: a hand-made raise address naming a question of another stage fills nothing in', async () => {
    const p = await addProject(fx);
    const html = renderToStaticMarkup(<FindingsPageView data={await loadPage('reviewer', p.id, null, { stage: 'in-processing', questionId: 'Q-PP-12', versionId: null })} />);
    expect(html).not.toContain(FINDINGS_COPY.raise.aboutQuestion);
  });

  it('UX-16 UX-17 M-26: an assessor sees no accept form and the M-26 line; a viewer sees no form at all', async () => {
    const f = await team();
    const a = await renderFinding(f, 'assessor');
    expect(a).not.toContain(`${FINDINGS_COPY.acceptRisk.submit}</button>`); expect(a).toContain(onlyRolesCanText('risk:accept'));
    expect(await renderFinding(f, 'viewer')).not.toMatch(/<form|<button[^>]*>(Add a mitigation|Update this mitigation|Accept the risk)/);
  });

  it('UX-17 FR-FND-05: an admin sees the accept form with its sentence slot, an owner of an accepted risk sees keep-accepted, a reviewer neither', async () => {
    const f = await team({ by: 'owner' });
    const admin = await renderFinding(f, 'admin');
    expect(admin).toContain(`${FINDINGS_COPY.acceptRisk.submit}</button>`); expect(admin).toContain(FINDINGS_COPY.acceptRisk.intro);
    expect(admin).toContain(FINDINGS_COPY.acceptRisk.outsideWho('Ethics committee'));
    expect(admin).toMatch(/<button[^>]*>Cancel<\/button>/);   // W-6: Accept the risk and Cancel
    expect(await renderFinding(f, 'reviewer')).not.toContain(`${FINDINGS_COPY.acceptRisk.submit}</button>`);
    const g = await team({ by: 'owner' });
    await addAcceptedRisk(fx, g.id, { lookAgainOn: '2020-01-01' });
    expect(await renderFinding(g, 'owner')).toContain(FINDINGS_COPY.acceptRisk.keepTrigger);
  });

  it('UX-29 FR-FND-07: withdraw appears only on a team finding, for its raiser, owners and admins', async () => {
    const p = await addProject(fx);
    const raising = await addDecision(fx, p.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId, status: 'not_yet' });
    const shortfall = { ...(await addFinding(fx, p.id, { stage: 'pre-processing', source: 'shortfall', questionId: 'Q-PP-01', decisionVersionId: raising.id })), projectId: p.id };
    const byReviewer = await team({ project: p, by: 'reviewer' });
    expect(await renderFinding(shortfall, 'owner')).not.toContain('Withdraw');
    expect(await renderFinding(byReviewer, 'reviewer')).toContain('Withdraw');
    expect(await renderFinding(byReviewer, 'owner')).toContain('Withdraw');
    expect(await renderFinding(byReviewer, 'assessor')).not.toContain('Withdraw');
  });

  it('NFR-SEC-02: S-15 of a finding of another project answers 404, and a non-member gets 404', async () => {
    const f = await team();
    const other = await addProject(fx, { name: 'Other' });
    sessionFor(fx.members.owner.userId);
    await expect(renderPage('finding', { slug: fx.org.slug, id: other.id, findingId: f.id })).rejects.toMatchObject(NOT_FOUND);
    const stranger = await buildOrg({ label: 'b' });
    sessionFor(stranger.members.owner.userId);
    await expect(renderPage('finding', { slug: fx.org.slug, id: f.projectId, findingId: f.id })).rejects.toMatchObject(NOT_FOUND);
    sessionFor(fx.members.viewer.userId);
    expect(await renderPage('finding', { slug: fx.org.slug, id: f.projectId, findingId: f.id })).toContain(FINDINGS_COPY.finding.mitigations);
  });

  it('FR-SUG-03 UX-08 (screen): S-15 shows one Ways teams address this heading naming the risk area, the names and Show details, and no section without controls', async () => {
    const p = await addProject(fx);
    const withArea = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team', by: 'reviewer', riskArea: 'IP-05' });
    const html = await renderFinding({ ...withArea, projectId: p.id });
    expect(html.split(FINDINGS_COPY.finding.ways).length - 1).toBe(1);
    expect(html).toContain(`<h2 id="f-ways">${FINDINGS_COPY.finding.ways}</h2>`);   // CONSOLIDATED 2 ("control"): the heading names no risk area
    expect(html).not.toMatch(/controls? for this question/);
    expect(html).toContain('<summary>Show details</summary>');
    for (const riskArea of [null, 'XX-99']) {
      const f = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team', by: 'reviewer', riskArea });
      const none = await renderFinding({ ...f, projectId: p.id });
      expect(none, String(riskArea)).not.toContain(FINDINGS_COPY.finding.ways);
      expect(none, String(riskArea)).not.toContain('f-ways');
    }
  });

  it('FR-FND-03 (screen): a finding with no mitigation shows the 7.4.2 S-15 empty line', async () => {
    expect(await renderFinding(await team())).toContain(FINDINGS_COPY.finding.noMitigations);
  });

  it('NFR-SEC-11: hostile titles, descriptions, reasons and notes render as text on S-15', async () => {
    fx = await buildHostileOrg();
    const f = await team({ by: 'owner' });
    await addMitigationVersion(fx, f.id, { status: 'done', owner: 'assessor', dueDate: '2026-12-01' });
    await addFindingEvent(fx, f.id, { kind: 'reopened', by: 'owner' });
    const html = await renderFinding(f, 'owner');
    for (const s of HOSTILE_STRINGS.slice(0, 2)) expect(html).not.toContain(s);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toMatch(/href="javascript:/);
  });

  it('UX-31 FR-PRJ-03: an archived project shows the banner and no mitigation, accept, withdraw or reopen control', async () => {
    const archived = await addProject(fx, { archived: true });
    const f = await team({ project: archived, by: 'owner' });
    const html = await renderFinding(f, 'owner');
    expect(html).toContain('This project is archived. Nothing in it can be changed.');
    expect(html).not.toMatch(new RegExp(`<form|<button|${FINDINGS_COPY.closeByDecision.label}`));
  });

  it('FR-FND-05: an accepted risk reads "Closed: risk accepted by <who> on <date>. Look at it again on <date>."', async () => {
    const f = await team({ by: 'owner' });
    const ar = await addAcceptedRisk(fx, f.id, { acceptedBy: { kind: 'outside_role', role: 'ethics_committee' }, lookAgainOn: '2027-03-01' });
    expect(ar.id).toBeTruthy();
    const html = await renderFinding(f, 'viewer');
    // A3: the header's label names the role alone; the history line keeps deciderLabel's record form (Task 17's words).
    expect(html).toContain(`${FINDINGS_COPY.finding.acceptedHeaderStart}<bdi>${OUTSIDE_ROLE_LABELS.ethics_committee}</bdi>) on `);
    expect(html).toContain(`${FINDINGS_COPY.mitigation.riskAcceptedBy} <bdi>${deciderLabel({ kind: 'outside_role', role: 'ethics_committee' }, '', 'record')}</bdi>`);
    expect(html).toMatch(/<\/bdi>\) on \d{1,2} \w{3} 20\d\d\. To be checked again on 1 Mar 2027\./);
    expect(html).toContain(FINDINGS_COPY.finding.checkAgainOn('1 Mar 2027'));
  });

  it('FR-FND-07 UX-29: a closed finding offers Reopen to an assessor, the M-26 line to a viewer, and nothing once withdrawn', async () => {
    const f = await team({ by: 'owner' });
    await addMitigationVersion(fx, f.id, { status: 'done', owner: 'assessor', dueDate: '2026-12-01' });
    expect(await renderFinding(f, 'assessor')).toContain(FINDINGS_COPY.actions.reopenTrigger);
    const viewer = await renderFinding(f, 'viewer');
    expect(viewer).not.toContain(FINDINGS_COPY.actions.reopenTrigger); expect(viewer).toContain(onlyRolesCanText('finding:reopen'));
    const w = await team({ by: 'owner' });
    await addFindingEvent(fx, w.id, { kind: 'withdrawn', by: 'owner' });
    const A = FINDINGS_COPY.actions;
    expect(await renderFinding(w, 'owner')).not.toMatch(new RegExp(`${A.reopenTrigger}|${A.withdrawTrigger}|${A.withdrawAction}`));
  });

  it('FR-FND-06 (screen): a shortfall whose decision is now done shows the box with the Close it button', async () => {
    const p = await addProject(fx);
    const raising = await addDecision(fx, p.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId, status: 'not_yet' });
    const f = { ...(await addFinding(fx, p.id, { stage: 'pre-processing', source: 'shortfall', questionId: 'Q-PP-01', decisionVersionId: raising.id })), projectId: p.id };
    await addDecision(fx, p.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId, status: 'done' });
    const html = await renderFinding(f, 'assessor');
    expect(html).toContain(FINDINGS_COPY.finding.closeChanged('Done'));
    expect(html).toContain(`>${FINDINGS_COPY.closeByDecision.label}</button>`);
    expect(html).toContain(FINDINGS_COPY.finding.raisedByPlatformOn);
    expect(await renderFinding(f, 'reviewer')).not.toContain(FINDINGS_COPY.closeByDecision.label);
  });

  it('B2 (loader): a finding with a Planned mitigation whose decision is now Done is blocked, and S-14 keeps it in its stage group, not under Ready to close', async () => {
    const w = await blockedWalk();
    const data = await pageData('assessor', w.f.projectId, w.f.id);
    expect(data.closeBlocked).toBe(true);
    expect(data.closeByDecision).toMatchObject({ reason: 'decision_done', decisionVersionId: w.done.id });
    const list = await loadPage('assessor', w.f.projectId);
    expect(list.decisionDone).toEqual([]);
    expect(list.stages.map((s) => s.other.map((i) => i.id))).toEqual([[w.f.id]]);
    // An unblocked one is not marked.
    const free = await blockedWalk({ mitigation: false });
    expect((await pageData('assessor', free.f.projectId, free.f.id)).closeBlocked).toBe(false);
  });

  it('B2 (screen): while a mitigation is Planned the box gives the cause and why the finding stays open, with no Close finding button', async () => {
    const w = await blockedWalk();
    const html = await renderFinding(w.f, 'assessor');
    const F = FINDINGS_COPY.finding;
    expect(html).toMatch(new RegExp(`class="finding-close-box"[^>]*><p>${F.closeChangedCause('Done')}</p><p>${F.closeBlocked}</p></section>`));
    expect(html).not.toContain(F.closeChanged('Done'));
    expect(html).not.toContain(FINDINGS_COPY.closeByDecision.label);
    const list = await renderList('assessor', w.f.projectId);
    expect(list).not.toContain(`>${FINDINGS_COPY.list.decisionDone}<`);
    expect(list).not.toContain(FINDINGS_COPY.closeByDecision.label);
    expect(list.split(`/findings/${w.f.id}"`).length - 1).toBe(1);
  });

  it('B2 (stuck): after a close pressed while a mitigation was Planned, the box says why it stays open, with no cause and no button; Cancel then closes it', async () => {
    const w = await blockedWalk();
    await pressClose(w);
    expect((await pageData('assessor', w.f.projectId, w.f.id)).closeBlocked).toBe(true);
    const html = await renderFinding(w.f, 'assessor');
    const F = FINDINGS_COPY.finding;
    expect(html).toMatch(new RegExp(`class="finding-close-box"[^>]*><p>${F.closeBlocked}</p></section>`));
    expect(html).not.toContain(F.closeChangedCause('Done'));
    expect(html).not.toContain(`>${FINDINGS_COPY.closeByDecision.label}</button>`);   // the history's "Close finding was pressed..." line is not a button
    await addMitigationVersion(fx, w.f.id, { mitigationId: w.m!.mitigationId, status: 'cancelled', owner: 'assessor', dueDate: '2099-01-01' });
    const after = await pageData('assessor', w.f.projectId, w.f.id);
    expect(after.detail.state).toBe('closed_mitigation');
    expect(renderToStaticMarkup(<FindingPageView data={after} />)).not.toContain('finding-close-box');
  });

  it('B2 (a way on): marking the mitigation Done closes the finding; cancelling it brings back Close finding, and pressing it closes the finding', async () => {
    const d = await blockedWalk();
    await addMitigationVersion(fx, d.f.id, { mitigationId: d.m!.mitigationId, status: 'done', owner: 'assessor', dueDate: '2099-01-01' });
    expect((await pageData('assessor', d.f.projectId, d.f.id)).detail.state).toBe('closed_mitigation');
    const c = await blockedWalk();
    await addMitigationVersion(fx, c.f.id, { mitigationId: c.m!.mitigationId, status: 'cancelled', owner: 'assessor', dueDate: '2099-01-01' });
    const data = await pageData('assessor', c.f.projectId, c.f.id);
    expect(data.closeBlocked).toBe(false);
    const html = renderToStaticMarkup(<FindingPageView data={data} />);
    expect(html).toContain(FINDINGS_COPY.finding.closeChanged('Done'));
    expect(html).toContain(`>${FINDINGS_COPY.closeByDecision.label}</button>`);
    await pressClose(c);
    expect((await pageData('assessor', c.f.projectId, c.f.id)).detail.state).toBe('closed_mitigation');
  });

  it('FR-FND-02 FR-FND-08 (screen): a viewer gets S-14 without the raise form', async () => {
    const p = await addProject(fx);
    const html = renderToStaticMarkup(<FindingsPageView data={await loadPage('viewer', p.id)} />);
    expect(html).not.toMatch(/Raise finding|<form/);
  });
});

describe('S-15 mitigations on the page (FR-FUP-05, FR-FND-03, UX-06, NFR-A11Y-05)', () => {
  const twoMitigations = async () => {
    const p = await addProject(fx);
    const f = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team', by: 'owner' });
    const stays = await addMitigationVersion(fx, f.id, { status: 'planned', owner: 'assessor', dueDate: '2020-01-01' });
    const left = await addMitigationVersion(fx, f.id, { status: 'in_progress', owner: 'admin', dueDate: '2099-01-01' });
    return { f: { ...f, projectId: p.id }, stays, left };
  };

  it('FR-FUP-05 (screen): a mitigation whose owner cannot act is marked "Owner cannot act: reassign" with the label word in the warning tint, and only that one', async () => {
    const { f, left } = await twoMitigations();
    const data = { ...(await pageData('owner', f.projectId, f.id)), ownerCannotAct: [left.mitigationId] };
    const html = renderToStaticMarkup(<FindingPageView data={data} />);
    // H3: a sentence in plain ink in the mitigation's card, not a status and not tinted.
    const line = `<p>${FINDINGS_COPY.mitigation.cannotAct}</p>`;
    const card = html.indexOf(`data-mitigation-id="${left.mitigationId}"`);
    expect(card).toBeGreaterThanOrEqual(0);
    expect(html.indexOf(line, card)).toBeGreaterThan(card);
    expect(html.split(FINDINGS_COPY.mitigation.cannotAct).length - 1).toBe(1);
  });

  it('UX-06 (R12-16): on S-15 the overdue line and the owner-cannot-act mark are the only warning elements, and the mitigation status labels are neutral', async () => {
    const { f, left } = await twoMitigations();
    const data = { ...(await pageData('owner', f.projectId, f.id)), ownerCannotAct: [left.mitigationId] };
    const html = renderToStaticMarkup(<FindingPageView data={data} />);
    // Spec 7.1: the overdue red is the word "Overdue" alone, in its own span, never inside a status label; nothing on the
    // page carries the warning tint; each state and status word is still a status-label.
    const overdue = [...html.matchAll(/<span class="finding-overdue">([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(overdue).toEqual([FINDINGS_COPY.labels.overdue]);
    expect(html).toContain(`<span class="finding-overdue">${FINDINGS_COPY.labels.overdue}</span>${FINDINGS_COPY.labels.wasDue('1 Jan 2020')}`);
    expect(html).not.toMatch(/status-label--warning|badge--moderate/);
    expect(html).not.toMatch(/class="[^"]*status-label[^"]*"[^>]*>[^<]*Overdue/);
    expect(html).toContain(`<p>${FINDINGS_COPY.mitigation.cannotAct}</p>`);
    expect(html).toMatch(/<bdi class="status-label">Open<\/bdi>/);
    expect(html).toMatch(/class="status-label"[^>]*>Planned</);
    expect(html).toMatch(/class="status-label"[^>]*>In progress</);
  });

  it('FR-FND-04 (screen): a done mitigation with no evidence reads "Done, no artefact: <note>", and History lists every version', async () => {
    const p = await addProject(fx);
    const f = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team', by: 'owner' });
    const first = await addMitigationVersion(fx, f.id, { status: 'planned', owner: 'assessor', dueDate: '2026-12-01' });
    await addMitigationVersion(fx, f.id, { mitigationId: first.mitigationId, status: 'done', owner: 'assessor', dueDate: '2026-12-01' });
    const html = await renderFinding({ ...f, projectId: p.id }, 'owner');
    expect(html).toMatch(new RegExp(`${FINDINGS_COPY.mitigationForm.doneNothingAttached} <bdi>Fixture closureNote \\d+</bdi>`));
    expect(html).toContain(FINDINGS_COPY.mitigation.historySummary(2));
  });

  // F1 (the owner's decision, 14 Nov 2026): a mitigation a "close by decision" wrote has a null text that was never erased;
  // the card shows the sentence for its kind in the text's place. Only those two kinds; an erased text and an action's
  // null text keep the empty line they had; an action's text is unchanged. The stored rows are not touched.
  const firstLineOf = async (kind: 'decision_changed' | 'decision_withdrawn' | 'action', what: 'null' | 'erased' | 'text') => {
    const p = await addProject(fx);
    const f = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team', by: 'owner' });
    const m = await addMitigationVersion(fx, f.id, { status: 'done', kind, owner: 'assessor', dueDate: '2026-12-01' });
    // R2: a version-1 decision closure is a closing record and has no card; with a second version it is a card (ruling C).
    if (kind !== 'action') await addMitigationVersion(fx, f.id, { mitigationId: m.mitigationId, status: 'done', kind, owner: 'assessor', dueDate: '2026-12-01' });
    const data = await pageData('owner', p.id, f.id);
    const mit = data.mitigations[0];
    if (what !== 'text') mit.current = { ...mit.current, what: null, erasedFields: what === 'erased' ? ['what'] : [] };
    const html = renderToStaticMarkup(<FindingPageView data={data} />);
    const card = html.indexOf(`data-mitigation-id="${m.mitigationId}"`);
    expect(card).toBeGreaterThanOrEqual(0);
    return html.slice(html.indexOf('>', card) + 1, html.indexOf('</p>', card) + 4);
  };

  it('F1: a decision_changed mitigation with a null, unerased text reads "Closed because the decision changed."', async () => {
    expect(await firstLineOf('decision_changed', 'null')).toBe(`<p>${FINDINGS_COPY.mitigation.closedBecauseDecisionChanged}</p>`);
  });

  it('F1: a decision_withdrawn mitigation with a null, unerased text reads "Closed because the decision was withdrawn."', async () => {
    expect(await firstLineOf('decision_withdrawn', 'null')).toBe(`<p>${FINDINGS_COPY.mitigation.closedBecauseDecisionWithdrawn}</p>`);
  });

  it('F1: an erased text keeps its empty line, and an action with a null text keeps the empty line it had', async () => {
    expect(await firstLineOf('decision_changed', 'erased')).toBe('<p></p>');
    expect(await firstLineOf('decision_withdrawn', 'erased')).toBe('<p></p>');
    expect(await firstLineOf('action', 'null')).toBe('<p></p>');
  });

  it('B10 (ruling L5-10): the follows-a-control option reads "<name> (<id>)", as its sibling rows do', async () => {
    const p = await addProject(fx);
    const f = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team', by: 'owner' });
    const d = await pageData('owner', p.id, f.id);
    const html = renderToStaticMarkup(<MitigationForm orgSlug={d.orgSlug} projectId={d.projectId} findingId={f.id} base={null} owners={d.owners}
      controls={[{ id: 'CTRL-01', name: 'Bias audit' }]} userId={d.viewer.userId} orgId={d.orgId} />);
    expect(html).toMatch(/<option value="CTRL-01"[^>]*>Bias audit \(CTRL-01\)<\/option>/);
  });

  it('F1: an action with a text shows its text, not a decision sentence', async () => {
    const line = await firstLineOf('action', 'text');
    expect(line).toMatch(/^<p><bdi>Fixture what \d+<\/bdi><\/p>$/);
  });
});

describe('C4 fixes: names in bdi, the accept form after an acceptance, separators, the loader mapping (SFH-3, CR-1, CR-7, SI-1)', () => {
  const RLO = '\u202E';
  it('NFR-SEC-11 (SFH-3): every member name in a sentence of S-15 sits inside <bdi>, so a U+202E name cannot reorder the date after it', async () => {
    const hostileName = `Ev${RLO}il`;
    fx = await buildOrg({ label: 'bidi', text: (f, n) => `Fixture ${f} ${n}` });
    await testDbSetName(fx.members.owner.userId, hostileName);
    const p = await addProject(fx);
    const f = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team', by: 'owner' });
    await addMitigationVersion(fx, f.id, { status: 'done', owner: 'assessor', dueDate: '2026-12-01', by: 'owner' });
    await addAcceptedRisk(fx, f.id, { lookAgainOn: '2027-03-01', by: 'owner' });
    const html = await renderFinding({ ...f, projectId: p.id }, 'viewer');
    // Every place the name appears is inside a <bdi> element.
    const outside: string[] = [];
    for (let at = html.indexOf(hostileName); at >= 0; at = html.indexOf(hostileName, at + 1)) {
      if (html.lastIndexOf('<bdi', at) <= html.lastIndexOf('</bdi>', at)) outside.push(html.slice(Math.max(0, at - 40), at + 30));
    }
    expect(outside).toEqual([]);
    expect(html.split(hostileName).length - 1).toBeGreaterThan(3);
  });

  it('UX-17 FR-FND-05 (CR-1): after an acceptance the finding offers "Looked at again" behind its button, with no form open and no field filled', async () => {
    const p = await addProject(fx);
    const f = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team', by: 'owner' });
    await addAcceptedRisk(fx, f.id, { lookAgainOn: '2020-01-01' });
    const html = await renderFinding({ ...f, projectId: p.id }, 'admin');
    expect(html).toContain(FINDINGS_COPY.acceptRisk.keepTrigger);
    expect(html).not.toMatch(/<textarea|Accepted by \(required\)|Why the risk is/);
  });

  it('UX-17 (CR-1): the accept form is keyed by the finding\'s state, so keep-accepted mounts fresh', async () => {
    const p = await addProject(fx);
    const open = { ...(await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team', by: 'owner' })), projectId: p.id };
    const closed = { ...(await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team', by: 'owner' })), projectId: p.id };
    await addAcceptedRisk(fx, closed.id, { lookAgainOn: '2020-01-01' });
    const keyOf = async (f: typeof open) => {
      const tree = FindingPageView({ data: await pageData('admin', f.projectId, f.id) });
      const seen: Array<string | null> = [];
      const walk = (n: unknown): void => {
        if (Array.isArray(n)) return n.forEach(walk);
        if (typeof n !== 'object' || n === null) return;
        const el = n as { type?: unknown; key?: string | null; props?: Record<string, unknown> };
        if (el.type === AcceptRiskForm) seen.push(el.key ?? null);
        for (const v of Object.values(el.props ?? {})) walk(v);
      };
      walk(tree);
      return seen;
    };
    expect(await keyOf(open)).toEqual(['open:none']);
    const first = (await keyOf(closed))[0];
    expect(first).toMatch(/^closed_accepted_risk:[0-9a-f-]{36}$/);
    // A keep-accepted save leaves the state as it is and adds an accepted risk: the key must change so the form remounts behind its trigger (I-1).
    await addAcceptedRisk(fx, closed.id, { lookAgainOn: '2020-06-01' });
    const second = (await keyOf(closed))[0];
    expect(second).toMatch(/^closed_accepted_risk:/);
    expect(second).not.toBe(first);
  });

  it('CR-7: the parts of a line are joined with a middle dot, never " . "', async () => {
    const p = await addProject(fx);
    const f = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team', by: 'owner' });
    await addMitigationVersion(fx, f.id, { status: 'planned', owner: 'assessor', dueDate: '2099-01-01' });
    const html = await renderFinding({ ...f, projectId: p.id }, 'owner');
    expect(html).not.toMatch(/ \. /);
    expect(html).toContain(' \u00b7 ');
    const list = renderToStaticMarkup(<FindingsPageView data={await loadPage('owner', p.id)} />);
    expect(list).not.toMatch(/ \. /);
  });

  it('FR-FUP-05 (SI-1): the loader maps FUP\'s ownerCannotAct items of this finding to the mitigations the page marks, and the view reads that one list', async () => {
    const p = await addProject(fx);
    const f = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team', by: 'owner' });
    const m = await addMitigationVersion(fx, f.id, { status: 'planned', owner: 'assessor', dueDate: '2099-01-01' });
    const other = await addMitigationVersion(fx, f.id, { status: 'planned', owner: 'admin', dueDate: '2099-01-01' });
    const followup = await import('@/lib/data/followup');
    const spy = vi.spyOn(followup, 'ownerCannotAct').mockResolvedValue([{ mitigationId: m.mitigationId, findingId: f.id }] as never);
    try {
      const data = await pageData('owner', p.id, f.id);
      expect(data.ownerCannotAct).toEqual([m.mitigationId]);
      const html = renderToStaticMarkup(<FindingPageView data={data} />);
      expect(html.split(FINDINGS_COPY.mitigation.cannotAct).length - 1).toBe(1);
      const card = html.indexOf(`data-mitigation-id="${m.mitigationId}"`);
      expect(card).toBeGreaterThanOrEqual(0);
      expect(html.indexOf(FINDINGS_COPY.mitigation.cannotAct, card)).toBeGreaterThan(card);
      expect(other.mitigationId).not.toBe(m.mitigationId);
    } finally { spy.mockRestore(); }
  });
});

async function testDbSetName(userId: string, name: string): Promise<void> {
  const { testDb } = await import('../helpers/db');
  await testDb.user.update({ where: { id: userId }, data: { name } });
}

/** A string as a regular expression that matches it literally. */
const lit = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const reopen = (f: { id: string }) => addFindingEvent(fx, f.id, { kind: 'reopened', by: 'assessor' });

describe('B2 review notes: the gate on the blocked box and what counts as a closing record (ruling R1, ruling C)', () => {
  it('B2: the composed close sentences read exactly as before, from one copy of each sentence', () => {
    const F = FINDINGS_COPY.finding;
    expect(F.closeChanged('Done')).toBe('The decision on this question is now Done. You can close this finding now.');
    expect(F.closeWithdrawn).toBe('The decision on this question was withdrawn. You can close this finding now.');
    expect(F.closeGate).toBe('Your team answered No to the personal data question, so this question does not apply. You can close this finding now.');
    expect(F.closeChanged('Done')).toBe(`${F.closeChangedCause('Done')} ${F.closeNow}`);
    expect(F.closeWithdrawn).toBe(`${F.closeWithdrawnCause} ${F.closeNow}`);
    expect(F.closeGate).toBe(`${F.closeGateCause} ${F.closeNow}`);
  });

  it('B2: a reviewer, a viewer and an archived project get no box on a blocked finding; an owner and an admin get the blocked box', async () => {
    const w = await blockedWalk();
    for (const role of ['reviewer', 'viewer'] as const) {
      const d = await pageData(role, w.f.projectId, w.f.id);
      expect([role, d.closeBlocked, d.closeByDecision]).toEqual([role, false, null]);
      expect(await renderFinding(w.f, role)).not.toContain('finding-close-box');
    }
    for (const role of ['owner', 'admin'] as const) expect((await pageData(role, w.f.projectId, w.f.id)).closeBlocked).toBe(true);
    const a = await blockedWalk({ archived: true });
    expect(await renderFinding(a.f, 'owner')).not.toContain('finding-close-box');
  });

  it('B2: a mitigation In progress blocks as Planned does', async () => {
    const w = await blockedWalk({ status: 'in_progress' });
    expect((await pageData('assessor', w.f.projectId, w.f.id)).closeBlocked).toBe(true);
    expect((await loadPage('assessor', w.f.projectId)).decisionDone).toEqual([]);
  });

  it('B2: a closing record at or below the latest reopen does not count', async () => {
    const w = await blockedWalk();
    await pressClose(w);
    await addMitigationVersion(fx, w.f.id, { mitigationId: w.m!.mitigationId, status: 'cancelled', owner: 'assessor', dueDate: '2099-01-01' });
    await reopen(w.f);
    await addMitigationVersion(fx, w.f.id, { status: 'planned', owner: 'assessor', dueDate: '2099-01-01' });
    const d = await pageData('assessor', w.f.projectId, w.f.id);
    expect([d.detail.state, d.closeBlocked, d.closeByDecision]).toEqual(['open', false, null]);
  });

  it('B2 ruling C: a decision closure with two versions is not a closing record: it does not block, and it is shown as a card', async () => {
    const w = await blockedWalk();
    await pressClose(w);
    await addDecision(fx, w.f.projectId, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId, status: 'not_yet' });   // no closure now
    expect((await pageData('assessor', w.f.projectId, w.f.id)).closeBlocked).toBe(true);    // the record still counts
    const record = (await pageData('assessor', w.f.projectId, w.f.id)).detail.mitigations.find((m) => m.current.kind !== 'action')!;
    await addMitigationVersion(fx, w.f.id, { mitigationId: record.mitigationId, kind: 'decision_changed', status: 'done', owner: 'assessor', dueDate: '2099-01-01' });
    const d = await pageData('assessor', w.f.projectId, w.f.id);
    expect(d.closeBlocked).toBe(false);
    expect(d.mitigations.map((m) => m.current.mitigationId).sort()).toEqual([w.m!.mitigationId, record.mitigationId].sort());
  });

  it('B2: the blocked box gives the withdrawn cause and the personal data cause', async () => {
    const F = FINDINGS_COPY.finding;
    const w = await blockedWalk({ to: 'withdrawn' });
    expect(await renderFinding(w.f, 'assessor')).toMatch(new RegExp(`class="finding-close-box"[^>]*><p>${lit(F.closeWithdrawnCause)}</p><p>${lit(F.closeBlocked)}</p></section>`));
    const g = await blockedWalk({ to: 'gate' });
    expect(await renderFinding(g.f, 'assessor')).toMatch(new RegExp(`class="finding-close-box"[^>]*><p>${lit(F.closeGateCause)}</p><p>${lit(F.closeBlocked)}</p></section>`));
  });
});

describe('R2 R3: a closing record is not a mitigation, and the cause is true (rulings R2, R3, A, B, C)', () => {
  const F = FINDINGS_COPY.finding;
  const M = FINDINGS_COPY.mitigation;
  const name = () => fx.members.assessor.name;
  const closureLine = (cause: string | null) => new RegExp(
    `<p>${lit(F.closedBy)} <bdi>${lit(name())}</bdi> ${F.on} <time[^>]*>\\d{1,2} \\w{3} 20\\d\\d</time>\\.${cause === null ? '' : ` ${lit(cause)}`}</p>`);

  it('R2 R3: a plain close: no card, the label "Closed", the closure line with the changed cause, and "Finding closed by" in the history', async () => {
    const w = await blockedWalk({ mitigation: false });
    await pressClose(w);
    const d = await pageData('assessor', w.f.projectId, w.f.id);
    expect(d.mitigations).toEqual([]);
    expect(d.stateLabel).toBe(FINDINGS_COPY.labels.closed);
    const html = renderToStaticMarkup(<FindingPageView data={d} />);
    expect(html).toContain(`<bdi class="status-label">${FINDINGS_COPY.labels.closed}</bdi>`);
    expect(html).toMatch(closureLine(M.closedBecauseDecisionChanged));
    expect(html).toContain(`<p>${F.noMitigations}</p>`);
    expect(html).toMatch(new RegExp(`</time> ${lit(M.findingClosedBy)} <bdi>${lit(name())}</bdi>\\.</li>`));
    expect(html).not.toContain(M.added);
    expect(html).not.toContain('finding-card');
    const row = (await loadPage('assessor', w.f.projectId)).closed.find((i) => i.id === w.f.id);
    expect(row?.stateLabel).toBe(FINDINGS_COPY.labels.closed);
  });

  it('R3: the withdrawn cause and the no longer applies cause; R3 rule A: no cause it cannot read, and no guessed one', async () => {
    const wd = await blockedWalk({ mitigation: false, to: 'withdrawn' });
    await pressClose(wd);
    expect(await renderFinding(wd.f, 'viewer')).toMatch(closureLine(M.closedBecauseDecisionWithdrawn));
    const g = await blockedWalk({ mitigation: false, to: 'gate' });
    await pressClose(g);
    expect(await renderFinding(g.f, 'viewer')).toMatch(closureLine(M.closedBecauseNoLongerApplies));
    // A decision_changed record that names no decision version: the line says who and when, and no cause.
    const p = await addProject(fx);
    const t = { ...(await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team', by: 'owner' })), projectId: p.id };
    await addMitigationVersion(fx, t.id, { kind: 'decision_changed', status: 'done', owner: 'assessor', by: 'assessor', dueDate: '2026-11-14' });
    const html = await renderFinding(t, 'viewer');
    expect(html).toMatch(closureLine(null));
    for (const cause of [M.closedBecauseDecisionChanged, M.closedBecauseDecisionWithdrawn, M.closedBecauseNoLongerApplies]) expect(html).not.toContain(cause);
  });

  it('R2 ruling B (stuck): the notice, one card, no closure line, and the history line that the finding stayed open', async () => {
    const w = await blockedWalk();
    await pressClose(w);
    const d = await pageData('assessor', w.f.projectId, w.f.id);
    expect(d.mitigations.map((m) => m.current.mitigationId)).toEqual([w.m!.mitigationId]);
    const html = renderToStaticMarkup(<FindingPageView data={d} />);
    expect(html).toContain(`<p>${F.closeBlocked}</p>`);
    expect(html.match(/class="finding-card"/g)).toHaveLength(1);
    expect(html.split(`>${F.updateMitigation}<`).length - 1).toBe(1);
    expect(html).not.toContain(`${F.closedBy} <bdi>`);
    expect(html).toMatch(new RegExp(`</time> ${lit(M.pressedWhileOpen)} <bdi>${lit(name())}</bdi></li>`));
    expect(html.split(M.added).length - 1).toBe(1);   // the real mitigation only
  });

  it('R2: after the stuck case is cancelled the label is "Closed" with the cause; after Done it is "Closed by a mitigation" with no closure line', async () => {
    const c = await blockedWalk();
    await pressClose(c);   // the assessor presses while the mitigation is Planned
    await addMitigationVersion(fx, c.f.id, { mitigationId: c.m!.mitigationId, status: 'cancelled', owner: 'assessor', by: 'owner', dueDate: '2099-01-01' });   // the owner cancels
    const cancelled = await renderFinding(c.f, 'viewer');
    expect(cancelled).toContain(`<bdi class="status-label">${FINDINGS_COPY.labels.closed}</bdi>`);
    // Fix 1: the press did not close the finding, so no "Closed by" names its presser or day; the cause stands alone.
    expect(cancelled).not.toContain(`${F.closedBy} <bdi>`);
    expect(cancelled).toContain(`<p>${M.closedBecauseDecisionChanged}</p>`);
    expect(cancelled).toMatch(new RegExp(`</time> ${lit(M.pressedWhileOpen)} <bdi>${lit(name())}</bdi></li>`));
    expect(cancelled).toMatch(new RegExp(`</time> ${lit(M.updated(2))}[^<]*<bdi>[^<]*</bdi>[^<]*<bdi>${lit(fx.members.owner.name)}</bdi></li>`));
    const dn = await blockedWalk();
    await pressClose(dn);
    await addMitigationVersion(fx, dn.f.id, { mitigationId: dn.m!.mitigationId, status: 'done', owner: 'assessor', dueDate: '2099-01-01' });
    const done = await renderFinding(dn.f, 'viewer');
    expect(done).toContain(`<bdi class="status-label">${FINDINGS_COPY.labels.closedByMitigation}</bdi>`);
    expect(done).not.toContain(`${F.closedBy} <bdi>`);
    const rows = (await loadPage('viewer', dn.f.projectId)).closed;
    expect(rows.map((r) => r.stateLabel)).toEqual([FINDINGS_COPY.labels.closedByMitigation]);
  });

  it('R3: S-14 lists a gate answered No under its own heading, after the changed and the withdrawn ones', async () => {
    const p = await addProject(fx);
    const stage = 'pre-processing' as const;
    const sf = async (questionId: string) => addFinding(fx, p.id, { stage, source: 'shortfall', questionId,
      decisionVersionId: (await addDecision(fx, p.id, { stage, questionId, contentVersionId, status: 'not_yet' })).id });
    const changed = await sf('Q-PP-01'); await addDecision(fx, p.id, { stage, questionId: 'Q-PP-01', contentVersionId, status: 'done' });
    const gone = await sf('Q-PP-02'); await addDecision(fx, p.id, { stage, questionId: 'Q-PP-02', contentVersionId, status: 'withdrawn', withdrawalCode: 'entered_in_error' });
    const gate = await sf('Q-PP-13'); await addDecision(fx, p.id, { stage, questionId: 'Q-PP-GATE-SENSITIVE', contentVersionId, scopeAnswer: 'no' });
    const data = await loadPage('assessor', p.id);
    expect([data.decisionDone.map((i) => i.id), data.decisionWithdrawn.map((i) => i.id), data.gateNo.map((i) => i.id)]).toEqual([[changed.id], [gone.id], [gate.id]]);
    const html = renderToStaticMarkup(<FindingsPageView data={data} />);
    const L = FINDINGS_COPY.list;
    const at = [L.decisionDone, L.decisionWithdrawn, L.gateNo].map((h) => html.indexOf(`>${h}<`));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(html.split(`aria-label="${FINDINGS_COPY.closeByDecision.ariaLabel('')}`).length - 1).toBe(3);
  });
});

describe('R4 R5: the question page line, the link back, and the order of S-14 (rulings R4, R5)', () => {
  it('R4: S-12 data marks the open finding closable when a decision closure is available and no mitigation is open', async () => {
    const free = await blockedWalk({ mitigation: false });
    const ctx = ctxFor(fx, 'viewer');
    expect(await openShortfallForQuestion(ctx, free.f.projectId, 'Q-PP-01')).toEqual({ findingId: free.f.id, closable: true });
    const blocked = await blockedWalk();
    expect(await openShortfallForQuestion(ctx, blocked.f.projectId, 'Q-PP-01')).toEqual({ findingId: blocked.f.id });
    const p = await addProject(fx);
    const raising = await addDecision(fx, p.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId, status: 'not_yet' });
    const plain = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'shortfall', questionId: 'Q-PP-01', decisionVersionId: raising.id });
    expect(await openShortfallForQuestion(ctx, p.id, 'Q-PP-01')).toEqual({ findingId: plain.id });
  });

  it('R4 (fix 2): on an archived project S-12 does not say the finding can now be closed', async () => {
    const live = await blockedWalk({ mitigation: false });
    const q = (projectId: string) => loadQuestionPanel(ctxFor(fx, 'owner'), identityOf('owner'), { projectId, stage: 'pre-processing', questionId: 'Q-PP-01' });
    expect((await q(live.f.projectId)).openFinding).toEqual({ findingId: live.f.id, closable: true });
    const shelved = await blockedWalk({ mitigation: false, archived: true });
    expect((await q(shelved.f.projectId)).openFinding).toEqual({ findingId: shelved.f.id });
  });

  it('R4: a finding about a question of the running content links back to it; a team finding with no question does not', async () => {
    const w = await blockedWalk({ mitigation: false });
    const html = await renderFinding(w.f, 'viewer');
    expect(html).toMatch(new RegExp(`<a[^>]*href="/orgs/${fx.org.slug}/projects/${w.f.projectId}/stages/pre-processing/questions/Q-PP-01"[^>]*>${FINDINGS_COPY.finding.openQuestion}</a>`));
    const p = await addProject(fx);
    const t = { ...(await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team', by: 'owner' })), projectId: p.id };
    expect(await renderFinding(t, 'viewer')).not.toContain(FINDINGS_COPY.finding.openQuestion);
  });

  it('R5: on S-14 the lists come before the raise form, which keeps id="raise"', async () => {
    const k = await everyKind();
    const html = await renderList('reviewer', k.p.id);
    const form = html.indexOf('id="raise"');
    expect(form).toBeGreaterThan(0);
    for (const h of [FINDINGS_COPY.list.decisionDone, FINDINGS_COPY.list.closed, FINDINGS_COPY.list.withdrawn]) expect(html.indexOf(`>${h}<`)).toBeLessThan(form);
  });
});
