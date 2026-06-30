# Runtime Verification & Security Hardening — Design Spec

**Date:** 2026-06-30
**Scope:** Systematic runtime verification of all 14 pages and 20 API handlers, plus defense-in-depth security hardening with automated penetration testing.
**Target:** MAK-AI RAI Toolkit Platform at `/home/alvin/Downloads/DSWB_RAI/toolkit-platform/`

---

## 1. Runtime Verification

### 1.1 Problem Statement

All 27 implementation tasks were verified by `npx tsc --noEmit` (compile-time type checking). Zero pages have been loaded in a running browser. The production build was attempted only once at ship-gate and immediately failed (missing Suspense boundary). The gap between "compiles" and "works" must be closed before deployment.

### 1.2 Verification Scope

**14 pages, 20 API handlers, 8 user flows — full coverage.**

### 1.3 Phase 1: Manual Smoke Run

Start Docker database + dev server. Walk through every flow systematically, capturing evidence.

#### Prerequisites

```bash
cd /home/alvin/Downloads/DSWB_RAI/toolkit-platform
docker compose -f docker/docker-compose.yml up -d   # Start PostgreSQL
npx prisma migrate deploy                            # Run migrations
npx prisma db seed                                   # Seed admin user
npm run dev                                          # Start Next.js dev server
```

#### Flow Verification Matrix

| # | Flow | Route(s) | Verification Criteria |
|---|------|----------|----------------------|
| 1 | **Registration** | `POST /api/auth/register`, `/register` | Form renders, all fields work, terms checkbox required, submit creates user + consent records, redirects to `/login?registered=true` |
| 2 | **Login** | `POST /api/auth/[...nextauth]`, `/login` | Success banner shows for new registration, credentials authenticate, redirects to `/dashboard`, session persists |
| 3 | **Dashboard** | `/dashboard` | Welcome message shows user name, empty state for new user, "Start New Assessment" CTA links correctly |
| 4 | **Create Project** | `POST /api/projects`, `/projects/new` | Form renders all fields, progressive metadata collapsible works, submit creates project, redirects to project page |
| 5 | **Project List** | `GET /api/projects`, `/projects` | Lists created projects, cards show metadata badges, links work |
| 6 | **Start Assessment** | `POST /api/assessments`, `/assessment/[id]` | Assessment creates with engine state, page loads questions, stage selector works |
| 7 | **Take Assessment** | `PUT /api/assessments/[id]`, `/assessment/[id]` | Answer questions (gate, likert-5, checklist types), auto-save fires (verify PUT in network tab), progress updates, navigation guard on unload |
| 8 | **Complete Assessment** | `POST /api/assessments/[id]/complete` | Completion modal appears, completion saves report data + score, redirects to report |
| 9 | **View Report** | `/assessment/[id]/report` | Report renders with scores, area cards, principle scorecards, influence cards, references, controls |
| 10 | **Download PDF** | `GET /api/reports/[id]/pdf` | PDF downloads, opens correctly, contains project name + scores |
| 11 | **Comparison Charts** | `/projects/[id]/compare` | RadarChart, TrendChart, GapHeatmap render (test with 0 and 1+ completed assessments) |
| 12 | **Explore: Framework** | `/explore/framework` | Page loads, interactive framework map works, stage navigation |
| 13 | **Explore: Controls** | `/explore/controls` | Page loads, control library renders, search/filter works |
| 14 | **Explore: About** | `/explore/about` | Page loads, content renders correctly |
| 15 | **Admin: Users** | `/admin/users` | Table renders all users, role badges show, action buttons present (requires admin account) |
| 16 | **Admin: Assessments** | `/admin/assessments` | Summary cards compute, sortable table works |
| 17 | **Admin: Settings** | `/admin/settings` | Platform statistics compute correctly |
| 18 | **Data Export** | `GET /api/users/me/export` | JSON downloads with all user data, no password hash |
| 19 | **Account Deletion** | `DELETE /api/users/me` | Requires "DELETE MY ACCOUNT" confirmation, cascades all data |
| 20 | **Research Export** | `GET /api/research/export` | Admin-only, returns only consented users' anonymized data |
| 21 | **Remediation** | `GET/POST/PATCH /api/assessments/[id]/remediation` | Create items, mark complete, verify persistence |
| 22 | **Logout** | Sidebar sign-out button | Session cleared, redirects to `/login` |

#### Per-Page Checks

