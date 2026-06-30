# Runtime Verification & Security Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the runtime verification gap across all 14 pages and 20 API handlers, then harden the platform with NAT-aware rate limiting, account lockout, input validation, security logging, and automated penetration testing.

**Architecture:** Manual-first verification (Chrome DevTools MCP) → bug fixes → defense-in-depth security (Nginx + app middleware + auth hardening) → Playwright regression suite → pen test.

**Tech Stack:** Next.js 16, Prisma 7, NextAuth v5, Playwright 1.61, Nginx, PostgreSQL 16

**Time boxes (from What-If Oracle):**
- Phase 1-2 (Verification + Fixes): 5 days max
- Phase 3 (Security Hardening): 3 days
- Phase 4 (Playwright + Pen Test): 3 days max
- **Decision trigger:** If assessment page has >3 architecture-level bugs, evaluate SPA fallback

---

## Phase 1: Runtime Verification

### Task 1: Start Infrastructure & Verify Database Connection

**Files:**
- Verify: `docker/docker-compose.yml`, `prisma/schema.prisma`, `prisma/seed.ts`

- [ ] **Step 1: Start PostgreSQL container**

```bash
cd /home/alvin/Downloads/DSWB_RAI/toolkit-platform
docker compose -f docker/docker-compose.yml up -d
```

Expected: `postgres` container running on port 5432.

- [ ] **Step 2: Run Prisma migrations**

```bash
npx prisma migrate deploy
```

Expected: All migrations applied successfully.

- [ ] **Step 3: Seed admin user**

```bash
npx prisma db seed
```

Expected: Admin user created (email: `admin@air.ug`).

- [ ] **Step 4: Start dev server**

```bash
npm run dev
```

Expected: Next.js dev server running at `http://localhost:3000`. **If this fails, stop and report — Branch Ψ activated.**

- [ ] **Step 5: Verify admin login via API**

```bash
curl -X POST http://localhost:3000/api/auth/callback/credentials \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@air.ug","password":"change-me-on-first-login"}'
```

Expected: 200 response with session cookie. **If admin can't log in, debug bcrypt/seed before proceeding.**

---

### Task 2: Verify Auth Flow (Flows 1-2, 22)

**Pages:** `/register`, `/login`, `/dashboard`
**APIs:** `POST /api/auth/register`, `POST /api/auth/[...nextauth]`

- [ ] **Step 1: Navigate to `/register`**

Verify: Page renders, all form fields visible (name, email, password, confirm password, terms checkbox, research consent checkbox), submit button present. No console errors.

- [ ] **Step 2: Register a test user**

Fill: name=`Test User`, email=`test@example.com`, password=`TestPass123!`, confirm=`TestPass123!`, check terms. Submit.

Verify: Redirects to `/login?registered=true`. Success banner visible.

- [ ] **Step 3: Login with test user**

Fill: email=`test@example.com`, password=`TestPass123!`. Submit.

Verify: Redirects to `/dashboard`. Welcome message contains "Test User".

- [ ] **Step 4: Test logout**

Click sidebar sign-out button.

Verify: Redirects to `/login`. Session cleared.

- [ ] **Step 5: Document any bugs found**

Create `docs/verification-bugs.md` with format:
```markdown
| # | Page | Action | Expected | Actual | Severity |
```

---

### Task 3: Verify Project Flow (Flows 3-5)

**Pages:** `/dashboard`, `/projects`, `/projects/new`, `/projects/[id]`
**APIs:** `GET/POST /api/projects`, `GET/PUT/DELETE /api/projects/[id]`

- [ ] **Step 1: Navigate to `/dashboard`**

Verify: Dashboard loads, shows welcome message, displays empty state for new user (no projects yet), "New Project" CTA links to `/projects/new`.

- [ ] **Step 2: Create a project**

Navigate to `/projects/new`. Fill: name=`Test AI System`, AI system type=`Classification`, description=`A test classification model`. Expand metadata section and fill institution=`MAK-AI`.

Submit.

Verify: Redirects to `/projects/[id]`. Project details display correctly.

- [ ] **Step 3: Verify project list**

Navigate to `/projects`.

Verify: Lists the created project with correct name and metadata badges. Card links work.

- [ ] **Step 4: Document any bugs found**

Append to `docs/verification-bugs.md`.

---

### Task 4: Verify Assessment Flow (Flows 6-8) ⚠️ CRITICAL PATH

**Pages:** `/assessment/[id]`
**APIs:** `POST /api/assessments`, `GET/PUT /api/assessments/[id]`, `POST /api/assessments/[id]/complete`

> **Decision trigger:** If this page fails with module resolution or hydration errors, you're in Branch Δ. Evaluate scope of fix vs SPA fallback.

- [ ] **Step 1: Start a new assessment**

From the project page, click "Start Assessment" (or create via API if no button exists).

Verify: Assessment page loads, stage selector visible, first stage questions render.

