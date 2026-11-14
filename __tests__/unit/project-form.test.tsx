import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PROJECT_FORM_COPY } from '@/lib/project/form/copy';

/**
 * Plan 1B Task 13: the project form's two sections, the toggle's two names, the Other text, the two dates as the kit's
 * DateField, the client's own check and the actions. The unit environment has no DOM: behaviour is shown through the pure
 * functions the form's module exports (the submission, the summary's link target) and through static markup; clicking
 * and focus are e2e/prj-screens.spec.ts.
 */
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), useParams: () => ({ slug: 'o' }) }));

const { default: ProjectForm, initialState, submissionOf, summaryTargetOf } = await import('@/components/project/ProjectForm');
const C = PROJECT_FORM_COPY;

const create = (over: Partial<ReturnType<typeof initialState>> = {}) => ({ ...initialState({ mode: 'create' }), name: 'P', ...over });
const edit = (over: Partial<ReturnType<typeof initialState>> = {}) =>
  ({ ...initialState({ mode: 'edit', projectId: 'p1', initial: { name: 'P', description: '' } }), ...over });
const bodyOf = (s: ReturnType<typeof submissionOf>) => {
  if (s.kind !== 'body') throw new Error(`expected a body, got ${JSON.stringify(s)}`);
  return s.body;
};

describe('case 1: the Other text (defect 21)', () => {
  it('is in the page only while AI system type is Other, directly after that select, labelled and with no limit or placeholder of its own', () => {
    expect(renderToStaticMarkup(<ProjectForm mode="create" />)).not.toContain('id="aiSystemTypeOther"');
    const html = renderToStaticMarkup(
      <ProjectForm mode="edit" projectId="p1" initial={{ name: 'P', description: '', aiSystemType: 'other', aiSystemTypeOther: 'Rules engine' }} />,
    );
    expect(html).toMatch(/<label[^>]*for="aiSystemTypeOther"[^>]*>Describe the type of AI system/);
    const input = html.match(/<input[^>]*id="aiSystemTypeOther"[^>]*>/)?.[0] ?? '';
    expect(input).toContain('value="Rules engine"');
    expect(input).toContain('type="text"');
    expect(input).not.toMatch(/maxlength|placeholder|\brequired\b/i);
    const selectEnd = html.indexOf('</select>', html.indexOf('id="aiSystemType"'));
    expect(selectEnd).toBeGreaterThan(-1);
    expect(html.indexOf('id="aiSystemTypeOther"')).toBeGreaterThan(selectEnd);
    expect(html.indexOf('id="aiSystemTypeOther"')).toBeLessThan(html.indexOf('id="description"'));
  });

  it('is sent trimmed while the type is Other; another type leaves it out on create and sends null on edit', () => {
    expect(bodyOf(submissionOf(create({ aiSystemType: 'other', aiSystemTypeOther: '  Rules engine ' }), false)).aiSystemTypeOther).toBe('Rules engine');
    expect(bodyOf(submissionOf(edit({ aiSystemType: 'other', aiSystemTypeOther: 'Rules engine' }), true)).aiSystemTypeOther).toBe('Rules engine');
    const switchedCreate = bodyOf(submissionOf(create({ aiSystemType: 'classification', aiSystemTypeOther: 'Rules engine' }), false));
    expect(switchedCreate).not.toHaveProperty('aiSystemTypeOther');
    expect(switchedCreate.aiSystemType).toBe('classification');
    expect(bodyOf(submissionOf(edit({ aiSystemType: 'classification', aiSystemTypeOther: 'Rules engine' }), true)).aiSystemTypeOther).toBeNull();
    expect(bodyOf(submissionOf(create({ aiSystemType: 'other', aiSystemTypeOther: '   ' }), false))).not.toHaveProperty('aiSystemTypeOther');
    expect(bodyOf(submissionOf(edit({ aiSystemType: 'other', aiSystemTypeOther: '' }), true)).aiSystemTypeOther).toBeNull();
  });

  it('starts from the stored value on edit', () => {
    expect(initialState({ mode: 'edit', projectId: 'p1', initial: { name: 'P', description: '', aiSystemTypeOther: 'Rules engine' } }).aiSystemTypeOther).toBe('Rules engine');
  });
});

