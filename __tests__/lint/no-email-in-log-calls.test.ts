import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// Loaded with require so Vite does not try to read typescript's source map.
const ts = createRequire(__filename)('typescript') as typeof import('typescript');
type TsNode = import('typescript').Node;
type TsSourceFile = import('typescript').SourceFile;

/**
 * P1 (RL 2.3, 7.12): no email address in any server log line.
 *
 * The run-time layers (`logSecurityEvent` and `installConsoleRedaction`, tested in
 * `__tests__/unit/redact.test.ts`) redact what they are handed. This file is the layer
 * before them: it stops a call from naming an email in the first place, because a
 * redactor is a net and the audit trail should not depend on it for the ordinary case.
 *
 * WHAT THIS CAN AND CANNOT SHOW. It reads the source as a syntax tree and looks at
 * NAMES: a property called `email`, `invitedEmail`, a variable called `userEmail`. It
 * cannot see a value, so an address carried inside `error: e.message` is not found here;
 * that case is the redactor's, and `redact.test.ts` proves it.
 *
 * The call sites are FOUND, not listed: every file under `app/` and `lib/`, plus
 * `proxy.ts`, is parsed on every run, so a call added tomorrow is checked tomorrow.
 * A wrapper around `logSecurityEvent` (the evidence route's `logSafely`) is found by its
 * parameter type, so the wrapper's callers are checked too.
 */

const ROOT = path.join(__dirname, '../..');
// prisma/seed.ts runs in the migrator container, whose output also reaches the host journal.
const SCANNED = ['app', 'lib', 'proxy.ts', 'instrumentation.ts', 'prisma/seed.ts'];

function walk(rel: string, out: string[] = []): string[] {
  const abs = path.join(ROOT, rel);
  if (statSync(abs).isFile()) {
    if (/\.(ts|tsx)$/.test(rel)) out.push(rel);
    return out;
  }
  for (const name of readdirSync(abs)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    walk(path.join(rel, name), out);
  }
  return out;
}

const FILES = SCANNED.flatMap((r) => walk(r)).sort();