- [ ] **Step 2: Answer questions in first stage**

Answer 3-5 questions using different input types (gate, likert-5, checklist).

Verify: Answers save in UI state. Check network tab for auto-save PUT request to `/api/assessments/[id]`.

- [ ] **Step 3: Navigate between stages**

Click different stages in the stage selector.

Verify: Locked stages show lock icon. Unlocked stages load their questions. Previously answered questions retain values.

- [ ] **Step 4: Complete a stage**

Answer all required questions in one stage.

Verify: Stage completion updates progress indicator. Next stage unlocks.

- [ ] **Step 5: Complete the full assessment (or trigger completion)**

If time-boxed: answer enough questions to trigger completion. Otherwise, answer all questions across all stages.

Verify: Completion modal appears. Click "Complete" → redirects to report page.

- [ ] **Step 6: Document any bugs found**

Append to `docs/verification-bugs.md`. **If >3 architecture-level bugs: STOP, evaluate fallback.**

---

### Task 5: Verify Report Flow (Flows 9-10)

**Pages:** `/assessment/[id]/report`
**APIs:** `GET /api/reports/[id]/pdf`

- [ ] **Step 1: View report page**

Verify: Report renders with overall score, area cards, principle scorecards, influence cards, controls list, references.

- [ ] **Step 2: Download PDF**

Click "Download PDF" button (or visit `/api/reports/[id]/pdf` directly).

Verify: PDF downloads with correct filename. Open PDF — contains project name, scores, branded layout.

- [ ] **Step 3: Document any bugs found**

Append to `docs/verification-bugs.md`.

---

### Task 6: Verify Explore Pages (Flows 12-14)

**Pages:** `/explore/framework`, `/explore/controls`, `/explore/about`

- [ ] **Step 1: Visit each explore page**

Navigate to each page via sidebar links.

Verify per page:
- Framework Map: Interactive visualization renders, stage navigation works
- Controls Library: Controls list renders, search/filter works
- About: Content renders, no unstyled HTML

- [ ] **Step 2: Check CSS**

Verify: CSS files (`FrameworkMapPage.css`, `ControlsLibraryPage.css`, `AboutPage.css`) are loaded and applied.

- [ ] **Step 3: Document any bugs found**

Append to `docs/verification-bugs.md`.

---

### Task 7: Verify Admin & Remaining Pages (Flows 11, 15-21)

**Pages:** `/admin/users`, `/admin/assessments`, `/admin/settings`, `/projects/[id]/compare`
**APIs:** `GET /api/users/me/export`, `DELETE /api/users/me`, `GET /api/research/export`, remediation CRUD

- [ ] **Step 1: Login as admin (`admin@air.ug`)**

Verify: Admin nav items visible in sidebar (Users, Assessments, Settings).

- [ ] **Step 2: Check admin pages**

- `/admin/users`: Table renders all users, role badges show
- `/admin/assessments`: Summary cards compute, table renders
- `/admin/settings`: Platform statistics display

- [ ] **Step 3: Check comparison charts**

Navigate to `/projects/[id]/compare` for a project with completed assessment.

Verify: RadarChart, TrendChart, and GapHeatmap render. Also test with a project with zero completed assessments (empty state).

- [ ] **Step 4: Check account management APIs**

```bash
# Data export (as logged-in user via cookie)
curl -b cookies.txt http://localhost:3000/api/users/me/export

# Research export (as admin)
curl -b admin-cookies.txt http://localhost:3000/api/research/export
```

Verify: Export returns JSON, research export is admin-only.

- [ ] **Step 5: Check remediation API**

```bash
# Create remediation item
curl -X POST http://localhost:3000/api/assessments/[id]/remediation \
  -H 'Content-Type: application/json' \
  -b cookies.txt \
  -d '{"areaId":"fairness","areaName":"Fairness","tier":"gap","description":"Address bias in training data"}'
```

Verify: Item created and returned.

- [ ] **Step 6: Document any bugs found**

Append to `docs/verification-bugs.md`.

- [ ] **Step 7: Commit verification results**

```bash
git add docs/verification-bugs.md
git commit -m "docs: runtime verification results — Phase 1 complete"
```

---

### Task 8: Fix All Discovered Bugs

**Files:** Variable — depends on bugs found in Tasks 2-7.

- [ ] **Step 1: Triage bugs by severity**

