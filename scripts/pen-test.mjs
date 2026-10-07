#!/usr/bin/env node

/**
 * Automated penetration test script.
 * Tests security hardening layers against http://localhost:3000.
 * Run: node scripts/pen-test.mjs
 *
 * Uses only Node.js built-in fetch (Node 18+). No external dependencies.
 */

const DEFAULT_BASE_URL = 'http://localhost:3000';
const BASE_URL = process.env.TEST_URL || DEFAULT_BASE_URL;

let passed = 0;
let failed = 0;
let skipped = 0;

async function test(name, fn) {
  try {
    const result = await fn();
    // A case skips by returning 'skip', or `{ skip: '<why>' }` to print the reason.
    // Either way it counts as skipped, never as passed.
    if (result === 'skip' || (result && typeof result === 'object' && 'skip' in result)) {
      skipped++;
      console.log(`  ⚪ SKIP: ${name}${typeof result === 'object' ? ` (${result.skip})` : ''}`);
    } else {
      passed++;
      console.log(`  ✅ PASS: ${name}`);
    }
  } catch (err) {
    failed++;
    console.log(`  ❌ FAIL: ${name}`);
    console.log(`         ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomEmail() {
  return `pentest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.com`;
}

function registrationBody(overrides = {}) {
  return JSON.stringify({
    name: overrides.name ?? 'Pen Tester',
    email: overrides.email ?? randomEmail(),
    orgName: overrides.orgName ?? 'Pen Test Org',
    password: overrides.password ?? 'S3cure!Pass99',
    termsAccepted: true,
    researchConsent: false,
    ...overrides,
  });
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

// ---------------------------------------------------------------------------
// Test 1: Rate Limiting on Registration (limit: 5 per 15 min)
// ---------------------------------------------------------------------------

async function testRateLimitRegister() {
  const results = [];

  // Send 10 rapid requests — limit is 5, so we should hit 429
  const requests = Array.from({ length: 10 }, () =>
    fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: registrationBody(),
    }).then((r) => ({
      status: r.status,
      remaining: r.headers.get('X-RateLimit-Remaining'),
    }))
  );

  const responses = await Promise.allSettled(requests);
  for (const r of responses) {
    if (r.status === 'fulfilled') results.push(r.value);
  }

  const got429 = results.some((r) => r.status === 429);
  const remainingZero = results.some((r) => r.remaining === '0');

  assert(
    got429 || remainingZero,
    `Expected 429 or X-RateLimit-Remaining=0, got statuses: [${results.map((r) => r.status).join(', ')}]`,
  );
}

// ---------------------------------------------------------------------------
// Test 2: Rate Limiting on Login (limit: 15 per 15 min)
// ---------------------------------------------------------------------------

async function testRateLimitLogin() {
  const results = [];

  // Send 20 rapid requests — limit is 15, so we should hit 429
  const requests = Array.from({ length: 20 }, () =>
    fetch(`${BASE_URL}/api/auth/callback/credentials`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        email: 'nonexistent@test.com',
        password: 'WrongPass123!',
      }),
    }).then((r) => ({
      status: r.status,
      remaining: r.headers.get('X-RateLimit-Remaining'),
    }))
  );

  const responses = await Promise.allSettled(requests);
  for (const r of responses) {
    if (r.status === 'fulfilled') results.push(r.value);
  }

  const got429 = results.some((r) => r.status === 429);
  const remainingZero = results.some((r) => r.remaining === '0');

  assert(
    got429 || remainingZero,
    `Expected 429 or X-RateLimit-Remaining=0, got statuses: [${results.map((r) => r.status).join(', ')}]`,
  );
}

// ---------------------------------------------------------------------------
// Test 3: Account Lockout (5 failures locks, 6th with correct pw should fail)
// ---------------------------------------------------------------------------

async function testAccountLockout() {
  const email = `pentest-lockout-${Date.now()}@test.com`;
  const correctPassword = 'CorrectPass99!';

  // Step 1: Register the test user
  const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: registrationBody({ name: 'Lockout Test User', email, password: correctPassword }),
  });

  // If registration is rate-limited from previous tests, skip
  if (regRes.status === 429) return 'skip';
  if (regRes.status !== 201) {
    // Registration may fail for other reasons (e.g., rate limiting from test 1)
    return 'skip';
  }

  // Step 2: Send 6 login attempts with wrong password
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`${BASE_URL}/api/auth/callback/credentials`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ email, password: 'WrongPassword!' }),
    });
    // If rate-limited, skip
    if (res.status === 429) return 'skip';
  }

  // Step 3: Attempt login with correct password — should fail (locked)
  const correctRes = await fetch(`${BASE_URL}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, password: correctPassword }),
  });

  // If rate-limited, skip
  if (correctRes.status === 429) return 'skip';

  // NextAuth returns a redirect (302) on success, or 200/401 on failure.
  // A locked account should NOT get a successful auth.
  const body = await correctRes.text();
  const isSuccessful =
    correctRes.status === 302 ||
    (correctRes.status === 200 && body.includes('"url"'));

  // Even with correct password, the account should be locked
  assert(
    !isSuccessful || body.includes('error'),
    `Expected locked account to reject correct password, got status ${correctRes.status}`,
  );
}

