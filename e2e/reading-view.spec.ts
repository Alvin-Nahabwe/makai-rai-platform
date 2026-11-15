import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { expectNoHorizontalScroll } from './helpers/reflow';
import { actAsSeat, fixtureOrgSlug, newProject, questionPath, seatOf, seatRequest, waitForQuestionPage } from './helpers/session';
import { QUESTION_COPY } from '../lib/question/copy';

/**
 * The reading view for a Reviewer and a Viewer (lane 1 Task 3 of the Route rebuild, to
 * directions/surfaces/viewer-reading.png): one decision with a file and a link, in a seal, with an open finding whose
 * mitigation is overdue. Each reader sees the card, the evidence (a Download button; a link that says it opens another
 * site and never shows its address), what is still open with the overdue phrase, the sealed copy and the way on, with no
 * form; at 1440, 1280 and 375 the page is captured into test-results/reading-view/ for the design review.
 */
const Q = 'Q-PP-01';
const R = QUESTION_COPY.reading;
const LINK_LABEL = 'District antenatal register summary';
const FILE_NAME = 'representativeness-check.pdf';
const REASON = 'The training set covers all 14 centres. We compared its age and parity distribution with the 2023 district register and found adolescent mothers under-represented by about a third.';
const MITIGATION = 'Collect and label a further 1,500 records from the two adolescent-friendly clinics and retrain with sample weights';

/** A tiny PDF: the platform checks the type by its first bytes and stores the file as it is. */
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');

let projectId = '';

test.beforeAll(async ({ baseURL }) => {
  projectId = await newProject(baseURL!, `Reading view ${Date.now()}`);
  const org = fixtureOrgSlug();
  const owner = await seatRequest(baseURL!, 'owner');
  try {
    const file = await owner.post(`/api/v1/orgs/${org}/projects/${projectId}/evidence`, {
      multipart: { requestId: crypto.randomUUID(), file: { name: FILE_NAME, mimeType: 'application/pdf', buffer: PDF } },
    });
    expect(file.status(), 'file evidence').toBe(201);
    const link = await owner.post(`/api/v1/orgs/${org}/projects/${projectId}/evidence`, {
      data: { requestId: crypto.randomUUID(), kind: 'link', url: 'https://example.org/district-register', label: LINK_LABEL },
    });
    expect(link.status(), 'link evidence').toBe(201);
    const ids = [((await file.json()) as { id: string }).id, ((await link.json()) as { id: string }).id];
    const saved = await owner.post(`/api/v1/orgs/${org}/projects/${projectId}/decisions`, { data: {
      requestId: crypto.randomUUID(), stage: 'pre-processing', questionId: Q, baseVersionNumber: null, status: 'partly', scopeAnswer: null,
      optionsInPlace: [], reasonCode: null, reason: REASON, decidedBy: { kind: 'member', userId: seatOf('assessor').userId },
      declaredDate: '2026-02-18', evidenceIds: ids,
    } });
    expect(saved.status(), 'decision save').toBe(201);
    const review = await owner.post(`/api/v1/orgs/${org}/projects/${projectId}/reviews`, { data: { requestId: crypto.randomUUID(), stage: 'pre-processing', preparedFor: null } });
    expect(review.status(), 'open review').toBe(201);
    const { id: reviewId } = (await review.json()) as { id: string };
    expect((await owner.post(`/api/v1/orgs/${org}/projects/${projectId}/reviews/${reviewId}/seals`, { data: { requestId: crypto.randomUUID() } })).status(), 'seal').toBe(201);
  } finally {
    await owner.dispose();
  }
});