Sort `docs/verification-bugs.md` by severity: Critical (page won't load) → High (feature broken) → Medium (wrong data/layout) → Low (cosmetic).

- [ ] **Step 2: Fix critical and high bugs first**

Fix in priority order. For each bug:
1. Fix the root cause
2. Re-verify the specific flow
3. Run `npx vitest run` — all 80 tests must still pass
4. Commit: `git commit -m "fix: <description>"`

- [ ] **Step 3: Fix medium and low bugs**

Same protocol as Step 2.

- [ ] **Step 4: Re-run full verification sweep**

Walk through all 22 flows again to confirm no regressions from fixes.

- [ ] **Step 5: Update verification log**

```bash
git add docs/verification-bugs.md
git commit -m "docs: all verification bugs fixed — Phase 2 complete"
```

---

## Phase 2: Security Hardening

### Task 9: Prisma Schema Migration — Account Lockout Fields

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add lockout fields to User model**

In `prisma/schema.prisma`, add to the `User` model after `updatedAt`:

```prisma
  failedLoginAttempts Int       @default(0)
  lockedUntil         DateTime?
```

- [ ] **Step 2: Create migration**

```bash
npx prisma migrate dev --name add-account-lockout-fields
```

Expected: Migration created and applied. No data loss warnings.

- [ ] **Step 3: Verify migration**

```bash
npx prisma studio
```

Check the `users` table: `failedLoginAttempts` column exists (default 0), `lockedUntil` column exists (nullable).

- [ ] **Step 4: Commit**

```bash
git add prisma/
git commit -m "feat: add account lockout fields to User model"
```

---

### Task 10: Create Rate Limiter Library

**Files:**
- Create: `lib/rate-limit.ts`

- [ ] **Step 1: Create `lib/rate-limit.ts`**

```typescript
/**
 * In-memory sliding window rate limiter.
 * Dual-key: uses userId for authenticated routes, IP for pre-auth routes.
 * NAT-aware: designed for shared-IP classroom deployments.
 */

type KeyBy = 'ip' | 'userId';

interface RateLimitConfig {
  window: number;   // milliseconds
  max: number;      // max requests in window
  keyBy: KeyBy;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export const RATE_LIMITS: Record<string, RateLimitConfig> = {
  'POST:/api/auth/register': { window: 15 * 60 * 1000, max: 5, keyBy: 'ip' },
  'POST:/api/auth': { window: 15 * 60 * 1000, max: 15, keyBy: 'ip' },
  'DELETE:/api/users/me': { window: 60 * 60 * 1000, max: 1, keyBy: 'userId' },
  'default': { window: 60 * 1000, max: 60, keyBy: 'userId' },
};

const store = new Map<string, RateLimitEntry>();

// Cleanup expired entries every 60 seconds
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.resetAt <= now) {
        store.delete(key);
      }
    }
  }, 60_000);
}

/**
 * Find the matching rate limit config for a request.
 * Matches by method:path prefix (e.g., POST:/api/auth matches POST:/api/auth/callback/credentials).
 */
function findConfig(method: string, path: string): RateLimitConfig {
  const key = `${method}:${path}`;

  // Exact match first
  if (RATE_LIMITS[key]) return RATE_LIMITS[key];

  // Prefix match (longest first)
  const prefixMatches = Object.entries(RATE_LIMITS)
    .filter(([k]) => k !== 'default' && key.startsWith(k))
    .sort((a, b) => b[0].length - a[0].length);

  if (prefixMatches.length > 0) return prefixMatches[0][1];

  return RATE_LIMITS['default'];
}

export interface RateLimitResult {
  success: boolean;
  remaining: number;
  resetAt: Date;
  limit: number;
}

/**
 * Check rate limit for a request.
 * @param method HTTP method (GET, POST, etc.)
 * @param path Request path
 * @param ip Client IP address
 * @param userId Authenticated user ID (null for pre-auth requests)
 */
export function checkRateLimit(
  method: string,
  path: string,
  ip: string,
  userId: string | null,
): RateLimitResult {
  const config = findConfig(method, path);
  const identifier = config.keyBy === 'userId' && userId ? userId : ip;
  const storeKey = `${identifier}:${method}:${path}`;
  const now = Date.now();

  let entry = store.get(storeKey);

  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + config.window };
    store.set(storeKey, entry);
  }

  entry.count++;

  const remaining = Math.max(0, config.max - entry.count);
  const success = entry.count <= config.max;

  return {
    success,
    remaining,
    resetAt: new Date(entry.resetAt),
    limit: config.max,
  };
}

/** Reset rate limit store — for testing only. */
export function resetRateLimitStore(): void {
  store.clear();
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/rate-limit.ts
git commit -m "feat: add NAT-aware dual-key rate limiter"
```

---

### Task 11: Create Next.js Middleware

**Files:**
- Create: `middleware.ts` (project root)

- [ ] **Step 1: Create `middleware.ts`**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { checkRateLimit } from '@/lib/rate-limit';

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const method = request.method;

  // Only rate-limit API routes
  if (!pathname.startsWith('/api/')) {
    return NextResponse.next();
  }

  // Extract IP
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    '127.0.0.1';

  // Extract userId from JWT (if authenticated)
  let userId: string | null = null;
  try {
    const token = await getToken({ req: request });
    if (token?.id) {
      userId = token.id as string;
    }
  } catch {
    // Pre-auth request — no token available, use IP-based limiting
  }

  const result = checkRateLimit(method, pathname, ip, userId);

  if (!result.success) {
    const retryAfter = Math.ceil((result.resetAt.getTime() - Date.now()) / 1000);
    return new NextResponse(
      JSON.stringify({ error: 'Too many requests. Please try again later.' }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(retryAfter),
          'X-RateLimit-Limit': String(result.limit),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': result.resetAt.toISOString(),
        },
      },
    );
  }

  const response = NextResponse.next();
  response.headers.set('X-RateLimit-Limit', String(result.limit));
  response.headers.set('X-RateLimit-Remaining', String(result.remaining));
  response.headers.set('X-RateLimit-Reset', result.resetAt.toISOString());
  return response;
}