// ---------------------------------------------------------------------------
// Test 4: Input Validation — SQL Injection
// ---------------------------------------------------------------------------

async function testSQLInjection() {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: registrationBody({
      email: "test@test.com'; DROP TABLE users;--",
    }),
  });

  // Should get 400 (validation error), NOT 500 (server error)
  assert(
    res.status === 400 || res.status === 429,
    `Expected 400 validation error for SQL injection attempt, got ${res.status}`,
  );

  if (res.status === 400) {
    // Verify it's a validation error, not a server crash
    const body = await res.json();
    assert(
      body.error || body.errors,
      'Expected validation error message in response body',
    );
  }
}

// ---------------------------------------------------------------------------
// Test 5: Input Validation — XSS in Name
// ---------------------------------------------------------------------------

async function testXSS() {
  const xssPayload = '<script>alert("xss")</script>';

  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: registrationBody({ name: xssPayload }),
  });

  const text = await res.text();

  // Either: 400 validation rejection OR the response body is sanitized
  const isBlocked = res.status === 400;
  const isSanitized = !text.includes('<script>');

  assert(
    isBlocked || isSanitized,
    `XSS payload reflected in response. Status: ${res.status}, body contains <script>: ${text.includes('<script>')}`,
  );
}

// ---------------------------------------------------------------------------
// Test 6: Security Headers
// ---------------------------------------------------------------------------

async function testSecurityHeaders() {
  // nginx is the only source of the security headers (the app sends none), so
  // the default target, the app on its own with no nginx in front, cannot
  // carry them. Asserting them there would fail by design; report SKIP.
  if (BASE_URL === DEFAULT_BASE_URL) {
    return { skip: 'set by nginx; run with TEST_URL=https://makrai.org' };
  }

  const res = await fetch(`${BASE_URL}/login`, { method: 'GET' });

  const xcto = res.headers.get('X-Content-Type-Options');
  const xfo = res.headers.get('X-Frame-Options');

  assert(
    xcto !== null,
    `Missing X-Content-Type-Options header (got: ${xcto})`,
  );
  assert(
    xfo !== null,
    `Missing X-Frame-Options header (got: ${xfo})`,
  );
}

// ---------------------------------------------------------------------------
// Test 7: CORS / Method Check
// ---------------------------------------------------------------------------

async function testMethodCheck() {
  // Send DELETE to registration endpoint — should not return 200
  const deleteRes = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'DELETE',
    headers: JSON_HEADERS,
  });

  // Acceptable: 405 Method Not Allowed, 404, or any non-200 error
  assert(
    deleteRes.status !== 200,
    `DELETE on /api/auth/register should not return 200, got ${deleteRes.status}`,
  );

  // Also test OPTIONS on a protected route
  const optionsRes = await fetch(`${BASE_URL}/api/projects`, {
    method: 'OPTIONS',
  });

  // OPTIONS should return 200/204 (CORS preflight) or be handled appropriately
  // The key assertion is that DELETE above is rejected
  // OPTIONS result is informational — log it but don't fail on it
  if (optionsRes.status >= 500) {
    throw new Error(`OPTIONS /api/projects returned server error ${optionsRes.status}`);
  }
}

