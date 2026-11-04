import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OrgRole } from '@prisma/client';
import type { Identity } from '@/lib/auth/identity';
import { FindingsPageView } from '@/components/findings/FindingsPageView';
import { FindingPageView } from '@/components/findings/FindingPageView';
import { loadFindingPage, loadFindingsPage, type FindingPageData } from '@/lib/findings/pageData';
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

describe('S-14 the findings list (UX-15, UX-06, UX-07, FR-FND-07, FR-FND-08)', () => {
  it('UX-15 FR-FND-07: S-14 shows each kind under its UX-15 heading in order, and withdrawn ones only under Withdrawn', async () => {
    const k = await everyKind();
    const html = await renderList('reviewer', k.p.id);
    const order: Array<string | RegExp> = ['Decision now done: close it', 'Decision withdrawn: close it', /Pre-processing: \d+ findings?/, 'Open, no mitigation yet',
      'Open, with overdue mitigations', 'Accepted risks to look at again', 'Closed', 'Withdrawn'];   // the stage heading carries its count (R13-9)
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
    expect(states.map((m) => m[2])).toEqual(expect.arrayContaining(['Open', 'Closed by mitigation', 'Withdrawn', 'Closed: risk accepted by Ethics committee (outside role)']));
    expect(states.every((m) => !/status-label--warning/.test(m[1]))).toBe(true);
  });

  it('UX-07 FR-RM-04 (R13-9, owner default B40): each stage heading on S-14 carries its own count, "1 finding" for one, and no element holds the sum', async () => {
    const q = await addProject(fx, { name: 'Counts' });
    for (let i = 0; i < 2; i++) await addFinding(fx, q.id, { stage: 'pre-processing', source: 'team' });
    await addFinding(fx, q.id, { stage: 'in-processing', source: 'team' });
    const html = await renderList('reviewer', q.id);
    expect(html).toContain('>Pre-processing: 2 findings<'); expect(html).toContain('>In-processing: 1 finding<');
    expect(html).not.toMatch(/\b3 findings?\b/);                                   // 2 + 1 appears on no element
    const filtered = await renderList('reviewer', q.id, 'pre-processing');
    expect(filtered).toContain('>Pre-processing: 2 findings<'); expect(filtered).not.toContain('In-processing:');   // the stage filter keeps the count of what is listed
  });

  it('UX-40 UX-07: a list shows 50 findings and "Show more", and the stage heading still counts its whole group', async () => {
    const q = await addProject(fx, { name: 'Many' });
    for (let i = 0; i < 52; i++) await addFinding(fx, q.id, { stage: 'pre-processing', source: 'team' });
    const html = await renderList('reviewer', q.id);
    expect(html).toContain('>Pre-processing: 52 findings<');
    expect(html.match(/\/findings\/[0-9a-f-]{36}"/g)).toHaveLength(50);
    expect(html).toMatch(/href="\/orgs\/[^"]+\/findings\?shown=100"[^>]*>Show more</);
  });

  it('FR-FND-06 UX-15: a to-close finding carries its Close it button when the role can mitigate, and none for a reviewer', async () => {
    const k = await everyKind();
    const asAssessor = await renderList('assessor', k.p.id);
    expect(asAssessor).toContain('Close it: decision changed'); expect(asAssessor).toContain('Close it: decision withdrawn');
    expect(await renderList('reviewer', k.p.id)).not.toContain('Close it:');
  });

  it('FR-FND-01 (screen): a shortfall is titled by its question text and sourced from its version; a team finding is "Raised by the team"', async () => {
    const k = await everyKind();
    const html = await renderList('viewer', k.p.id);
    expect(html).toMatch(/From question Q-PP-01 \(version 1, status Not yet\)/);
    expect(html).toContain('Raised by the team');
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
    expect(html).not.toMatch(/<form|Close it:/);
    expect(k.p.id).not.toBe(archived.id);
  });

  it('FR-FND-02 FR-FND-08 (screen): a project with no finding shows the S-14 empty text', async () => {
    const p = await addProject(fx);
    expect(await renderList('viewer', p.id)).toContain('No findings in this project. A finding opens when a decision is saved as Partly or Not yet, or when someone raises one.');
  });
});

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
    expect(await renderFinding(f)).toContain('About question <bdi>Q-PP-12</bdi> (version 2)');
  });

  it('UX-14 FR-FND-02: the raise form opened from S-12 has the stage and the question\'s first risk area filled in', async () => {
    const p = await addProject(fx);
    const v = await addDecision(fx, p.id, { stage: 'pre-processing', questionId: 'Q-PP-12', contentVersionId, status: 'done' });
    const html = renderToStaticMarkup(<FindingsPageView data={await loadPage('reviewer', p.id, null, { stage: 'pre-processing', questionId: 'Q-PP-12', versionId: v.id })} />);
    expect(html).toMatch(/<option[^>]*value="pre-processing"[^>]*selected/);
    expect(html).toMatch(/<option[^>]*value="PP-07"[^>]*selected/);          // Q-PP-12's gaps in the fixture content are ['PP-07']
    expect(html).toContain('About question <bdi>Q-PP-12</bdi> (version 1)');
  });

  it('UX-14: a hand-made raise address naming a question of another stage fills nothing in', async () => {
    const p = await addProject(fx);
    const html = renderToStaticMarkup(<FindingsPageView data={await loadPage('reviewer', p.id, null, { stage: 'in-processing', questionId: 'Q-PP-12', versionId: null })} />);
    expect(html).not.toContain('About question');
  });

  it('UX-16 UX-17 M-26: an assessor sees no accept form and the M-26 line; a viewer sees no form at all', async () => {
    const f = await team();
    const a = await renderFinding(f, 'assessor');
    expect(a).not.toContain('Accept the risk</button>'); expect(a).toContain('Only owners and admins can accept a risk.');
    expect(await renderFinding(f, 'viewer')).not.toMatch(/<form|<button[^>]*>(Add a mitigation|Update this mitigation|Accept the risk)/);
  });

  it('UX-17 FR-FND-05: an admin sees the accept form with its sentence slot, an owner of an accepted risk sees keep-accepted, a reviewer neither', async () => {
    const f = await team({ by: 'owner' });
    const admin = await renderFinding(f, 'admin');
    expect(admin).toContain('Accept the risk</button>'); expect(admin).toContain('Accepting a risk closes this finding without a mitigation.');
    expect(admin).toContain('Ethics committee (outside role)');
    expect(await renderFinding(f, 'reviewer')).not.toContain('Accept the risk</button>');
    const g = await team({ by: 'owner' });
    await addAcceptedRisk(fx, g.id, { lookAgainOn: '2020-01-01' });
    expect(await renderFinding(g, 'owner')).toContain('Looked at again: keep accepted');
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
    expect(await renderPage('finding', { slug: fx.org.slug, id: f.projectId, findingId: f.id })).toContain('Mitigations');
  });

  it('FR-FND-03 (screen): a finding with no mitigation shows the 7.4.2 S-15 empty line', async () => {
    expect(await renderFinding(await team())).toContain('No mitigations yet. Add one, or an owner or admin can accept the risk.');
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
    expect(html).not.toMatch(/<form|<button|Close it:/);
  });

  it('FR-FND-05: an accepted risk reads "Closed: risk accepted by <who> on <date>. Look at it again on <date>."', async () => {
    const f = await team({ by: 'owner' });
    const ar = await addAcceptedRisk(fx, f.id, { acceptedBy: { kind: 'outside_role', role: 'ethics_committee' }, lookAgainOn: '2027-03-01' });
    expect(ar.id).toBeTruthy();
    const html = await renderFinding(f, 'viewer');
    expect(html).toMatch(/Closed: risk accepted by Ethics committee \(outside role\) on \d{1,2} \w{3} 20\d\d\. Look at it again on 1 Mar 2027\./);
  });

  it('FR-FND-07 UX-29: a closed finding offers Reopen to an assessor, the M-26 line to a viewer, and nothing once withdrawn', async () => {
    const f = await team({ by: 'owner' });
    await addMitigationVersion(fx, f.id, { status: 'done', owner: 'assessor', dueDate: '2026-12-01' });
    expect(await renderFinding(f, 'assessor')).toContain('Reopen this finding');
    const viewer = await renderFinding(f, 'viewer');
    expect(viewer).not.toContain('Reopen this finding'); expect(viewer).toContain('Only owners, admins and assessors can reopen a finding.');
    const w = await team({ by: 'owner' });
    await addFindingEvent(fx, w.id, { kind: 'withdrawn', by: 'owner' });
    expect(await renderFinding(w, 'owner')).not.toMatch(/Reopen this finding|Withdraw<|Withdraw finding/);
  });

  it('FR-FND-06 (screen): a shortfall whose decision is now done shows the box with the Close it button', async () => {
    const p = await addProject(fx);
    const raising = await addDecision(fx, p.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId, status: 'not_yet' });
    const f = { ...(await addFinding(fx, p.id, { stage: 'pre-processing', source: 'shortfall', questionId: 'Q-PP-01', decisionVersionId: raising.id })), projectId: p.id };
    await addDecision(fx, p.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId, status: 'done' });
    const html = await renderFinding(f, 'assessor');
    expect(html).toContain('The decision on Q-PP-01 is now Done (version 2). Close this finding with that decision?');
    expect(html).toContain('Close it: decision changed');
    expect(html).toContain('Raised automatically on');
    expect(await renderFinding(f, 'reviewer')).not.toContain('Close it:');
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
    data.mitigations = data.mitigations.map((m) => ({ ...m, ownerCannotAct: m.current.mitigationId === left.mitigationId }));
    const html = renderToStaticMarkup(<FindingPageView data={data} />);
    expect(html).toMatch(new RegExp(`data-mitigation-id="${left.mitigationId}"[\\s\\S]*?<span class="[^"]*status-label--warning[^"]*">Owner cannot act</span>: reassign`));
    expect(html.split('Owner cannot act</span>: reassign').length - 1).toBe(1);
  });

  it('UX-06 (R12-16): on S-15 the overdue line and the owner-cannot-act mark are the only warning elements, and the mitigation status labels are neutral', async () => {
    const { f, left } = await twoMitigations();
    const data = await pageData('owner', f.projectId, f.id);
    data.mitigations = data.mitigations.map((m) => ({ ...m, ownerCannotAct: m.current.mitigationId === left.mitigationId }));
    const html = renderToStaticMarkup(<FindingPageView data={data} />);
    const warn = [...html.matchAll(/class="[^"]*status-label--warning[^"]*"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(warn).toHaveLength(2);
    expect(warn.sort()).toEqual(['Overdue', 'Owner cannot act']);                   // R13-7: exactly the label words RM's expectNeutralStatusLabels allows, never the whole phrase
    expect(html).toMatch(/>Overdue<\/span>: was due 1 Jan 2020/); expect(html).toMatch(/>Owner cannot act<\/span>: reassign/);
    expect(html).toMatch(/class="[^"]*\bstatus-label\b(?![^"]*--warning)[^"]*"[^>]*>Planned</);
    expect(html).toMatch(/class="[^"]*\bstatus-label\b(?![^"]*--warning)[^"]*"[^>]*>In progress</);
  });

  it('FR-FND-04 (screen): a done mitigation with no evidence reads "Done, no artefact: <note>", and History lists every version', async () => {
    const p = await addProject(fx);
    const f = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team', by: 'owner' });
    const first = await addMitigationVersion(fx, f.id, { status: 'planned', owner: 'assessor', dueDate: '2026-12-01' });
    await addMitigationVersion(fx, f.id, { mitigationId: first.mitigationId, status: 'done', owner: 'assessor', dueDate: '2026-12-01' });
    const html = await renderFinding({ ...f, projectId: p.id }, 'owner');
    expect(html).toMatch(/Done, no artefact: <bdi>Fixture closureNote \d+<\/bdi>/);
    expect(html).toContain('History: 2 versions');
  });
});