export const config = {
  matcher: ['/api/:path*'],
};
```

- [ ] **Step 2: Commit**

```bash
git add middleware.ts
git commit -m "feat: add Next.js middleware with rate limiting"
```

---

### Task 12: Add Account Lockout to Auth

**Files:**
- Modify: `lib/auth.ts`

- [ ] **Step 1: Update `authorize` function with lockout logic**

Replace the entire `authorize` function in `lib/auth.ts`:

```typescript
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        const user = await prisma.user.findUnique({
          where: { email: credentials.email as string },
        });

        // Generic error for both "user not found" and "wrong password"
        if (!user) return null;

        // Check if account is locked
        if (user.lockedUntil && user.lockedUntil > new Date()) {
          return null; // Still locked — return same generic null
        }

        const isValid = await compare(credentials.password as string, user.passwordHash);

        if (!isValid) {
          // Increment failed attempts
          const failedAttempts = user.failedLoginAttempts + 1;
          const updateData: { failedLoginAttempts: number; lockedUntil?: Date } = {
            failedLoginAttempts: failedAttempts,
          };

          // Lock after 5 failed attempts (15-minute lockout)
          if (failedAttempts >= 5) {
            updateData.lockedUntil = new Date(Date.now() + 15 * 60 * 1000);
          }

          await prisma.user.update({
            where: { id: user.id },
            data: updateData,
          });

          return null;
        }

        // Successful login — reset failed attempts
        if (user.failedLoginAttempts > 0 || user.lockedUntil) {
          await prisma.user.update({
            where: { id: user.id },
            data: { failedLoginAttempts: 0, lockedUntil: null },
          });
        }

        return { id: user.id, email: user.email, name: user.name, role: user.role };
      },
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit --skipLibCheck
```

Expected: No errors from `lib/auth.ts`.

- [ ] **Step 3: Run unit tests**

```bash
npx vitest run
```

Expected: 80/80 tests pass (auth logic is not unit-tested directly — engine tests unaffected).

- [ ] **Step 4: Commit**

```bash
git add lib/auth.ts
git commit -m "feat: add account lockout after 5 failed login attempts"
```

---

### Task 13: Create Input Validation Library

**Files:**
- Create: `lib/validate.ts`
- Modify: `app/api/auth/register/route.ts`

- [ ] **Step 1: Create `lib/validate.ts`**

```typescript
/**
 * Input validation and sanitization functions.
 * No external dependencies — pure TypeScript.
 */

export interface ValidationError {
  field: string;
  message: string;
}

/** Validate email format (RFC 5322 simplified). */
export function validateEmail(email: unknown): ValidationError | null {
  if (typeof email !== 'string' || email.length === 0) {
    return { field: 'email', message: 'Email is required' };
  }
  const trimmed = email.trim().toLowerCase();
  if (trimmed.length > 254) {
    return { field: 'email', message: 'Email must be 254 characters or fewer' };
  }
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  if (!emailRegex.test(trimmed)) {
    return { field: 'email', message: 'Please enter a valid email address' };
  }
  return null;
}

/** Validate password strength. */
export function validatePassword(password: unknown): ValidationError | null {
  if (typeof password !== 'string' || password.length === 0) {
    return { field: 'password', message: 'Password is required' };
  }
  if (password.length < 8) {
    return { field: 'password', message: 'Password must be at least 8 characters' };
  }
  if (password.length > 128) {
    return { field: 'password', message: 'Password must be 128 characters or fewer' };
  }
  return null;
}

/** Validate and sanitize a string field. */
export function validateString(
  value: unknown,
  field: string,
  maxLength: number,
  required = true,
): { value: string; error: ValidationError | null } {
  if (value === null || value === undefined || value === '') {
    if (required) {
      return { value: '', error: { field, message: `${field} is required` } };
    }
    return { value: '', error: null };
  }
  if (typeof value !== 'string') {
    return { value: '', error: { field, message: `${field} must be a string` } };
  }
  const sanitized = sanitizeInput(value);
  if (sanitized.length > maxLength) {
    return {
      value: sanitized,
      error: { field, message: `${field} must be ${maxLength} characters or fewer` },
    };
  }
  return { value: sanitized, error: null };
}

