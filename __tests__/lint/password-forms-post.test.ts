import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

/**
 * NFR-SEC password-in-URL (unit FIXPW). A `<form>` with no `method` submits as GET. If a person presses Sign in before
 * React has hydrated, the browser then sends `GET /login?email=...&password=...`, and the password reaches history,
 * the address bar, any later Referer and the nginx error log. Two rules: every `<form>` or `<Form>` under app and
 * components names an explicit `method`, so GET is a visible choice (components/decision/StageQuestionList.tsx's search
 * form is one); and every form in a file with a password input names `method="post"`, so an early native submit sends a
 * body to the page's own URL instead.
 */

const PASSWORD_INPUT = /type=["']password["']|['"]password['"]\s*\}|autoComplete=["'](?:current|new)-password["']/;
const POST = /\smethod=["']post["']/i;
const ANY_METHOD = /\smethod=["'](?:get|post)["']/i;

/** The opening tags `<form ...>` of a source text; a `>` that closes an arrow (`=>`) does not end the tag. */
export function formOpeningTags(src: string): string[] {
  const tags: string[] = [];
  for (const m of src.matchAll(/<[Ff]orm(?=[\s>])/g)) {
    let i = (m.index ?? 0) + 5;
    let braces = 0;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '{') braces++;
      else if (c === '}') braces--;
      else if (c === '>' && braces === 0) break;
    }
    tags.push(src.slice(m.index, i + 1));
  }
  return tags;
}

/** The `<form` tags (any file) with no explicit `method`: `file: tag`. */
export function formsWithoutMethod(files: Record<string, string>): string[] {
  const bad: string[] = [];
  for (const [file, src] of Object.entries(files)) for (const tag of formOpeningTags(src)) if (!ANY_METHOD.test(tag)) bad.push(`${file}: ${tag}`);
  return bad.sort();
}

/** The `<form` tags that lack `method="post"`, in files that hold a password input: `file: tag`. */
export function passwordFormsWithoutPost(files: Record<string, string>): string[] {
  const bad: string[] = [];
  for (const [file, src] of Object.entries(files))
    if (PASSWORD_INPUT.test(src))
      for (const tag of formOpeningTags(src)) if (!POST.test(tag)) bad.push(`${file}: ${tag}`);
  return bad.sort();
}

function sources(dirs: string[]): Record<string, string> {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', ...dirs], { encoding: 'utf8' });
  const files = out.split('\n').filter((f) => /\.(tsx|jsx)$/.test(f) && existsSync(f));
  // A scan over no files would pass for nothing.
  expect(files.length, 'component files under app and components').toBeGreaterThan(50);
  return Object.fromEntries(files.map((f) => [f, readFileSync(f, 'utf8')]));
}

it('NFR-SEC: every form in a file with a password input names method="post" (no password in the URL)', () => {
  const all = sources(['app', 'components']);
  const withPassword = Object.entries(all).filter(([, s]) => PASSWORD_INPUT.test(s)).map(([f]) => f);
  // The four auth forms; the account-deletion confirmation has a password input and no native form.
  expect(withPassword.length).toBeGreaterThanOrEqual(5);
  expect(passwordFormsWithoutPost(all)).toEqual([]);
});

it('NFR-SEC: every form under app and components names an explicit method', () => {
  expect(formsWithoutMethod(sources(['app', 'components']))).toEqual([]);
});

it('NFR-SEC (harness): flags a bare form, a GET form and an arrow-handler form; accepts method="post"', () => {
  const pw = '<input type="password" />';
  expect(passwordFormsWithoutPost({ 'a.tsx': `<form onSubmit={v.onSubmit}>${pw}` })).toHaveLength(1);
  expect(passwordFormsWithoutPost({ 'a.tsx': `<form method="get" onSubmit={(e) => go(e)}>${pw}` })).toHaveLength(1);
  expect(passwordFormsWithoutPost({ 'a.tsx': `<form onSubmit={(e) => go(e)} noValidate>${pw}` })).toHaveLength(1);
  expect(passwordFormsWithoutPost({ 'a.tsx': `<form method="post" onSubmit={(e) => go(e)}>${pw}` })).toEqual([]);
  expect(passwordFormsWithoutPost({ 'a.tsx': `<form onSubmit={x}><input autoComplete="new-password" />` })).toHaveLength(1);
  expect(passwordFormsWithoutPost({ 'a.tsx': '<form onSubmit={x}><input type="text" />' })).toEqual([]);
  expect(formsWithoutMethod({ 'a.tsx': '<form onSubmit={x}>' })).toHaveLength(1);
  expect(formsWithoutMethod({ 'a.tsx': '<Form action="/x">' })).toHaveLength(1);
  expect(formsWithoutMethod({ 'a.tsx': '<form method="get" aria-label="s">' })).toEqual([]);
  expect(formsWithoutMethod({ 'a.tsx': '<FormField id="x" />' })).toEqual([]);
  // A method that is not a literal (a variable or an expression) is not an explicit choice.
  expect(formsWithoutMethod({ 'a.tsx': '<form method={m} onSubmit={x}>' })).toHaveLength(1);
});