For every page load:
- [ ] Page renders without blank screen
- [ ] No console errors (check DevTools console)
- [ ] No failed network requests (check DevTools network tab)
- [ ] CSS applies correctly (no unstyled content, no layout breaks)
- [ ] Interactive elements respond (buttons, links, forms)
- [ ] Responsive at 1440px, 1024px, 768px widths

### 1.4 Phase 2: Fix Discovered Issues

Every bug found in Phase 1 gets fixed immediately before proceeding to Phase 3.

**Expected issue categories:**
- Missing Suspense boundaries for `useSearchParams()` / `useParams()`
- Runtime import failures for `.js` engine files
- CSS class mismatches from SPA migration
- Null/undefined edge cases in data rendering
- Missing error states (loading, empty, error)
- Navigation/redirect issues between route groups

**Fix protocol:**
1. Document the bug (page, action, expected vs actual)
2. Fix the root cause
3. Re-verify the specific flow
4. Run `npx vitest run` to confirm no regressions
5. Commit with `fix: <description>`

### 1.5 Phase 3: Playwright Regression Suite

Convert verified flows into automated Playwright tests. Extend existing `e2e/auth.spec.ts` and `e2e/project.spec.ts`, add new test files.

#### Test File Plan

| File | Flows Covered |
|------|--------------|
| `e2e/auth.spec.ts` | (existing) Registration, login, redirect — extend with logout, error cases |
| `e2e/project.spec.ts` | (existing) Project creation — extend with edit, delete, list |
| `e2e/assessment.spec.ts` | (new) Start assessment, answer questions, auto-save, complete |
| `e2e/report.spec.ts` | (new) View report, verify sections render, PDF download |
| `e2e/explore.spec.ts` | (new) Framework, controls, about pages load without errors |
| `e2e/admin.spec.ts` | (new) Admin user table, assessments overview, settings stats |
| `e2e/comparison.spec.ts` | (new) Comparison charts with 0 and 1+ assessments |
| `e2e/account.spec.ts` | (new) Data export, account deletion |

#### Test Infrastructure

- Add `package.json` scripts: `"test:e2e": "npx playwright test"`, `"test:e2e:headed": "npx playwright test --headed"`
- Test database: use the same Docker PostgreSQL but with a `makrai_test` database
- Test seed data: create a Playwright global setup that seeds a test user + project + completed assessment
- Parallel: disabled (flows depend on sequential state)

---

## 2. Security Hardening

### 2.1 Problem Statement

Ship-gate flagged: zero rate limiting, 3 missing HTTP headers, weak CSP. No account lockout, no security logging, no CORS config. The platform will be internet-facing at `rai.air.ug` on a Hetzner CX32.

> **NAT-Aware Design (What-If Oracle finding):** The first real deployment is a training room in Douala where 30+ participants share one institutional NAT IP. IP-based rate limiting at low thresholds will block legitimate users. Solution: Nginx rate limits stay IP-based but with high thresholds (DDoS protection only). Application-level rate limiting uses `userId` for authenticated routes and IP only for pre-auth endpoints (login/register).

### 2.2 Layer 1: Nginx Rate Limiting + Headers

#### File: `docker/nginx/default.conf` (modify)

**Rate limiting zones** (add to `http` block):

```nginx
limit_req_zone $binary_remote_addr zone=auth:10m rate=20r/m;    # Higher: 30 users behind NAT
limit_req_zone $binary_remote_addr zone=api:10m rate=300r/m;    # Higher: 30 concurrent users
limit_req_zone $binary_remote_addr zone=global:10m rate=600r/m;  # DDoS baseline only
```

> Nginx limits are deliberately high — they protect against DDoS, not per-user abuse. Per-user abuse prevention is handled at the application layer (Layer 2) using `userId`.

**Zone application** (add to `location` blocks):

```nginx
location /api/auth/ {
    limit_req zone=auth burst=3 nodelay;
    limit_req_status 429;
    proxy_pass http://nextjs:3000;
}

location /api/ {
    limit_req zone=api burst=20 nodelay;
    limit_req_status 429;
    proxy_pass http://nextjs:3000;
}

location / {
    limit_req zone=global burst=40 nodelay;
    proxy_pass http://nextjs:3000;
}
```

**Additional security headers:**

```nginx
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=()" always;
```

### 2.3 Layer 2: Application-Level Rate Limiting

#### File: `lib/rate-limit.ts` (new)

In-memory sliding window rate limiter. No external dependencies (no Redis — single-server deployment).

