import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Threat A17 (NFR-SEC-08; ACC-a Task 13): after the rebase onto unit/authz, AUTHZ's origin check is still the first
 * statement of every write handler both units edit. Read from the source with the TypeScript compiler API, so a
 * statement moved above it (an identity read, a body parse) is seen whatever the formatting.
 */

/** The exported handler `method` of `file`: a function declaration, or a const bound to a function. */
function handlerBody(file: string, text: string, method: string): ts.Block {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const st of source.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === method && st.body) return st.body;
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === method && d.initializer
          && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) && ts.isBlock(d.initializer.body)) {
          return d.initializer.body;
        }
      }
    }
  }
  throw new Error(`${file} exports no ${method} handler with a block body`);
}

/** The text of the handler's first statement, or of its leading try block's first statement. */
function firstStatementOf(file: string, method: string, text = readFileSync(file, 'utf8')): string {
  let body: ts.Block = handlerBody(file, text, method);
  // `let identity;` before a try that assigns it holds no work: skip bare declarations without initialisers.
  const work = body.statements.filter((s) => !(ts.isVariableStatement(s) && s.declarationList.declarations.every((d) => !d.initializer)));
  if (work.length > 0 && ts.isTryStatement(work[0])) body = work[0].tryBlock;
  const first = ts.isTryStatement(work[0]) ? body.statements[0] : work[0];
  if (first === undefined) throw new Error(`${file} ${method}: empty handler`);
  return first.getText().replace(/\s+/g, ' ');
}

describe('the origin check stays first after the rebase onto unit/authz (A17)', () => {
  it.each([
    ['app/api/users/me/route.ts', 'DELETE'], ['app/api/users/me/password/route.ts', 'POST'],
    ['app/api/users/me/sessions/route.ts', 'DELETE'], ['app/api/v1/invitations/[token]/route.ts', 'POST'],
    ['app/api/v1/invitations/[token]/register/route.ts', 'POST'], ['app/api/acceptances/route.ts', 'POST'],
  ])('NFR-SEC-08: assertSameOrigin is the first statement of each write handler ACC-a and AUTHZ share (%s %s)', (file, method) => {
    expect(firstStatementOf(file, method)).toMatch(/^assertSameOrigin\((req|request)\);?$/);
  });

  it('NFR-SEC-08 (self-test): a statement above the check is seen, in a function or a const handler', () => {
    const late = 'export async function POST(req) {\n  try {\n    const body = await req.json();\n    assertSameOrigin(req);\n  } catch (e) { return e; }\n}\n';
    expect(firstStatementOf('probe.ts', 'POST', late)).toBe('const body = await req.json();');
    const first = 'export const DELETE = async (request) => {\n  let identity;\n  try {\n    assertSameOrigin(request);\n  } catch (e) { return e; }\n};\n';
    expect(firstStatementOf('probe.ts', 'DELETE', first)).toBe('assertSameOrigin(request);');
  });
});