// ---------------------------------------------------------------------------
// Evidence upload attack surface (Task 11, O-19). This phase added the first
// byte-accepting endpoint in the product (POST .../assessments/[id]/evidence)
// — everything above this line is unauthenticated. These three cases need a
// REAL session, so this section also adds the plumbing to get one.
//
// SETUP RUNS BEFORE TEST 1, not after Test 7 where these functions are
// defined (see the Main section at the bottom). Registration is IP-keyed,
// max 5 per 15 min (lib/rate-limit.ts), and Test 1 below deliberately fires
// 10 registration requests to exhaust that exact budget; the general
// '/api/auth' budget (max 15 per 15 min, also IP-keyed) covers the LOGIN
// endpoint too and Test 2 deliberately fires 20 requests at it. Every request
// in this script shares one IP (this machine, against localhost), so running
// this setup after either would find both budgets already spent — exactly
// the condition testAccountLockout's own "if registration is rate-limited
// from previous tests, skip" comment already documents happening to IT.
// Running setup FIRST spends 2 of the 5 registration and 2 of the 15 auth
// requests, leaving Test 1 and Test 2 both still well over what they need
// to trip their own limits.
//
// `redirect: 'manual'` on the credentials POST is load-bearing, not
// stylistic: `fetch`'s DEFAULT behaviour follows the 302 NextAuth returns on
// a successful sign-in, and the FOLLOWED response's `headers` do not carry
// the hop's own Set-Cookie (verified live against this exact server before
// writing this: default-redirect gave back `redirected: true`, status 200,
// `getSetCookie()` → `[]` — no session token, a login that LOOKS like it
// worked and silently did not). `redirect: 'manual'` returns the 302 itself,
// whose own `Set-Cookie` carries `authjs.session-token`.
// ---------------------------------------------------------------------------

const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024; // mirrors lib/evidence/inspect.ts's MAX_BYTES — not imported, this script is intentionally dependency-free and black-box.
const REAL_QUESTION_ID = 'Q-PP-01'; // data/questionBank.json — any question in the pinned framework version works; this one just needs to exist.

