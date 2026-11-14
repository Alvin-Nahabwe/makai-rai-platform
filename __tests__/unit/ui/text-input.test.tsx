import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createRef, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TextInput } from '@/components/ui/TextInput';
import { textOf } from '@/__tests__/helpers/markup';

/** Plan 1A Task 4: TextInput (B5 errors; hint above the field, modern-web-guidance validate-input-after-interaction). */

const inputOf = (html: string) => html.match(/<input [^>]*>/)?.[0] ?? '';

describe('TextInput', () => {
  it('labels the input and renders the hint before it', () => {
    const html = renderToStaticMarkup(<TextInput id="email" name="email" label="Email address" hint="The one you sign in with." />);
    expect(html).toMatch(/<label class="ui-field__label" for="email">Email address<\/label>/);
    expect(html.indexOf('id="email-hint"')).toBeGreaterThan(-1);
    expect(html.indexOf('id="email-hint"')).toBeLessThan(html.indexOf('<input'));
  });

  it('with an error: aria-invalid true, described by the hint then the error, the error after an aria-hidden icon', () => {
    const html = renderToStaticMarkup(<TextInput id="email" name="email" label="Email address" hint="Hint" error="Enter an email address." />);
    const input = inputOf(html);
    expect(input).toContain('aria-invalid="true"');
    expect(input).toContain('aria-describedby="email-hint email-error"');
    expect(html).toMatch(/<p class="ui-field__error"><svg [^>]*aria-hidden="true"[\s\S]*?<span class="visually-hidden">Error: <\/span><span id="email-error">Enter an email address\.<\/span><\/span><\/p>/);
    // The protected tests' own form (__tests__/unit/decision-components.test.tsx:114): the id holds the message alone.
    expect(html).toMatch(/id="email-error"[^>]*>Enter an email address\.</);
    expect(input).toContain('ui-input--invalid');
  });

  it('without an error: aria-invalid false, described by the hint alone, or by nothing', () => {
    const withHint = inputOf(renderToStaticMarkup(<TextInput id="n" name="n" label="Name" hint="Hint" />));
    expect(withHint).toContain('aria-invalid="false"');
    expect(withHint).toContain('aria-describedby="n-hint"');
    expect(inputOf(renderToStaticMarkup(<TextInput id="n" name="n" label="Name" />))).not.toContain('aria-describedby');
  });

  it('an empty error or a false hint draws nothing and describes nothing', () => {
    const html = renderToStaticMarkup(<TextInput id="n" name="n" label="Name" hint={false} error="" />);
    expect(html).not.toMatch(/ui-field__hint|ui-field__error/);
    expect(inputOf(html)).toContain('aria-invalid="false"');
    expect(inputOf(html)).not.toContain('aria-describedby');
  });

  it('marks a required field in its label and on the input', () => {
    const html = renderToStaticMarkup(<TextInput id="r" name="r" label="Reason" required />);
    expect(textOf(html.match(/<label[\s\S]*<\/label>/)?.[0] ?? '')).toBe('Reason (required)');
    expect(inputOf(html)).toContain('required=""');
  });

  it('passes type, autoComplete, inputMode, maxLength, value, readOnly, spellCheck and disabled to the input', () => {
    const input = inputOf(renderToStaticMarkup(
      <TextInput id="p" name="p" label="Password" type="password" autoComplete="current-password" inputMode="text" maxLength={64}
        defaultValue="" readOnly spellCheck={false} disabled />,
    ));
    expect(input).toContain('type="password"');
    expect(input).toContain('autoComplete="current-password"');
    expect(input).toContain('inputMode="text"');
    expect(input).toContain('maxLength="64"');
    expect(input).toContain('readOnly=""');
    expect(input).toContain('spellCheck="false"');
    expect(input).toContain('disabled=""');
    expect(input).toContain('ui-input--readonly');
  });

  it('a password\'s value appears only in its own value attribute', () => {
    const html = renderToStaticMarkup(<TextInput id="p" name="p" label="Password" type="password" defaultValue="s3cret-value" hint="At least 12 characters." />);
    expect(html.match(/s3cret-value/g)).toHaveLength(1);
    expect(inputOf(html)).toContain('value="s3cret-value"');
  });

  it('sets its width class', () => {
    expect(inputOf(renderToStaticMarkup(<TextInput id="w" name="w" label="Code" width="short" />))).toContain('class="ui-input ui-input--short"');
    expect(inputOf(renderToStaticMarkup(<TextInput id="w" name="w" label="Code" width="medium" />))).toContain('class="ui-input ui-input--medium"');
  });

  it('attaches a ref passed as a prop to the <input> (React 19)', async () => {
    const ref = createRef<HTMLInputElement>();
    const element = <TextInput id="x" name="x" label="X" ref={ref} />;
    // Server rendering never attaches refs; read what the component passes to the host element instead.
    const host = (element.type as (p: typeof element.props) => ReactElement)(element.props);
    const input = findHost(host, 'input');
    expect(input?.props.ref).toBe(ref);
  });
});

type Host = { type: unknown; props: Record<string, unknown> & { children?: unknown } };

/** The first host element of tag `tag` in a rendered element tree (one level of function components already applied). */
function findHost(node: unknown, tag: string): Host | undefined {
  if (node === null || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findHost(child, tag);
      if (found) return found;
    }
    return undefined;
  }
  const el = node as Host;
  if (el.type === tag) return el;
  return findHost(el.props?.children, tag);
}

const ROOT = process.cwd();

/** The file an import specifier names, or null for a package. `@/` is the repository root. */
function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith('@/') ? join(ROOT, spec.slice(2)) : spec.startsWith('.') ? join(dirname(from), spec) : null;
  if (base === null) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`${relative(ROOT, from)}: cannot resolve ${spec}`);
}

/** Every repository file `entry` reaches through static imports and re-exports; only .ts and .tsx files are followed. */
function reached(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [join(ROOT, entry)];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.tsx?$/.test(file)) continue;
    for (const m of readFileSync(file, 'utf8').matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/g)) {
      const target = resolveImport(file, m[1]);
      if (target !== null) queue.push(target);
    }
  }
  return new Set([...seen].map((f) => relative(ROOT, f)));
}

describe('the form fields\' import weight', () => {
  // RadioCards and DateField are left out on purpose: each needs other words of UI_COPY (RadioCards draws StatusMark's
  // shapes, and StatusMark.tsx imports the marks' words; DateField has its own date words), so they reach lib/ui/copy.ts.
  it("NFR-PERF-02: the kit's text field and the fields built on its parts do not load the kit's whole word list", () => {
    const roots = ['TextInput', 'TextArea', 'Checkbox', 'Select', 'ErrorSummary', 'StatusRegion', 'Button'].map((n) => `components/ui/${n}.tsx`);
    expect(roots.filter((root) => reached(root).has('lib/ui/copy.ts'))).toEqual([]);
    expect(reached('components/ui/TextInput.tsx').has('lib/ui/field/copy.ts')).toBe(true);
  });
});