function parse(rel: string, source = readFileSync(path.join(ROOT, rel), 'utf8')): TsSourceFile {
  return ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true, rel.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/** Names that can carry an address. Case-insensitive, anywhere in the identifier. */
const EMAIL_NAME = /e-?mail/i;

type Finding = { file: string; line: number; what: string };

/**
 * Names of functions that forward their arguments to `logSecurityEvent`: any function
 * declared with a parameter typed `Parameters<typeof logSecurityEvent>`.
 */
function wrapperNames(sf: TsSourceFile): string[] {
  const names: string[] = [];
  const visit = (n: TsNode): void => {
    if (ts.isFunctionDeclaration(n) && n.name && n.parameters.some((p) => p.type?.getText(sf).includes('typeof logSecurityEvent'))) {
      names.push(n.name.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return names;
}

/** Every identifier, property name and string key in `node` that looks like an email. */
function emailNamesIn(node: TsNode, sf: TsSourceFile): Finding[] {
  const found: Finding[] = [];
  const at = (n: TsNode, what: string): void => {
    found.push({ file: sf.fileName, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, what });
  };
  const visit = (n: TsNode): void => {
    // A string literal VALUE such as 'invite_email_failed' is a label, not a field.
    // A string literal used as a KEY is a field name, and ts reports it as the name of a
    // PropertyAssignment, which is handled where the assignment is.
    if (ts.isIdentifier(n) && EMAIL_NAME.test(n.text)) at(n, `identifier \`${n.text}\``);
    if (ts.isPropertyAssignment(n) && (ts.isStringLiteral(n.name) || ts.isNoSubstitutionTemplateLiteral(n.name)) && EMAIL_NAME.test(n.name.text)) {
      at(n, `key "${n.name.text}"`);
    }
    if (ts.isComputedPropertyName(n)) at(n, 'a computed key, whose name cannot be checked');
    // `...ctx` or `...details`: whatever it holds cannot be seen here. A spread of an
    // inline conditional object, `...(userId ? { userId } : {})`, contains literals and
    // is walked as usual.
    if (ts.isSpreadAssignment(n)) {
      let hasLiteral = false;
      const look = (m: TsNode): void => {
        if (ts.isObjectLiteralExpression(m)) hasLiteral = true;
        ts.forEachChild(m, look);
      };
      look(n.expression);
      if (!hasLiteral) at(n, `a spread of \`${n.expression.getText(sf)}\`, whose fields cannot be checked`);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** Every call to `logSecurityEvent` (or a wrapper of it) in `sf`, and what is wrong with its arguments. */
function inspect(sf: TsSourceFile, wrappers: string[] = []): { calls: number; findings: Finding[] } {
  const callees = new Set(['logSecurityEvent', ...wrapperNames(sf), ...wrappers]);
  let calls = 0;
  const findings: Finding[] = [];
  const visit = (n: TsNode): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && callees.has(n.expression.text)) {
      calls += 1;
      for (const arg of n.arguments) findings.push(...emailNamesIn(arg, sf));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { calls, findings };
}

describe('logSecurityEvent call sites', () => {
  it('no logSecurityEvent call passes an email-named field', () => {
    let calls = 0;
    const findings: Finding[] = [];
    const files = new Set<string>();
    for (const rel of FILES) {
      const r = inspect(parse(rel));
      if (r.calls > 0) files.add(rel);
      calls += r.calls;
      findings.push(...r.findings);
    }

    // Non-vacuous: the walk found the call sites it is meant to be checking. The floor is
    // the number of calls on 2026-10-08; it may rise and must never silently fall to nothing.
    expect(calls, 'found almost no call sites, so this would pass over an empty set').toBeGreaterThanOrEqual(25);
    expect([...files], 'the sign-in path logs through logSecurityEvent').toContain('lib/auth/credentials.ts');
    expect([...files]).toContain('proxy.ts');
    expect([...files]).toContain('app/api/v1/orgs/[slug]/members/route.ts');

    expect(
      findings.map((f) => `${f.file}:${f.line}  ${f.what}`),
      'a logSecurityEvent call names an email. Log the id (userId, invitationId, orgId) instead',
    ).toEqual([]);
  });

  it('the detector finds an email-named field, so a clean result above means something', () => {
    const bad = parse(
      'probe.ts',
      `import { logSecurityEvent } from '@/lib/security-logger';
       const email = 'x'; const invitation = { email: 'y' };
       logSecurityEvent('AUTH_REGISTER', 'info', { details: { email } });
       logSecurityEvent('AUTH_REGISTER', 'info', { details: { who: invitation.email } });
       logSecurityEvent('AUTH_REGISTER', 'info', { details: { invitedEmail: 'z' } });
       logSecurityEvent('AUTH_REGISTER', 'info', { details: { 'user-email': 'z' } });
       logSecurityEvent('AUTH_REGISTER', 'info', { details: { [k]: 'z' } });
       logSecurityEvent('AUTH_REGISTER', 'info', { ...ctx });`,
    );
    const r = inspect(bad);
    expect(r.calls).toBe(6);
    // One finding per call: the shorthand `email`, `invitation.email`, `invitedEmail`,
    // the string key, the computed key, and the opaque spread.
    expect(r.findings.map((f) => f.line).sort()).toEqual([3, 4, 5, 6, 7, 8]);
  });

  it('the detector follows a wrapper to its callers', () => {
    const sf = parse(
      'probe.ts',
      `function logSafely(...args: Parameters<typeof logSecurityEvent>): void { logSecurityEvent(...args); }
       logSafely('AUTH_REGISTER', 'info', { details: { email } });`,
    );
    expect(wrapperNames(sf)).toEqual(['logSafely']);
    expect(inspect(sf).findings).toHaveLength(1);
  });

  it('the detector lets a label that merely contains the word through', () => {
    const ok = parse(
      'probe.ts',
      `logSecurityEvent('ORG_MEMBER_ACTION', 'error', { details: { action: 'invite_email_failed', ...(userId ? { userId } : {}) } });`,
    );
    expect(inspect(ok)).toEqual({ calls: 1, findings: [] });
  });
});

describe('what reaches the console', () => {
  it('our own code never writes to a stream, or calls a console method the redaction does not wrap', () => {
    // installConsoleRedaction wraps console.log, info, warn and error. Anything that
    // bypasses those four bypasses the redaction, so our own code must not.
    const bypass: string[] = [];
    for (const rel of FILES) {
      const sf = parse(rel);
      const visit = (n: TsNode): void => {
        if (ts.isPropertyAccessExpression(n)) {
          const text = n.getText(sf);
          if (/^process\.(stdout|stderr)$/.test(text)) bypass.push(`${rel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}  ${text}`);
          if (ts.isIdentifier(n.expression) && n.expression.text === 'console' && !['log', 'info', 'warn', 'error'].includes(n.name.text)) {
            bypass.push(`${rel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}  console.${n.name.text}`);
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(bypass, 'these bypass installConsoleRedaction').toEqual([]);
  });
});

describe('postgres', () => {
  const COMPOSE = readFileSync(path.join(ROOT, 'docker/docker-compose.prod.yml'), 'utf8');

  /** The lines of one service, by indentation, as the neighbouring compose tests read the file. */
  function service(name: string): string[] {
    const lines = COMPOSE.split('\n');
    const start = lines.findIndex((l) => l === `  ${name}:`);
    expect(start, `no ${name} service in the production compose file`).toBeGreaterThan(-1);
    const out: string[] = [];
    for (const l of lines.slice(start + 1)) {
      if (/^ {0,2}\S/.test(l)) break; // the next service, or a top-level key
      out.push(l);
    }
    return out;
  }

  it('postgres logs terse errors', () => {
    // `log_error_verbosity=terse` drops the DETAIL line, which is where Postgres prints
    // `Key (email)=(someone@example.org) already exists`. It drops HINT, QUERY and CONTEXT
    // from every message too, which is the price: server-log-only diagnosis (an auth
    // failure's pg_hba.conf line, a deadlock's participants) now needs `\set VERBOSITY
    // verbose` on a client that reproduces it. The primary message and STATEMENT stay.
    const body = service('postgres');
    const command = body.find((l) => /^ {4}command:/.test(l));
    expect(command, 'the postgres service has no `command:`').toBeDefined();
    const words = JSON.parse((command as string).replace(/^ {4}command:\s*/, '').replace(/'/g, '"')) as string[];
    expect(words[0], 'the image entrypoint needs `postgres` first').toBe('postgres');
    const at = words.indexOf('-c');
    expect(at).toBeGreaterThan(0);
    expect(words.slice(at, at + 2)).toEqual(['-c', 'log_error_verbosity=terse']);
  });

  it('keeps the image pinned by digest beside the command', () => {
    // compose-image-pins.test.ts owns the pin; this makes sure adding a `command:` did
    // not move it.
    const image = service('postgres').find((l) => /^ {4}image:/.test(l));
    expect(image).toMatch(/^ {4}image: postgres:16-alpine@sha256:[0-9a-f]{64}$/);
  });
});