/** The finding Partly raised, found through the reader's own page; then an overdue mitigation is added to it. */
async function addOverdueMitigation(page: Page, baseURL: string): Promise<void> {
  const href = await page.locator('section[data-region="open-work"] a').first().getAttribute('href');
  const findingId = href!.split('/').pop()!;
  const owner = await seatRequest(baseURL, 'owner');
  try {
    const res = await owner.post(`/api/v1/orgs/${fixtureOrgSlug()}/projects/${projectId}/findings/${findingId}/mitigations`, { data: {
      requestId: crypto.randomUUID(), what: MITIGATION, ownerUserId: seatOf('assessor').userId, dueDate: '2026-09-30', status: 'in_progress',
      followsControl: null, evidenceIds: [],
    } });
    expect(res.status(), 'mitigation').toBe(201);
  } finally {
    await owner.dispose();
  }
}

test.describe.configure({ mode: 'serial' });

for (const role of ['viewer', 'reviewer'] as const) {
  test(`a ${role} reads the decision card, what is still open and the sealed copy, with no form, at 1440, 1280 and 375`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await actAsSeat(page, role);
    await page.goto(questionPath(projectId, Q));
    await waitForQuestionPage(page);
    if (role === 'viewer') {
      await addOverdueMitigation(page, baseURL!);
      await page.reload();
      await waitForQuestionPage(page);
    }

    const card = page.locator('section[data-region="current-decision"]');
    await expect(card.getByRole('heading', { level: 2, name: R.title })).toBeVisible();
    await expect(card.locator('blockquote.reading-decision__reason')).toHaveText(REASON);
    await expect(card.locator('.reading-decision__state')).toContainText('Partly');
    await expect(card.getByRole('link', { name: `Download ${FILE_NAME}` })).toBeVisible();
    await expect(card.getByRole('link', { name: `${LINK_LABEL}${R.opensAnotherSite}` })).toBeVisible();
    await expect(card).not.toContainText('example.org');

    const open = page.locator('section[data-region="open-work"]');
    await expect(open.getByRole('heading', { level: 2 })).toHaveText(R.stillOpen(1));
    await expect(open.locator('[data-overdue]')).toContainText('Overdue');
    await expect(open.locator('[data-overdue]')).toContainText('was due 30 Sep 2026');
    await expect(open.locator('.still-open__what')).toHaveText(R.mitigation(MITIGATION));

    const aside = page.locator('[data-region="reading-aside"]');
    await expect(aside.getByRole('heading', { level: 2, name: R.sealedHeading })).toBeVisible();
    await expect(aside.getByRole('link', { name: R.next(2) })).toBeVisible();
    await expect(page.locator('form:not(.route-column__filter)')).toHaveCount(0);
    await expect(page.locator('.question-workspace__main').locator('input, select, textarea, button')).toHaveCount(0);
    await expect(page.getByRole('link', { name: QUESTION_COPY.findingLink.raise })).toHaveCount(role === 'reviewer' ? 1 : 0);

    for (const [width, height] of [[1440, 900], [1280, 800], [375, 812]] as const) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('.shell__main')?.scrollTo(0, 0); });
      await expectNoHorizontalScroll(page);
      await page.screenshot({ path: `test-results/reading-view/${role}-${width}x${height}.png` });
      await page.screenshot({ path: `test-results/reading-view/${role}-${width}x${height}-full.png`, fullPage: true });
    }
    // At 375 the reading order is the card, what is still open, then the aside, then the guidance (the frame's order).
    const y = async (sel: string) => (await page.locator(sel).first().boundingBox())!.y;
    const order = [await y('section[data-region="current-decision"]'), await y('section[data-region="open-work"]'),
      await y('[data-region="reading-aside"]'), await y('aside[data-region="guidance"]')];
    expect(order, 'card, still open, aside, guidance at 375').toEqual([...order].sort((a, b) => a - b));
    for (const [width, height] of [[1280, 800], [375, 812], [320, 640]] as const) {
      await page.setViewportSize({ width, height });
      await expectNoHorizontalScroll(page);
      await expectNoSeriousA11yViolations(page, `reading view, ${role}, ${width}`);
    }
  });
}
