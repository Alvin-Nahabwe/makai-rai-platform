/**
 * Shared session-mocking seam for integration tests that drive REAL route
 * handlers with a REAL session. `requireIdentityForApi` (lib/auth/
 * identity.ts) dynamically imports `../auth` (== lib/auth.ts) and calls its
 * `auth()` export — mocking that module is the only seam available without
 * a real browser/cookie jar (see `__tests__/integration/permission-matrix.
 * test.ts`'s own comment, which established this pattern first).
 *
 * Factored out at the final Plan 1b review's simplify pass: the
 * `currentSession` var + `vi.mock('../../lib/auth', ...)` + `sessionFor()`
 * triad had been copy-pasted verbatim into four test files
 * (permission-matrix.test.ts, password-gate.test.ts, and two new files in
 * this fix wave) with no shared helper, despite each file's own comments
 * noting it was reusing "the same seam". This module is a NEW consumer for
 * new tests only — the two pre-existing files are left as they are
 * (out of this fix wave's scope; refactoring already-passing, unrelated
 * test files is not one of the four findings this wave closes).
 *
 * NOTE ON vi.mock HOISTING: a bare `vi.mock(...)` call is normally hoisted
 * to the top of the FILE THAT CONTAINS IT by Vitest's transform, so a mock
 * factored into a helper module still registers correctly here because
 * `resolveFromSession` resolves `../auth` with a DYNAMIC `import()` at
 * CALL TIME (inside the route handler, well after test setup), not via a
 * static import graph that must already be rewritten before any file
 * loads. Any test file that imports `mockAuthSession` before invoking a
 * route handler gets the mock in effect regardless of import order.
 */
import { vi } from 'vitest';

type MockSession = { user: { id: string }; sessionEpoch: number; sessionIssuedAt: number } | null;

let currentSession: MockSession = null;

vi.mock('../../lib/auth', () => ({
  auth: () => Promise.resolve(currentSession),
}));

/** Sets the session `auth()` returns for every subsequent call, until the
 * next `sessionFor`/`clearSession` call. */
export function sessionFor(userId: string): void {
  currentSession = { user: { id: userId }, sessionEpoch: 0, sessionIssuedAt: Math.floor(Date.now() / 1000) };
}

/** Simulates "no session" (anonymous caller). Call in `beforeEach` so state
 * never leaks between tests. */
export function clearSession(): void {
  currentSession = null;
}