describe('case 2: the toggle (defect 22)', () => {
  it('says Show more details, closed, on create and Hide more details, open, on edit, controlling #project-details', () => {
    expect(C.showDetails).toBe('Show more details');
    expect(C.hideDetails).toBe('Hide more details');
    const toggleOf = (html: string) => html.match(/<button[^>]*aria-controls="project-details"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? '';
    const created = toggleOf(renderToStaticMarkup(<ProjectForm mode="create" />));
    expect(created).toContain('aria-expanded="false"');
    expect(created).toContain(C.showDetails);
    const edited = toggleOf(renderToStaticMarkup(<ProjectForm mode="edit" projectId="p1" initial={{ name: 'P', description: '' }} />));
    expect(edited).toContain('aria-expanded="true"');
    expect(edited).toContain(C.hideDetails);
  });

  it('sits between two sections, About the project and More details (optional), each named by its h2', () => {
    const html = renderToStaticMarkup(<ProjectForm mode="create" />);
    const about = html.match(/<section[^>]*aria-labelledby="([^"]+)"[^>]*>\s*<h2[^>]*id="([^"]+)"[^>]*>About the project<\/h2>/);
    expect(about?.[1]).toBe(about?.[2]);
    const details = html.match(/<section[^>]*id="project-details"[^>]*>\s*<h2[^>]*id="([^"]+)"[^>]*>More details \(optional\)<\/h2>/);
    expect(details).not.toBeNull();
    expect(html).toMatch(new RegExp(`<section[^>]*aria-labelledby="${details?.[1]}"[^>]*id="project-details"|<section[^>]*id="project-details"[^>]*aria-labelledby="${details?.[1]}"`));
    const aboutAt = html.indexOf('About the project');
    expect(html.indexOf('id="name"')).toBeGreaterThan(aboutAt);
    expect(html.indexOf('id="description"')).toBeLessThan(html.indexOf('aria-controls="project-details"'));
    expect(html.indexOf('aria-controls="project-details"')).toBeLessThan(html.indexOf('id="project-details"'));
    expect(html).toContain(C.optional);
  });
});

describe('case 3: an empty name, the client\'s own check', () => {
  it('gives "Enter a project name." for the name field and sends nothing', () => {
    expect(submissionOf(create({ name: '   ' }), false)).toEqual({ kind: 'errors', errors: [{ field: 'name', message: 'Enter a project name.' }] });
  });

  it('the form leaves the check to itself: noValidate, and the name says it is required without the native attribute', () => {
    const html = renderToStaticMarkup(<ProjectForm mode="create" />);
    expect(html).toMatch(/<form[^>]*novalidate/i);
    const name = html.match(/<input[^>]*id="name"[^>]*>/)?.[0] ?? '';
    expect(name).toContain('aria-required="true"');
    expect(name).not.toMatch(/\srequired(=|\s|>)/);
    expect(html).toMatch(/<label[^>]*for="name"[^>]*>Project name[\s\S]*?\(required\)/);
  });
});