**Implementation:**
- `Map<string, { count: number; resetAt: number }>` keyed by `${identifier}:${endpoint}`
- `identifier` = `userId` for authenticated routes, `ip` for pre-auth routes
- Periodic cleanup of expired entries (every 60s via `setInterval`)
- Returns `{ success: boolean; remaining: number; resetAt: Date }`

**Rate limit configuration (dual-key: userId vs IP):**

```typescript
export const RATE_LIMITS = {
  // Pre-auth: keyed by IP (no userId available yet)
  'POST:/api/auth/register': { window: 15 * 60 * 1000, max: 5, keyBy: 'ip' },
  'POST:/api/auth': { window: 15 * 60 * 1000, max: 15, keyBy: 'ip' },
  // Authenticated: keyed by userId (NAT-safe)
  'DELETE:/api/users/me': { window: 60 * 60 * 1000, max: 1, keyBy: 'userId' },
  'default': { window: 60 * 1000, max: 60, keyBy: 'userId' },
} as const;
```

> **Why dual-key:** Pre-auth endpoints (login, register) can only be keyed by IP — there's no session yet. But limits are raised to 15/15min to accommodate 30 users behind NAT logging in during training setup. Authenticated endpoints use `userId` — completely NAT-safe, each user gets their own quota.

#### File: `middleware.ts` (new)

Next.js root middleware that:
1. Extracts client IP from `x-forwarded-for` or `x-real-ip`
2. For authenticated requests: extracts `userId` from JWT session token
3. Matches request path + method against `RATE_LIMITS`
4. Uses `keyBy` to determine whether to key by IP or userId
5. On limit exceeded: returns 429 with `Retry-After` header
6. On success: adds `X-RateLimit-Remaining` header and passes through
7. **Matcher config:** excludes `/_next/*`, `/static/*`, `/favicon.ico` from middleware (prevents static asset requests from counting toward limits)

### 2.4 Layer 3: Auth Hardening

#### 2.4.1 Account Lockout

**Schema change** — add to `User` model in `prisma/schema.prisma`:

```prisma
failedLoginAttempts Int       @default(0)
lockedUntil         DateTime?
```

**Auth logic change** — modify `lib/auth.ts` credentials authorize:
1. Before password check: if `lockedUntil > now`, return null (still locked)
2. On wrong password: increment `failedLoginAttempts`. If >= 5, set `lockedUntil = now + 15min`
3. On correct password: reset `failedLoginAttempts = 0`, clear `lockedUntil`
4. Always return generic "Invalid email or password" — never reveal whether email exists

#### 2.4.2 CORS Configuration

**File: `next.config.ts` (modify)**

```typescript
async headers() {
  return [{
    source: '/api/:path*',
    headers: [
      { key: 'Access-Control-Allow-Origin', value: process.env.NEXTAUTH_URL || 'http://localhost:3000' },
      { key: 'Access-Control-Allow-Methods', value: 'GET,POST,PUT,PATCH,DELETE,OPTIONS' },
      { key: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization' },
    ],
  }];
},
```

#### 2.4.3 Input Validation

**File: `lib/validate.ts` (new)**

Validation functions used by API routes:
- `validateEmail(email: string)` — RFC 5322 pattern, max 254 chars
- `validatePassword(password: string)` — min 8 chars, max 128 chars
- `validateString(value: string, maxLength: number)` — trim, limit length
- `sanitizeInput(value: string)` — strip control characters, normalize whitespace

**Apply to:** `/api/auth/register` (email, password, name), `/api/projects` (name, description), `/api/assessments/[id]/remediation` (description)

#### 2.4.4 Security Event Logging

**File: `lib/security-log.ts` (new)**

```typescript
interface SecurityEvent {
  timestamp: string;
  event: 'login_failed' | 'login_success' | 'account_locked' | 'registration' |
         'account_deleted' | 'admin_action' | 'rate_limited' | 'auth_bypass_attempt';
  ip: string;
  userId?: string;
  details?: Record<string, unknown>;
}
```

**Log destinations:**
- Development: `console.warn` (structured JSON)
- Production: append to `/var/log/makrai/security.log` (one JSON object per line)

**Instrumented endpoints:**
- `POST /api/auth/[...nextauth]` — login success/failure/lockout
- `POST /api/auth/register` — registration attempts
- `DELETE /api/users/me` — account deletion
- `middleware.ts` — rate limit hits
- Admin routes — admin actions

### 2.5 Layer 4: Penetration Test Script