function makeCookieJar() {
  const cookies = new Map();
  return {
    apply(res) {
      const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      for (const c of setCookies) {
        const pair = c.split(';')[0];
        const eq = pair.indexOf('=');
        if (eq === -1) continue;
        cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
    },
    header() {
      return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
  };
}

/**
 * Registers a fresh org+owner with a SLUG-SHAPED org name and logs in as
 * them. Returns the cookie jar on success, or `null` on ANY failure
 * (rate-limited registration, rate-limited login, a locked-out server,
 * etc.) — callers treat `null` as "skip", matching this file's existing
 * `testAccountLockout` convention for the identical class of condition.
 *
 * The org name IS the slug, deliberately, so no separate discovery call is
 * needed: `deriveSlug` (lib/data/preauth.ts) lowercases, strips diacritics
 * and collapses non-alphanumerics to hyphens — a name that is ALREADY only
 * lowercase letters, digits and hyphens survives that transform unchanged,
 * so choosing one directly here makes the slug fully predictable without
 * importing or reimplementing that function.
 */
async function registerAndLogin(orgSlug, email) {
  const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: registrationBody({ orgName: orgSlug, email }),
  });
  if (regRes.status !== 201) return null;

  const jar = makeCookieJar();
  const csrfRes = await fetch(`${BASE_URL}/api/auth/csrf`);
  jar.apply(csrfRes);
  const { csrfToken } = await csrfRes.json();

  const loginRes = await fetch(`${BASE_URL}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar.header() },
    redirect: 'manual',
    body: new URLSearchParams({ email, password: 'S3cure!Pass99', csrfToken, json: 'true' }),
  });
  if (loginRes.status !== 302) return null;
  jar.apply(loginRes);

  return jar;
}

/** One project, one full-mode assessment, both via the real authenticated
 * API — returns the assessment id, or `null` on any failure. */
async function setupAssessment(jar, slug) {
  const projRes = await fetch(`${BASE_URL}/api/v1/orgs/${slug}/projects`, {
    method: 'POST',
    headers: { ...JSON_HEADERS, Cookie: jar.header() },
    body: JSON.stringify({ name: 'Pen Test Project' }),
  });
  if (projRes.status !== 201) return null;
  const { id: projectId } = await projRes.json();

  const assessRes = await fetch(`${BASE_URL}/api/v1/orgs/${slug}/assessments`, {
    method: 'POST',
    headers: { ...JSON_HEADERS, Cookie: jar.header() },
    body: JSON.stringify({ projectId, mode: 'full' }),
  });
  if (assessRes.status !== 201) return null;
  const { id: assessmentId } = await assessRes.json();
  return assessmentId;
}

function evidenceFormData(content, filename, declaredType) {
  const fd = new FormData();
  fd.set('file', new Blob([content], { type: declaredType }), filename);
  fd.set('questionId', REAL_QUESTION_ID);
  return fd;
}

/**
 * Two orgs (A and B), each with one owner, one project, one assessment.
 * `evidenceFixtures.a` is used for the oversize and wrong-magic-bytes cases
 * (both need only a valid, reachable upload target); `.a` and `.b` together
 * are used for the cross-assessment case (A's session, A's own org slug —
 * so `requireOrgContext` succeeds — but B's assessment id, which belongs to
 * a different tenant entirely).
 *
 * A real, VALID upload is attempted as part of setup and its result folded
 * into `ok` — this is what stops a broken session from silently turning
 * every attack case that follows into a false "PASS" for the wrong reason
 * (a 401/403 on every case would look superficially like "rejected", but
 * would prove nothing about oversize/type/cross-assessment handling
 * specifically).
 */
async function setupEvidenceFixtures() {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const jarA = await registerAndLogin(`pentest-evidence-a-${runId}`, `pentest-evidence-a-${runId}@test.com`);
  const jarB = await registerAndLogin(`pentest-evidence-b-${runId}`, `pentest-evidence-b-${runId}@test.com`);
  if (!jarA || !jarB) return { ok: false };

  const assessmentA = await setupAssessment(jarA, `pentest-evidence-a-${runId}`);
  const assessmentB = await setupAssessment(jarB, `pentest-evidence-b-${runId}`);
  if (!assessmentA || !assessmentB) return { ok: false };

  const sanityRes = await fetch(
    `${BASE_URL}/api/v1/orgs/pentest-evidence-a-${runId}/assessments/${assessmentA}/evidence`,
    {
      method: 'POST',
      headers: { Cookie: jarA.header() },
      body: evidenceFormData(Buffer.from('89504e470d0a1a0a', 'hex'), 'sanity.png', 'image/png'),
    },
  );
  if (sanityRes.status !== 201) return { ok: false };

  return {
    ok: true,
    a: { jar: jarA, slug: `pentest-evidence-a-${runId}`, assessmentId: assessmentA },
    b: { jar: jarB, slug: `pentest-evidence-b-${runId}`, assessmentId: assessmentB },
  };
}

let evidenceFixtures = null; // populated by setupEvidenceFixtures() in Main, before Test 1

async function testOversizeUpload() {
  if (!evidenceFixtures?.ok) return 'skip';
  const { jar, slug, assessmentId } = evidenceFixtures.a;
  const oversize = Buffer.alloc(MAX_EVIDENCE_BYTES + 1024 * 1024, 0x41); // 1 MiB over the limit
  const res = await fetch(`${BASE_URL}/api/v1/orgs/${slug}/assessments/${assessmentId}/evidence`, {
    method: 'POST',
    headers: { Cookie: jar.header() },
    body: evidenceFormData(oversize, 'oversize.pdf', 'application/pdf'),
  });
  assert(res.status === 413, `Expected 413 Payload Too Large for an oversize upload, got ${res.status}`);
}

async function testWrongMagicBytes() {
  if (!evidenceFixtures?.ok) return 'skip';
  const { jar, slug, assessmentId } = evidenceFixtures.a;
  // Declares image/png; the actual bytes are HTML with an inline script —
  // the exact "declared type lies about content" shape O-7 exists to catch.
  const wrongMagic = Buffer.from('<html><script>alert(1)</script></html>');
  const res = await fetch(`${BASE_URL}/api/v1/orgs/${slug}/assessments/${assessmentId}/evidence`, {
    method: 'POST',
    headers: { Cookie: jar.header() },
    body: evidenceFormData(wrongMagic, 'not-really.png', 'image/png'),
  });
  assert(res.status === 400, `Expected 400 for content whose magic bytes do not match its declared type, got ${res.status}`);
}

async function testCrossAssessmentAttach() {
  if (!evidenceFixtures?.ok) return 'skip';
  // `remediationItemId` cannot be used to construct this case: production
  // has no HTTP path that creates a RemediationItem at all (verified —
  // app/api/v1/orgs/[slug]/assessments/[id]/remediation/route.ts's own
  // module doc: the pre-tenancy bulk-create POST was dropped as dead code,
  // "a codebase-wide grep for its only client... found none", and every
  // existing test that needs one creates it directly via `testDb`, which
  // this black-box, fetch-only script deliberately has no equivalent of.
  // The reachable, equally real variant of "attach across an assessment
  // boundary that should not be crossable": org A's own session, org A's
  // own slug in the URL (so `requireOrgContext` succeeds), but an
  // assessment id that belongs to org B. RLS scopes the assessment lookup
  // to org A regardless of what the id names, so this must 404 exactly like
  // a nonexistent id would.
  const { jar, slug } = evidenceFixtures.a;
  const foreignAssessmentId = evidenceFixtures.b.assessmentId;
  const res = await fetch(`${BASE_URL}/api/v1/orgs/${slug}/assessments/${foreignAssessmentId}/evidence`, {
    method: 'POST',
    headers: { Cookie: jar.header() },
    body: evidenceFormData(Buffer.from('89504e470d0a1a0a', 'hex'), 'cross-org.png', 'image/png'),
  });
  assert(res.status === 404, `Expected 404 attaching evidence to another org's assessment id, got ${res.status}`);
}

// ---------------------------------------------------------------------------
// Main — Run all tests
// ---------------------------------------------------------------------------

console.log('\n🔒 Security Penetration Test Suite');
console.log('='.repeat(50));
console.log(`Target: ${BASE_URL}\n`);

evidenceFixtures = await setupEvidenceFixtures();
if (!evidenceFixtures.ok) {
  console.log('  ⚪ Evidence attack-surface setup did not complete (registration/login/assessment-creation failed or was rate-limited) — the 3 evidence cases below will SKIP.');
}

await test('Rate Limit: Registration endpoint', testRateLimitRegister);
await test('Rate Limit: Login endpoint', testRateLimitLogin);
await test('Account Lockout: 5 failures locks account', testAccountLockout);
await test('Input Validation: SQL injection blocked', testSQLInjection);
await test('Input Validation: XSS sanitized', testXSS);
await test('Security Headers: present', testSecurityHeaders);
await test('Method Check: unsupported methods rejected', testMethodCheck);
await test('Evidence Upload: oversize file rejected (413)', testOversizeUpload);
await test('Evidence Upload: wrong magic bytes rejected (400)', testWrongMagicBytes);
await test('Evidence Upload: cross-assessment attach rejected (404)', testCrossAssessmentAttach);

console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
console.log('='.repeat(50));

process.exit(failed > 0 ? 1 : 0);