describe('case 4: the two dates', () => {
  it('are the kit\'s DateField: a fieldset with the legend and three labelled boxes, no Today button', () => {
    const html = renderToStaticMarkup(<ProjectForm mode="create" />);
    for (const [prefix, legend] of [['projectStart', C.labels.projectStart], ['projectEnd', C.labels.projectEnd]] as const) {
      expect(html).toMatch(new RegExp(`<fieldset[^>]*>\\s*<legend[^>]*>${legend}</legend>`));
      for (const part of ['day', 'month', 'year']) expect(html).toMatch(new RegExp(`<label[^>]*for="${prefix}-${part}"`));
    }
    expect(html).not.toContain('>Today<');
  });

  it('an incomplete date or one the calendar does not have gives the field its error and sends nothing', () => {
    const half = submissionOf(create({ projectStart: { day: '1', month: '', year: '2026' } }), false);
    expect(half).toEqual({ kind: 'errors', errors: [{ field: 'projectStart', message: 'Enter a real date, or leave the date empty.' }] });
    const feb30 = submissionOf(edit({ name: 'P', projectEnd: { day: '30', month: '2', year: '2027' } }), true);
    expect(feb30).toEqual({ kind: 'errors', errors: [{ field: 'projectEnd', message: C.dateInvalid }] });
  });

  it('name and date errors found in one submit come together, name first', () => {
    const both = submissionOf(create({ name: '', projectStart: { day: '', month: '9', year: '' }, projectEnd: { day: '31', month: '4', year: '2027' } }), false);
    expect(both.kind === 'errors' ? both.errors.map((e) => e.field) : []).toEqual(['name', 'projectStart', 'projectEnd']);
  });

  it('a whole date is sent as YYYY-MM-DD; no date is left out on create and null on edit; the edit form starts from the stored date', () => {
    expect(bodyOf(submissionOf(create({ projectStart: { day: '1', month: '9', year: '2026' } }), false)).projectStart).toBe('2026-09-01');
    expect(bodyOf(submissionOf(create(), false))).not.toHaveProperty('projectEnd');
    expect(bodyOf(submissionOf(edit({ name: 'P' }), true)).projectEnd).toBeNull();
    const s = initialState({ mode: 'edit', projectId: 'p1', initial: { name: 'P', description: '', projectStart: '2026-09-01', projectEnd: null } });
    expect(s.projectStart).toEqual({ day: '1', month: '9', year: '2026' });
    expect(s.projectEnd).toEqual({ day: '', month: '', year: '' });
  });

  it('the summary links a date to its day box, and every other field to its own id', () => {
    expect(summaryTargetOf('projectStart')).toBe('projectStart-day');
    expect(summaryTargetOf('projectEnd')).toBe('projectEnd-day');
    expect(summaryTargetOf('name')).toBe('name');
    expect(summaryTargetOf('deploymentSector')).toBe('deploymentSector');
  });
});

describe('cases 5 and 6, and the actions', () => {
  it('case 5: the heading is "New project", in sentence case', () => {
    expect(renderToStaticMarkup(<ProjectForm mode="create" />)).toMatch(/<h1[^>]*>New project<\/h1>/);
  });

  it('case 6: no placeholder names a country', () => {
    const html = renderToStaticMarkup(<ProjectForm mode="edit" projectId="p1" initial={{ name: 'P', description: '', aiSystemType: 'other' }} />);
    const placeholders = [...html.matchAll(/placeholder="([^"]*)"/g)].map((m) => m[1]);
    expect(placeholders.length).toBeGreaterThan(0);
    const countries = /Uganda|Kenya|Tanzania|Rwanda|Nigeria|Ghana|Ethiopia|South Africa|Burundi|Malawi|Zambia|Sudan|Germany|United (Kingdom|States)|Europe|Africa/i;
    for (const p of [...placeholders, ...Object.values(C.placeholders)]) expect(p).not.toMatch(countries);
  });

  it('the primary button comes first, then Cancel as a quiet link to Projects (create) or the project (edit)', () => {
    const created = renderToStaticMarkup(<ProjectForm mode="create" />);
    const actions = created.slice(created.indexOf('form-actions'));
    expect(actions.indexOf('>Create project<')).toBeGreaterThan(-1);
    expect(actions.indexOf('>Create project<')).toBeLessThan(actions.indexOf('>Cancel<'));
    expect(actions).toMatch(/<a[^>]*class="ui-button ui-button--quiet"[^>]*href="\/orgs\/o\/projects"[^>]*>Cancel<\/a>|<a[^>]*href="\/orgs\/o\/projects"[^>]*class="ui-button ui-button--quiet"[^>]*>Cancel<\/a>/);
    const edited = renderToStaticMarkup(<ProjectForm mode="edit" projectId="p1" initial={{ name: 'P', description: '' }} />);
    expect(edited).toMatch(/href="\/orgs\/o\/projects\/p1"[^>]*>Cancel</);
  });
});