#### File: `scripts/pen-test.ts` (new)

Automated security test that runs against a live instance. Requires a running server.

**Test matrix:**

| # | Vector | Method | Expected Result | Severity |
|---|--------|--------|-----------------|----------|
| 1 | Brute force login | 20 rapid POSTs with wrong password | 429 after rate limit, account locked after 5 | Critical |
| 2 | Registration spam | 10 rapid POSTs to register | 429 after 3 | High |
| 3 | SQL injection | Email: `' OR 1=1; --` | 400 validation error | Critical |
| 4 | XSS stored | Project name: `<script>alert(1)</script>` | Stored safely, rendered escaped | Critical |
| 5 | CSRF | POST `/api/projects` without session | 401 Unauthorized | High |
| 6 | Auth bypass | GET `/admin/*` as non-admin | Redirect to `/dashboard` | Critical |
| 7 | Privilege escalation | GET `/api/research/export` as assessor | 403 Forbidden | Critical |
| 8 | Path traversal | GET `/api/projects/../../etc/passwd` | 404 Not Found | High |
| 9 | Header check | HEAD on all endpoints | All security headers present | Medium |
| 10 | Rate limit verification | Exceed each zone's limit | 429 with Retry-After | High |

**Output:** Markdown report at `reports/pen-test-YYYY-MM-DD.md` with pass/fail per test, response details, and overall security score.

**Run command:**
```bash
npx tsx scripts/pen-test.ts --url http://localhost:3000
```

---

## 3. File Change Summary

### New Files (7)

| File | Purpose |
|------|---------|
| `lib/rate-limit.ts` | In-memory sliding window rate limiter |
| `middleware.ts` | Next.js root middleware for rate limiting |
| `lib/validate.ts` | Input validation and sanitization functions |
| `lib/security-log.ts` | Structured security event logging |
| `scripts/pen-test.ts` | Automated penetration test script |
| `e2e/assessment.spec.ts` | Assessment flow E2E tests |
| `e2e/report.spec.ts` | Report flow E2E tests |

### Modified Files (6)

| File | Changes |
|------|---------|
| `docker/nginx/default.conf` | Rate limiting zones, missing headers |
| `prisma/schema.prisma` | Add `failedLoginAttempts`, `lockedUntil` to User |
| `lib/auth.ts` | Account lockout logic in credentials authorize |
| `next.config.ts` | CORS headers configuration |
| `app/api/auth/register/route.ts` | Input validation |
| `package.json` | Add `test:e2e` and `test:e2e:headed` scripts |

### New E2E Test Files (6)

| File | Coverage |
|------|----------|
| `e2e/assessment.spec.ts` | Start, answer, auto-save, complete |
| `e2e/report.spec.ts` | View report, PDF download |
| `e2e/explore.spec.ts` | Framework, controls, about |
| `e2e/admin.spec.ts` | Users, assessments, settings |
| `e2e/comparison.spec.ts` | Charts with varying data |
| `e2e/account.spec.ts` | Data export, account deletion |

### Bug Fix Files (unknown count)

Files discovered and fixed during Phase 1 manual verification. Cannot be enumerated in advance.

---

## 4. Execution Order

1. **Runtime verification Phase 1** — start server, walk through all 22 flows
2. **Runtime verification Phase 2** — fix all discovered bugs
3. **Security hardening Layers 1-3** — implement rate limiting, headers, auth hardening, validation, logging
4. **Prisma migration** — deploy schema changes for account lockout fields
5. **Security hardening Layer 4** — write and run penetration test
6. **Runtime verification Phase 3** — write Playwright regression tests for all flows
7. **Final verification** — run full test suite (`vitest` + `playwright`) + pen test

---

## 5. Success Criteria

- All 22 flows verified working in a browser with screenshot evidence
- All bugs discovered in Phase 1 fixed and committed
- 80+ unit tests still passing (no regressions)
- 8+ Playwright E2E test files covering all critical flows
- Nginx rate limiting active on auth (5/min) and API (60/min)
- Application-level rate limiting on registration (3/15min) and login (10/15min)
- Account lockout after 5 failed attempts (15-min cooldown)
- All security headers present (HSTS, X-Frame-Options, X-Content-Type-Options, CSP, Referrer-Policy, Permissions-Policy)
- Input validation on all user-facing endpoints
- Security events logged in structured format
- Penetration test passes all 10 vectors
- Zero critical or high vulnerabilities in pen test report
