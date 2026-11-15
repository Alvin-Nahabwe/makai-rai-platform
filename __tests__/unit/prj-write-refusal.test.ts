import { describe, expect, it } from 'vitest';
import { FORBIDDEN_LINE, GONE_LINE, formRefusalOf, refusalOf } from '@/lib/projects/writeRefusal';
import { PROJECT_WRITE_COPY } from '@/lib/project/write/copy';
import { PROJECT_FORM_COPY } from '@/lib/project/form/copy';
import { PROJECT_FIELD_MESSAGES } from '@/lib/projects/copy';

/**
 * PRJ F8 and SPEC-2: what each of the three project writers (the form, Archive, Unarchive) does with a refusal, as pure
 * decisions the components follow, so each branch is tested without a browser (the repository has no DOM test library).
 */
describe('Archive and Unarchive: what a refusal means (F8, C4 re-review 1)', () => {
  it('UX-27 F8: a 401 sends the person to sign in', () => {
    expect(refusalOf(401)).toEqual({ kind: 'signin' });
  });

  it('UX-27 F8: a 403 stops with its line and does not refresh, because the refresh unmounts the control and the line with it', () => {
    expect(refusalOf(403)).toEqual({ kind: 'stop', line: PROJECT_WRITE_COPY.forbidden });
    expect(FORBIDDEN_LINE).toBe('You can no longer change this project. Ask an Owner or Admin if you need to.');   // the ruled text (B#370), pinned once
  });

  it('UX-27 F8: a 404 stops with its line and does not refresh', () => {
    expect(refusalOf(404)).toEqual({ kind: 'stop', line: PROJECT_WRITE_COPY.gone });
    expect(GONE_LINE).toBe('This project no longer exists.');   // the ruled text (B#371), pinned once
  });

  it('UX-27: another state (409) refreshes with no line; a server error or a limit offers Retry', () => {
    expect(refusalOf(409)).toEqual({ kind: 'refresh' });
    for (const status of [429, 500, 502, 503]) expect(refusalOf(status)).toEqual({ kind: 'again' });
  });
});

describe('The project form: what a refusal means (F8, SPEC-2)', () => {
  const body = (over: object = {}) => ({ error: 'x', code: 'validation', ...over });

  it('SPEC-2: a 422 keeps each message beside its field and also gives the summary', () => {
    const r = formRefusalOf(422, body({ fields: [{ field: 'name', message: 'Project name is required' }, { field: 'description', message: 'Description must be 2000 characters or fewer' }] }));
    expect(r).toEqual({
      kind: 'fields', openDetails: false,
      fields: [{ field: 'name', message: 'Project name is required' }, { field: 'description', message: 'Description must be 2000 characters or fewer' }],
      summary: PROJECT_WRITE_COPY.summary(2),
    });
  });

  it('SPEC-2: one problem says "There is a problem"; a field in the additional details opens that section', () => {
    const r = formRefusalOf(422, body({ fields: [{ field: 'deploymentSector', message: PROJECT_FIELD_MESSAGES.textMax(200) }] }));
    expect(r).toMatchObject({ kind: 'fields', openDetails: true, summary: PROJECT_WRITE_COPY.summary(1) });
  });

  it('SPEC-2: a field the form has no control for is still in the summary and opens nothing', () => {
    const r = formRefusalOf(422, body({ fields: [{ field: 'requestId', message: 'requestId must be a UUID' }] }));
    expect(r).toMatchObject({ kind: 'fields', openDetails: false });
  });

  it('F8: 401 signs in, 403 and 404 stop with their lines and a fresh request id, an archived project says so, anything else is "try again"', () => {
    expect(formRefusalOf(401, body({ code: 'unauthorized' }))).toEqual({ kind: 'signin' });
    expect(formRefusalOf(403, body({ code: 'forbidden' }))).toEqual({ kind: 'stop', line: FORBIDDEN_LINE });
    expect(formRefusalOf(404, body({ code: 'not_found' }))).toEqual({ kind: 'stop', line: GONE_LINE });
    expect(formRefusalOf(409, body({ code: 'project_archived' }))).toEqual({ kind: 'stop', line: PROJECT_WRITE_COPY.archivedForm });
    expect(formRefusalOf(500, body({ code: 'internal_error' }))).toEqual({ kind: 'again', line: PROJECT_WRITE_COPY.tryAgain });
  });
});

describe('The three writers when the outcome is not known (CONSOLIDATED 8 #7; the ruled texts, pinned once)', () => {
  it('UX-27: Archive and Unarchive say the action may already have happened, and that Retry will not do it twice', () => {
    expect(PROJECT_WRITE_COPY.archive.lost).toBe('Not archived yet. We did not get a reply in time, so it may already be archived. Select Retry. It will not archive twice.');
    expect(PROJECT_WRITE_COPY.unarchive.lost).toBe('Not unarchived yet. We did not get a reply in time, so it may already be unarchived. Select Retry. It will not unarchive twice.');
  });

  it('UX-27: the project form names its own button, and says the project or the changes may already be saved', () => {
    expect(PROJECT_FORM_COPY.noReply.create).toBe('Not created yet. We did not get a reply in time, so the project may already be created. Select Create project again.');
    expect(PROJECT_FORM_COPY.noReply.save).toBe('Not saved yet. We did not get a reply in time, so your changes may already be saved. Select Save changes again. It will not be saved twice.');
  });
});
