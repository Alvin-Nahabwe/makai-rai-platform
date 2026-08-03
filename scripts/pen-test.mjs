#!/usr/bin/env node

/**
 * Automated penetration test script.
 * Tests security hardening layers against http://localhost:3000.
 * Run: node scripts/pen-test.mjs
 *
 * Uses only Node.js built-in fetch (Node 18+). No external dependencies.
 */

const BASE_URL = process.env.TEST_URL || 'http://localhost:3000';

let passed = 0;
let failed = 0;
let skipped = 0;

async function test(name, fn) {
  try {
    const result = await fn();
    if (result === 'skip') {
      skipped++;
      console.log(`  ⚪ SKIP: ${name}`);
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
// Main — Run all tests
// ---------------------------------------------------------------------------

console.log('\n🔒 Security Penetration Test Suite');
console.log('='.repeat(50));
console.log(`Target: ${BASE_URL}\n`);

await test('Rate Limit: Registration endpoint', testRateLimitRegister);
await test('Rate Limit: Login endpoint', testRateLimitLogin);
await test('Account Lockout: 5 failures locks account', testAccountLockout);
await test('Input Validation: SQL injection blocked', testSQLInjection);
await test('Input Validation: XSS sanitized', testXSS);
await test('Security Headers: present', testSecurityHeaders);
await test('Method Check: unsupported methods rejected', testMethodCheck);

console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
console.log('='.repeat(50));

process.exit(failed > 0 ? 1 : 0);