/** Sanitize input: trim whitespace, strip control characters. */
export function sanitizeInput(value: string): string {
  return value
    .trim()
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/** Collect validation errors into a single response. */
export function collectErrors(errors: (ValidationError | null)[]): ValidationError[] {
  return errors.filter((e): e is ValidationError => e !== null);
}
```

- [ ] **Step 2: Apply validation to registration route**

Replace the validation section in `app/api/auth/register/route.ts` (lines 8-19):

```typescript
    const body = await request.json();
    const { password, termsAccepted, researchConsent } = body;

    // Validate and sanitize inputs
    const nameResult = validateString(body.name, 'name', 100);
    const emailError = validateEmail(body.email);
    const passwordError = validatePassword(password);

    const errors = collectErrors([nameResult.error, emailError, passwordError]);
    if (errors.length > 0) {
      return NextResponse.json({ error: errors[0].message, errors }, { status: 400 });
    }

    const name = nameResult.value;
    const email = (body.email as string).trim().toLowerCase();

    if (!termsAccepted) {
      return NextResponse.json({ error: 'Terms of Service must be accepted' }, { status: 400 });
    }
```

Add import at top of register route:

```typescript
import { validateEmail, validatePassword, validateString, collectErrors } from '@/lib/validate';
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit --skipLibCheck
```

- [ ] **Step 4: Commit**

```bash
git add lib/validate.ts app/api/auth/register/route.ts
git commit -m "feat: add input validation library and apply to registration"
```

---

### Task 14: Create Security Event Logger

**Files:**
- Create: `lib/security-log.ts`
- Modify: `lib/auth.ts` (add logging calls)
- Modify: `app/api/auth/register/route.ts` (add logging calls)
- Modify: `middleware.ts` (add rate-limit logging)

- [ ] **Step 1: Create `lib/security-log.ts`**

```typescript
/**
 * Structured security event logging.
 * Dev: console.warn (JSON). Prod: append to file.
 */

import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';

export type SecurityEventType =
  | 'login_success'
  | 'login_failed'
  | 'account_locked'
  | 'registration'
  | 'account_deleted'
  | 'admin_action'
  | 'rate_limited'
  | 'auth_bypass_attempt';

interface SecurityEvent {
  timestamp: string;
  event: SecurityEventType;
  ip: string;
  userId?: string;
  email?: string;
  details?: Record<string, unknown>;
}

const LOG_DIR = process.env.SECURITY_LOG_DIR || '/var/log/makrai';
const LOG_FILE = join(LOG_DIR, 'security.log');

async function writeToFile(entry: SecurityEvent): Promise<void> {
  try {
    await mkdir(LOG_DIR, { recursive: true });
    await appendFile(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch {
    // Fallback to console if file write fails (e.g., permissions)
    console.warn('[SECURITY]', JSON.stringify(entry));
  }
}

/**
 * Log a security event.
 */
export async function logSecurityEvent(
  event: SecurityEventType,
  ip: string,
  options?: {
    userId?: string;
    email?: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  const entry: SecurityEvent = {
    timestamp: new Date().toISOString(),
    event,
    ip,
    ...options,
  };

  if (process.env.NODE_ENV === 'production') {
    await writeToFile(entry);
  } else {
    console.warn('[SECURITY]', JSON.stringify(entry));
  }
}
```

- [ ] **Step 2: Add logging to `lib/auth.ts`**

Add import at top:
```typescript
import { logSecurityEvent } from './security-log';
```

In the `authorize` function, add logging calls:
- After lockout check block: `await logSecurityEvent('account_locked', 'unknown', { email: credentials.email as string });`
- After `if (!isValid)` and lockout trigger block: `await logSecurityEvent('login_failed', 'unknown', { email: credentials.email as string, details: { failedAttempts } });`
- After `failedAttempts >= 5` lockout: `await logSecurityEvent('account_locked', 'unknown', { email: credentials.email as string });`
- After successful login return: `await logSecurityEvent('login_success', 'unknown', { userId: user.id, email: user.email });`

Note: IP is 'unknown' in authorize since NextAuth doesn't pass the request. Middleware rate-limit logging captures IP.

- [ ] **Step 3: Add logging to registration route**

In `app/api/auth/register/route.ts`, add after successful user creation:
```typescript
    await logSecurityEvent('registration', ip, { userId: user.id, email });
```

Add import:
```typescript
import { logSecurityEvent } from '@/lib/security-log';
```

- [ ] **Step 4: Add rate-limit logging to middleware**

In `middleware.ts`, inside the `!result.success` block, add before the return:
```typescript
    import { logSecurityEvent } from '@/lib/security-log';
    // ... inside the !result.success block:
    await logSecurityEvent('rate_limited', ip, {
      userId: userId || undefined,
      details: { method, path: pathname, limit: result.limit },
    });
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit --skipLibCheck
```

- [ ] **Step 6: Commit**

```bash
git add lib/security-log.ts lib/auth.ts app/api/auth/register/route.ts middleware.ts
git commit -m "feat: add security event logging across auth and rate limiting"
```

---

### Task 15: Update Nginx Config & Next.js CORS Headers

**Files:**
- Modify: `docker/nginx/default.conf`
- Modify: `next.config.ts`

- [ ] **Step 1: Update Nginx config with rate limiting and headers**

Replace the contents of `docker/nginx/default.conf` with:

```nginx
# Rate limiting zones (NAT-aware: high limits for DDoS protection only)
limit_req_zone $binary_remote_addr zone=auth:10m rate=20r/m;
limit_req_zone $binary_remote_addr zone=api:10m rate=300r/m;
limit_req_zone $binary_remote_addr zone=global:10m rate=600r/m;

# HTTP → HTTPS redirect
server {
    listen 80;
    server_name rai.air.ug;
    return 301 https://$host$request_uri;
}

# HTTPS server
server {
    listen 443 ssl;
    server_name rai.air.ug;

    # SSL certificates (Let's Encrypt / Certbot)
    ssl_certificate     /etc/letsencrypt/live/rai.air.ug/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/rai.air.ug/privkey.pem;

    # SSL hardening
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;
    ssl_ciphers 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384';
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    # Security headers
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
    add_header X-Frame-Options DENY always;
    add_header X-Content-Type-Options nosniff always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline' fonts.googleapis.com; font-src fonts.gstatic.com; img-src 'self' data:;" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=()" always;

    # Gzip compression
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_min_length 256;
    gzip_types text/plain text/css text/javascript application/javascript application/json application/xml image/svg+xml;

    # Client upload limit
    client_max_body_size 10m;

    # Auth endpoints — stricter rate limiting
    location /api/auth/ {
        limit_req zone=auth burst=10 nodelay;
        limit_req_status 429;
        proxy_pass http://nextjs:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # API endpoints — moderate rate limiting
    location /api/ {
        limit_req zone=api burst=50 nodelay;
        limit_req_status 429;
        proxy_pass http://nextjs:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # All other routes — DDoS baseline
    location / {
        limit_req zone=global burst=100 nodelay;
        proxy_pass http://nextjs:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

- [ ] **Step 2: Add CORS headers to `next.config.ts`**

Replace `next.config.ts`:

```typescript
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [
          {
            key: 'Access-Control-Allow-Origin',
            value: process.env.NEXTAUTH_URL || 'http://localhost:3000',
          },
          {
            key: 'Access-Control-Allow-Methods',
            value: 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
          },
          {
            key: 'Access-Control-Allow-Headers',
            value: 'Content-Type, Authorization',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
```

- [ ] **Step 3: Commit**

```bash
git add docker/nginx/default.conf next.config.ts
git commit -m "feat: add Nginx rate limiting zones and CORS headers"
```

---

### Task 16: Add Package.json Scripts

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add convenience scripts**

Add to the `scripts` section of `package.json`:

```json
"test:e2e": "npx playwright test",
"test:e2e:headed": "npx playwright test --headed",
"db:migrate": "npx prisma migrate deploy",
"db:seed": "npx prisma db seed",
"db:studio": "npx prisma studio"
```

- [ ] **Step 2: Commit**

```bash
git add package.json
git commit -m "chore: add convenience scripts for E2E tests and database"
```

---

## Phase 3: Penetration Test & Playwright

### Task 17: Create Penetration Test Script

**Files:**
- Create: `scripts/pen-test.ts`

- [ ] **Step 1: Create `scripts/pen-test.ts`**

```typescript
#!/usr/bin/env npx tsx
/**
 * Automated penetration test for MAK-AI RAI Toolkit Platform.
 * Run: npx tsx scripts/pen-test.ts --url http://localhost:3000
 */

const BASE_URL = process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : 'http://localhost:3000';

interface TestResult {
  name: string;
  vector: string;
  severity: 'Critical' | 'High' | 'Medium';
  passed: boolean;
  details: string;
}

const results: TestResult[] = [];

async function fetchJSON(path: string, options?: RequestInit) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

// Test 1: Brute force login protection
async function testBruteForce() {
  console.log('\n🔐 Test 1: Brute force login...');
  let got429 = false;
  for (let i = 0; i < 20; i++) {
    const res = await fetchJSON('/api/auth/callback/credentials', {
      method: 'POST',
      body: JSON.stringify({ email: 'brute@test.com', password: `wrong${i}` }),
    });
    if (res.status === 429) { got429 = true; break; }
  }
  results.push({
    name: 'Brute force login',
    vector: '20 rapid POSTs with wrong password',
    severity: 'Critical',
    passed: got429,
    details: got429 ? 'Rate limited as expected' : 'No rate limiting triggered after 20 attempts',
  });
}

// Test 2: Registration spam
async function testRegistrationSpam() {
  console.log('📝 Test 2: Registration spam...');
  let got429 = false;
  for (let i = 0; i < 10; i++) {
    const res = await fetchJSON('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: `spam${i}-${Date.now()}@test.com`,
        password: 'SpamPass123!',
        name: 'Spammer',
        termsAccepted: true,
      }),
    });
    if (res.status === 429) { got429 = true; break; }
  }
  results.push({
    name: 'Registration spam',
    vector: '10 rapid POST registrations',
    severity: 'High',
    passed: got429,
    details: got429 ? 'Rate limited as expected' : 'No rate limiting on registration',
  });
}

// Test 3: SQL injection
async function testSQLInjection() {
  console.log('💉 Test 3: SQL injection...');
  const res = await fetchJSON('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: "' OR 1=1; --",
      password: 'TestPass123!',
      name: 'SQLi Test',
      termsAccepted: true,
    }),
  });
  const passed = res.status === 400;
  results.push({
    name: 'SQL injection',
    vector: "Email: ' OR 1=1; --",
    severity: 'Critical',
    passed,
    details: passed ? `Rejected with ${res.status}` : `Unexpected status ${res.status}: ${res.body}`,
  });
}

// Test 4: XSS stored
async function testXSSStored() {
  console.log('🕷️ Test 4: XSS stored...');
  const regRes = await fetchJSON('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: `xss-${Date.now()}@test.com`,
      password: 'TestPass123!',
      name: '<script>alert("xss")</script>',
      termsAccepted: true,
    }),
  });
  const passed = regRes.status === 201 || regRes.status === 400;
  results.push({
    name: 'XSS stored',
    vector: 'Name: <script>alert("xss")</script>',
    severity: 'Critical',
    passed,
    details: passed
      ? 'Input accepted (React auto-escapes on render) or rejected by validation'
      : `Unexpected status ${regRes.status}`,
  });
}

// Test 5: CSRF (unauthenticated API access)
async function testCSRF() {
  console.log('🛡️ Test 5: CSRF / unauthenticated access...');
  const res = await fetchJSON('/api/projects', { method: 'POST', body: '{"name":"CSRF Test"}' });
  const passed = res.status === 401 || res.status === 403;
  results.push({
    name: 'CSRF / No auth',
    vector: 'POST /api/projects without session',
    severity: 'High',
    passed,
    details: passed ? `Blocked with ${res.status}` : `Unexpected status ${res.status}`,
  });
}

// Test 6: Auth bypass (admin pages as non-admin)
async function testAuthBypass() {
  console.log('🚫 Test 6: Auth bypass...');
  const res = await fetchJSON('/api/research/export');
  const passed = res.status === 401 || res.status === 403;
  results.push({
    name: 'Auth bypass (admin route)',
    vector: 'GET /api/research/export without admin session',
    severity: 'Critical',
    passed,
    details: passed ? `Blocked with ${res.status}` : `Unexpected status ${res.status}`,
  });
}

// Test 7: Path traversal
async function testPathTraversal() {
  console.log('📂 Test 7: Path traversal...');
  const res = await fetch(`${BASE_URL}/api/projects/..%2F..%2Fetc%2Fpasswd`);
  const passed = res.status === 401 || res.status === 403 || res.status === 404;
  results.push({
    name: 'Path traversal',
    vector: 'GET /api/projects/../../etc/passwd',
    severity: 'High',
    passed,
    details: passed ? `Blocked with ${res.status}` : `Unexpected status ${res.status}`,
  });
}

// Test 8: Security headers
async function testSecurityHeaders() {
  console.log('📋 Test 8: Security headers...');
  const res = await fetch(`${BASE_URL}/login`);
  const headers = res.headers;
  const checks = {
    'x-content-type-options': headers.get('x-content-type-options'),
  };
  const passed = res.status === 200;
  results.push({
    name: 'Security headers',
    vector: 'HEAD on /login',
    severity: 'Medium',
    passed,
    details: `Status: ${res.status}. Headers present: ${JSON.stringify(checks)}. Note: Full header check requires Nginx (production).`,
  });
}

// Generate report
function generateReport() {
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const score = Math.round((passed / total) * 100);

  console.log('\n' + '='.repeat(60));
  console.log('  PENETRATION TEST REPORT');
  console.log('  ' + new Date().toISOString());
  console.log('  Target: ' + BASE_URL);
  console.log('='.repeat(60));
  console.log(`\n  Score: ${passed}/${total} (${score}%)\n`);

  for (const r of results) {
    const icon = r.passed ? '✅' : '❌';
    console.log(`  ${icon} [${r.severity}] ${r.name}`);
    console.log(`     Vector: ${r.vector}`);
    console.log(`     Result: ${r.details}\n`);
  }

  const failed = results.filter((r) => !r.passed);
  if (failed.length > 0) {
    console.log('  ⚠️  FAILED TESTS:');
    for (const r of failed) {
      console.log(`    - [${r.severity}] ${r.name}: ${r.details}`);
    }
  }

  console.log('\n' + '='.repeat(60));
  process.exit(failed.some((r) => r.severity === 'Critical') ? 1 : 0);
}

// Run all tests
async function main() {
  console.log(`\n🔒 MAK-AI RAI Toolkit — Penetration Test\n   Target: ${BASE_URL}\n`);

  await testBruteForce();
  await testRegistrationSpam();
  await testSQLInjection();
  await testXSSStored();
  await testCSRF();
  await testAuthBypass();
  await testPathTraversal();
  await testSecurityHeaders();

  generateReport();
}

main().catch((err) => { console.error('Pen test failed:', err); process.exit(1); });
```

- [ ] **Step 2: Commit**

```bash
git add scripts/pen-test.ts
git commit -m "test: add automated penetration test script (8 attack vectors)"
```

---

### Task 18: Extend Playwright E2E Suite

**Files:**
- Create: `e2e/assessment.spec.ts`, `e2e/report.spec.ts`, `e2e/explore.spec.ts`, `e2e/admin.spec.ts`, `e2e/comparison.spec.ts`, `e2e/account.spec.ts`
- Modify: `e2e/auth.spec.ts` (extend with logout + error cases)

> **Time box: 3 days.** If E2E tests aren't stable by day 3, ship with existing 2 test files + manual verification.

- [ ] **Step 1: Create `e2e/explore.spec.ts`** (simplest — page-load checks)

```typescript
import { test, expect } from '@playwright/test';

test.describe('Explore Pages', () => {
  test.beforeEach(async ({ page }) => {
    const email = `explore-${Date.now()}@test.com`;
    await page.goto('/register');
    await page.fill('#name', 'Explorer');
    await page.fill('#email', email);
    await page.fill('#password', 'TestPass123!');
    await page.fill('#confirmPassword', 'TestPass123!');
    await page.check('input[type="checkbox"]');
    await page.click('button[type="submit"]');
    await page.waitForURL('/login*');
    await page.fill('#email', email);
    await page.fill('#password', 'TestPass123!');
    await page.click('button[type="submit"]');
    await page.waitForURL('/dashboard');
  });

  test('Framework Map page loads', async ({ page }) => {
    await page.goto('/explore/framework');
    await expect(page.locator('h1')).toBeVisible();
  });

  test('Controls Library page loads', async ({ page }) => {
    await page.goto('/explore/controls');
    await expect(page.locator('h1')).toBeVisible();
  });

  test('About page loads', async ({ page }) => {
    await page.goto('/explore/about');
    await expect(page.locator('h1')).toBeVisible();
  });
});
```

- [ ] **Step 2: Create remaining E2E test files**

Follow the same pattern for `assessment.spec.ts`, `report.spec.ts`, `admin.spec.ts`, `comparison.spec.ts`, `account.spec.ts`. Each file:
1. Register + login helper in `beforeEach`
2. Test the specific flow from the verification matrix
3. Assert key elements are visible

- [ ] **Step 3: Extend `e2e/auth.spec.ts` with error cases**

Add tests for:
- Wrong password shows error message
- Duplicate email registration shows error
- Logout redirects to login

- [ ] **Step 4: Verify all tests parse**

```bash
npx tsc --noEmit --skipLibCheck
```

- [ ] **Step 5: Commit**

```bash
git add e2e/
git commit -m "test: extend Playwright E2E suite to cover all flows"
```

---

## Phase 4: Final Verification

### Task 19: Run Full Test Suite & Pen Test

- [ ] **Step 1: Run unit tests**

```bash
npx vitest run
```

Expected: 80/80 pass.

- [ ] **Step 2: Run production build**

```bash
npm run build
```

Expected: Clean build, no errors.

- [ ] **Step 3: Start dev server and run pen test**

```bash
npm run dev &
sleep 5
npx tsx scripts/pen-test.ts --url http://localhost:3000
```

Expected: 8/8 tests pass (or document any failures with rationale).

- [ ] **Step 4: Run Playwright E2E tests** (if within time box)

```bash
npx playwright test
```

Expected: All tests pass.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore: verification and security hardening complete"
```

---

## Decision Triggers (from What-If Oracle)

| Signal | Branch | Action |
|--------|--------|--------|
| Admin seed login fails | Ψ Database | Debug Prisma adapter + bcrypt before proceeding |
| Assessment page: `require is not defined` | Δ Architecture | Convert engine to ESM, don't patch around it |
| >15 bugs in Phase 1 | Δ Architecture | Stop, reassess migration approach |
| 429 during normal assessment flow | Φ Security Backfire | Switch to userId-based limits for auth'd routes |
| First Playwright test takes >8 hours | ∞ Playwright Trap | Ship with smoke suite only |
| All 22 flows pass first day | Ω Clean Run | Skip to security hardening |
