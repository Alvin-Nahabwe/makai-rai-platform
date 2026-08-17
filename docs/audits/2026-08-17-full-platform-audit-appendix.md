# Full platform audit — appendix: all 195 findings with verification verdicts

**Generated mechanically from the structured auditor results** (17 dimensions, 2026-08-16/17).
Critical/High findings carry an adversarial-verification verdict from an independent verifier
who re-checked the evidence against the repo. Severities shown are POST-verification.
Medium/Low findings were not individually re-verified (sweep-level confidence labels apply).

## api-surface

The API surface is unusually disciplined: every org-scoped route funnels authorization through requireOrgContext (the gate IS the decision), errors map through one toResponse helper, not-found/other-org are deliberately indistinguishable per ADR-0001, and preauth surface + route-action completeness are pinned by generated tests. I found no tenancy, IDOR, authz-bypass, or org-existence-leak defect in the routes I read. The defects that remain are robustness and anti-abuse gaps at the input boundary: two account-lifecycle routes 500 on malformed JSON instead of 400; the assessment engineState is persisted as an unvalidated, unbounded blob that later drives scoring; CSRF protection for every mutating v1 route rests entirely on an unpinned NextAuth SameSite default with only the admin route adding defense-in-depth; and the invitation-based account-creation path is not covered by the registration rate limit its sibling route reasons about at length. No confirmed Critical/High.

**Sound (what is genuinely good):**
- Authorization is uniform and correct-by-construction: every org-scoped route calls requireOrgContext(slug, action) / requireOrgContextWithIdentity, with role read fresh from the membership row and orgId = org.id read from the DB, never client-derived (lib/auth/context.ts:47-70).
- Org-existence probing is defended even against timing: requireOrgContextFor runs orgBySlug and membershipsForUser unconditionally via Promise.all so the 'unknown slug' and 'not a member' branches do equal DB work, and both throw the same detail-free NotFoundError -> identical 404 (context.ts:38-60).
- Error handling is centralized and honest: toResponse maps only the known error types and rethrows everything else as a loud 500 rather than laundering it into a misleading 4xx (lib/http/toResponse.ts:25-42).
- INSERT routes write orgId as a WITH-CHECK-verified value (assessments, projects create), not as a read filter that would mask RLS — consistent with ADR-0001.
- Completeness is enforced mechanically: port-completeness.test.ts enumerates every route from disk and requires each to be in ROUTE_ACTIONS or NON_ACTION_ROUTES; preauth-surface.test.ts pins the exact BYPASSRLS export list; permission-matrix asserts one SUCCESS_STATUS entry per declared method.
- The evidence upload/download routes fail closed on every accept/reject decision, discard the client-declared Content-Type in favour of magic-byte inspection, verify SHA-256 before serving, and escape Content-Disposition per RFC 6266 — genuinely careful.
- The admin role route adds an explicit cross-origin Origin check as CSRF defense-in-depth, self-demotion/last-admin protection, and enum-validates the role value.
- A password-reset backing route is intentionally absent and the forgot-password page is an honest 'not available yet, contact your administrator' stub (not a broken form or 404), tracked at D-048.
- Account deletion (DELETE /api/users/me) and its last-owner guards are carefully designed as a two-phase TOCTOU-safe operation with SELECT ... FOR UPDATE and a documented residual (D-119).

### API-01 [Medium] engineState PATCH persists an unvalidated, unbounded client blob that later drives scoring
*app/api/v1/orgs/[slug]/assessments/[id]/route.ts:88* — sweep confidence: confirmed

**Claim.** PATCH /api/v1/orgs/[slug]/assessments/[id] accepts body.engineState with only a shallow shape check (must be an object with .stages or .quick) and writes the entire client-supplied blob verbatim into the assessment row; there is no structural validation, no size bound, and no check that the blob's shape matches the assessment's mode. This same blob is later fed to generateReportData/getQuickScore at completion.

**Evidence.** app/api/v1/orgs/[slug]/assessments/[id]/route.ts:88-95 '`const { engineState } = body; if (!engineState || typeof engineState !== object || (!engineState.stages && !engineState.quick)) ... const result = await respondToAssessment(ctx, id, engineState)`'; lib/data/assessments.ts:87 '`tx.assessment.update({ where: { id }, data: { engineState } })`'. The engine indexes state.stages[stage].status unguarded (lib/engine/AssessmentEngine.js:58,128-135,185) and throws on unexpected shapes.

**Impact.** A member with assessment:respond can store a structurally-malformed or semantically-wrong engineState in their org. A later completeAssessment scores it: a malformed blob makes generateReportData throw -> unmapped error -> 500 (loud but a stored poison row that keeps 500ing on complete), while a valid-but-wrong-shape blob (e.g. a quick blob PATCHed onto a full assessment) can produce a nonsense score cached immutably as reportData. Confined to the caller's own org, so not a tenancy breach, but a data-integrity/robustness gap.

**Direction (not an implementation).** Validate engineState against the engine's expected schema (and against the assessment's mode) before persisting, and bound its serialized size; reject with 400 rather than storing a blob that only fails at completion time.

### API-02 [Medium] CSRF posture for every mutating v1 route rests on an unpinned SameSite default with no defense-in-depth
*lib/auth.ts:158* — sweep confidence: confirmed

**Claim.** All state-changing v1 org routes and users/me routes are cookie-session authenticated and parse JSON bodies, but none check Origin/Referer or a CSRF token; their only cross-site-forgery protection is NextAuth's default session cookie SameSite=Lax. lib/auth.ts configures no explicit `cookies`/`sameSite`, and only the admin route adds an explicit Origin check. No test pins the SameSite attribute.

**Evidence.** grep for Origin checks across app/api returns a real header check only in admin/users/[id]/role/route.ts:43-47; the other 'origin' hits are req.nextUrl.origin usage. lib/auth.ts:35-159 sets session strategy/maxAge but no cookies block (relies on Auth.js Lax default). req.json() in the v1 routes parses the body regardless of Content-Type, so content-type is not itself a barrier.

**Impact.** Today cross-site POSTs do not carry the Lax cookie, so there is no live CSRF hole. But the entire protection is one undocumented framework default with no second layer and no regression test: a future change enabling embedding (SameSite=None), a NextAuth default change, or a custom cookie config would silently expose every mutating route (project/assessment/member/evidence create-update-delete, account deletion) to CSRF, and only the admin route would survive.

**Direction (not an implementation).** Add an explicit cookies.sameSite='lax' setting plus an Origin/Referer check (or CSRF token) shared across mutating handlers as defense-in-depth, and add a test pinning the session cookie's SameSite attribute.

### API-03 [Medium] Invitation-based account creation is not covered by the registration rate limit
*lib/rate-limit.ts:52* — sweep confidence: confirmed

**Claim.** POST /api/v1/invitations/[token]/register creates a real User (bcrypt hash cost 12) but has no entry in RATE_LIMITS, so it falls to 'default' (60 requests / 60s, keyBy 'userId' which is null pre-auth -> keyed by the client-controlled IP). Its sibling POST /api/auth/register has a bespoke, heavily-reasoned 50/15min bucket. The register route's long rate-limit rationale never mentions this second pre-auth account-creation path.

**Evidence.** lib/rate-limit.ts:20-71 RATE_LIMITS has keys for /api/auth/register, /api/auth, DELETE /api/users/me, evidence upload, and default only — no invitations key; default is '{ window: 60*1000, max: 60, keyBy: userId }'. app/api/v1/invitations/[token]/register/route.ts:63 '`const passwordHash = await hash(password, 12)`'. NON_ACTION_ROUTES lists this route as identity-exempt but rate-limiting is orthogonal to that.

**Impact.** A gap in the anti-abuse thinking rather than a live exploit: abuse requires a valid, unexpired, pending invitation token (invitationByToken 404s before bcrypt if absent, route.ts:28-31), so bcrypt cost is only incurred with a real token. But per-IP 60/min on an account-creation endpoint is far more permissive than the sibling register route's own derived cap, and the inconsistency is undocumented.

**Direction (not an implementation).** Give the invitation-register route its own rate-limit bucket consistent with /api/auth/register's threat derivation, and note the second account-creation path in that derivation.

### API-04 [Low] DELETE /api/users/me and POST /api/users/me/password 500 on malformed JSON bodies
*app/api/users/me/route.ts:62* — sweep confidence: confirmed

**Claim.** In both routes, request.json() is called OUTSIDE any try/catch (only identity resolution is wrapped). A syntactically-invalid JSON body throws an unhandled error, producing a generic 500 instead of a 400. Other mutating routes wrap their whole handler in try/catch and would return a mapped error.

**Evidence.** app/api/users/me/route.ts:54-62 — try{...requireIdentityForApi}catch{return toResponse}; then line 62 '`const body = await request.json();`' unguarded. app/api/users/me/password/route.ts:9-23 — same structure, line 23 '`const body = await request.json();`' unguarded (and a non-UnauthenticatedError from requireIdentityForApi is rethrown as 500 at line 20).

**Impact.** Inconsistent error contract and a robustness gap: a malformed body to two account-lifecycle endpoints yields 500 (server error) rather than 400 (client error). Low severity — no security impact, but it violates the surface's otherwise-consistent 4xx-on-bad-input discipline and can mask genuine client bugs as server errors.

**Direction (not an implementation).** Wrap body parsing (and the rest of the handler) so a malformed body returns 400, matching the register/v1 routes' pattern.

### API-05 [Low] No request-body size limit on any JSON route handler (register D-152 covers only evidence)
*next.config.ts:44* — sweep confidence: confirmed

**Claim.** Next.js's experimental.serverActions.bodySizeLimit ('2mb' in next.config.ts) governs Server Actions only, not App Router route handlers (documented in D-152). Every JSON route buffers the whole body via req.json() with no size cap. D-152 tracks this exhaustion risk only for the evidence upload route; the JSON routes (engineState PATCH, project/assessment/member create) have no register row and no guard.

**Evidence.** next.config.ts:43-47 only sets serverActions.bodySizeLimit; D-152 (docs/DEFERRED_REGISTER.md:201) confirms 'there is no platform-level backstop for this route' and is scoped to evidence. All 10 req.json()/request.json() sites (grep output) parse unbounded bodies; the engineState PATCH is the sharpest instance (see API-01).

**Impact.** A single authenticated request can force the server to buffer an arbitrarily large JSON body in memory before any validation runs — memory-pressure DoS, bounded only by rate limits (60/min/user for most routes). Low today (authenticated, in-memory rate-limited), but it is an unbounded-input class the register only tracks for one route.

**Direction (not an implementation).** Add a shared body-size guard (Content-Length pre-check + bounded read) for JSON route handlers, or extend the D-152 register row to cover the JSON surface explicitly.

### API-06 [Low] Admin route's Origin CSRF check can 500 on a malformed Origin and is skipped when Origin is absent
*app/api/admin/users/[id]/role/route.ts:45* — sweep confidence: confirmed

**Claim.** The admin role route's CSRF guard does `new URL(origin)` on the raw Origin header outside any try/catch; a malformed Origin value throws -> unhandled 500. The check is also skipped entirely when the Origin header is absent ('if (origin && ...)'), relying on the assumption that 'Browsers always send Origin on POST'.

**Evidence.** app/api/admin/users/[id]/role/route.ts:43-47 '`const origin = request.headers.get(origin); const host = request.headers.get(host); if (origin && new URL(origin).host !== host) { return ... 403 }`' — the only try in the handler wraps identity resolution (lines 24-36), not this block.

**Impact.** Minor: an attacker sending a malformed Origin gets a 500 rather than a clean 403, and a request with no Origin bypasses this specific check (though SameSite=Lax still blocks the cross-site cookie). Defense-in-depth control is itself slightly brittle.

**Direction (not an implementation).** Guard the URL parse and treat a present-but-unparseable Origin as a rejection; document that the absent-Origin path is covered by SameSite.

### API-07 [Low] Privacy page promises 'delete your account' but the implementation is deactivate-and-scrub, not deletion
*app/(public)/privacy/page.tsx:52* — sweep confidence: confirmed

**Claim.** The privacy page tells users they can 'delete your account from your account settings', but DELETE /api/users/me performs a deactivate-and-scrub (isActive=false, PII scrubbed, consent rows deleted, random password) and deliberately never removes the User row; evidence bytes are also kept with attribution scrubbed. The user-facing word 'delete' overstates what happens.

**Evidence.** app/(public)/privacy/page.tsx:52 'You can export your data or delete your account from your account settings.'; app/api/users/me/route.ts:12-21,119-130 documents deactivate-and-scrub ('identityDb ... exposes no User.delete'); D-171 notes scrubUserOnDeactivation touches only the User row and ConsentRecords, evidence bytes retained.

**Impact.** A privacy-policy honesty gap rather than a defect: PII is scrubbed so the spirit of 'delete' is arguably met, but a user reading 'delete your account' may believe all their data (including retained evidence bytes and the persisted scrubbed row) is gone. Also: org deletion is promised nowhere and does not exist (D-172, org:delete is an orphaned grant), which is at least consistent with the page.

**Direction (not an implementation).** Align the privacy wording with the actual deactivate-and-scrub semantics, or note what is retained (scrubbed identity row, evidence bytes with attribution removed).

**Not examined by this auditor:**
- Live end-to-end verification of actual HTTP status codes/response bodies against a running server — Read-only audit with no running app; all status-code claims are from reading handler source, not from driving real requests. The malformed-JSON->500 and rate-limit-key claims are code-confirmed but not live-confirmed.
- Full internals of lib/data/{identity,members,evidence}.ts (removeMember/createInvitation role-cap enforcement, scrubUserOnDeactivation, createEvidence) — Adjacent data-layer dimension; I read only the seams the routes call into. The role-cap-at-invite and last-owner invariants are asserted in comments and members.test.ts but I did not re-derive them.
- lib/authz/policy.ts grant matrix correctness (which role gets which Action) — The RBAC/authz policy is a distinct audit dimension; I verified routes consult the declared action but not that each action's role set is correct.
- lib/auth/identity.ts resolveIdentity (sessionEpoch/isActive/maxAge/mustChangePassword enforcement) — Auth/session dimension; I confirmed routes call requireIdentityForApi but did not audit the fresh-read logic it performs.
- Whether NextAuth v5's built-in /api/auth/* CSRF token and the credentials callback are themselves hardened — The [...nextauth] catch-all delegates entirely to the framework handlers; framework-internal behaviour was out of scope beyond confirming the app's own secret wiring.

## assessment-client

All five register rows were verified against the code and every one is accurate: D-185's guardless setEngineState, D-198's impure updaters, D-145's bare catches, D-170's per-question-only stale flag, and D-169's absent DOM test infra are all still present exactly as recorded. Beyond the known rows, the save path is structurally fire-and-forget full-document replacement with zero concurrency control at any layer — autoSave never checks res.ok so server 409/401/500 refusals are invisible while the user keeps answering; the completion handlers never cancel the pending debounce timer (the D-130 race's enabling condition); Assessment.version is an attempt counter, not the optimistic lock D-104 has demanded since 2026-08-03; and the server-side "fixed" completion race is narrowed, not closed (READ COMMITTED, no FOR UPDATE, despite Task 7 setting the FOR UPDATE precedent elsewhere). The whole flow currently has no automated coverage: the e2e spec is test.fixme-quarantined and jsdom (ruled ADD IT 2026-08-12) has not landed.

**Sound (what is genuinely good):**
- Register accuracy is exemplary: every line citation in D-185, D-198, D-145, D-170 and D-169 still matches the code exactly (e.g. D-185's ':205', D-198's ':434'/':449') — the register is a trustworthy map of this component's defects, which is rare.
- Authorization design is correct: canRespond/canComplete/canCreateEvidence/canDeleteEvidence are derived server-side in page.tsx:46-49 via can(ctx.role,...), single authority, never re-derived client-side, and the routes independently enforce the same actions.
- The evidence mutate-then-confirm design (AssessmentPageClient.tsx:502-557) is genuinely thoughtful: three-way result distinguishing 'your change failed' from 'saved but unconfirmed' (evidenceStale), authoritative re-fetch instead of optimistic patching, and honest three-state loading/error/empty handling.
- The legacy quick-mode guard (lines 193-206, 682-712) correctly refuses to load a quick-shaped blob into the full-lifecycle engine state, preventing silent corruption of retired-flow rows.
- Modals use native <dialog> with showModal() (focus trap + Escape free), module tabs implement the WAI-ARIA tabs pattern with roving tabindex and arrow keys, and radiogroups are labelled via aria-labelledby.
- Server-side score computation in completeAssessment (lib/data/assessments.ts:189-206) prevents client score forgery; completion is idempotent; O-14 drift guards exist on both write paths with deliberately distinct 409 messages for testability.

### AC-04 [High] autoSave never checks res.ok: every server refusal (409 drifted/completed, 401, 500) is silently swallowed with no user feedback, no retry, no dirty indicator
*app/(authenticated)/orgs/[slug]/assessment/[id]/AssessmentPageClient.tsx:318* — sweep confidence: confirmed

**Claim.** autoSave fires a PATCH and inspects nothing: fetch resolves on 4xx/5xx so even the bare catch never runs, and the comment's 'user can retry' is fiction because the user is never told anything failed. There is no saved/saving/failed indicator anywhere in the UI.

**Evidence.** AssessmentPageClient.tsx:318-331: 'await fetch(apiBase, { method: &#x27;PATCH&#x27; ... }); } catch { // Auto-save failures are silent — user can retry }' — no res.ok check. The PATCH route returns 409 for &#x27;completed&#x27; and &#x27;drifted&#x27; (route.ts:98-119), 404, 400. QuestionBlock.tsx:15-17's own doc admits 'an answer it submits would 403 on the autosave PATCH, silently'.

**Impact.** If framework content drifts mid-session, the assessment is completed in another tab, or the session expires, the server correctly refuses every subsequent PATCH while the UI happily accepts answers — a user can work for an hour and lose everything, discovering it only on reload. This weaponizes the (correct) O-14/O-24 server guards into unbounded silent client-side data loss. Related to but broader than D-130, which names the no-res.ok gap only on the completion path.

**Direction (not an implementation).** Check res.ok in autoSave; surface a persistent save-state indicator (saved/saving/failed with reason); on 409 drifted/completed, hard-disable inputs and tell the user why.

**Verification: CONFIRMED.** Verified directly: autoSave awaits the PATCH with no res.ok inspection and a bare silent catch, while the route genuinely returns 409 for both completed and drifted assessments — so every server refusal (completed-in-another-tab, framework drift mid-session, expired session, revoked role) is invisible while the UI keeps accepting answers, and the component has no saved/saving/failed indicator anywhere and no status-driven input disabling (disabled is authz-only via canRespond). I tried to kill it by hunting for a compensating mechanism — a re-fetch on focus, a status poll, res.ok handling elsewhere on the autosave path, a dirty-state warning keyed to failed saves — and found none; QuestionBlock's own doc comment admits the silent-403 case. Production-reachable unbounded silent data loss on the product's core workflow justifies High.

*Verifier evidence:* AssessmentPageClient.tsx:318-331 ('await fetch(apiBase, { method: PATCH ... }); } catch { // Auto-save failures are silent — user can retry }' — no res.ok), :813 (disabled={!canRespond}, authz not status); app/api/v1/orgs/[slug]/assessments/[id]/route.ts:98-118 (409 'Completed assessments cannot be modified' and 409 drifted); components/assessment/QuestionBlock.tsx:13-17 ('an answer it submits would 403 on the autosave PATCH, silently'); grep for saved/saving indicator across the 890-line component: none.

### AC-05 [High] No optimistic locking or conflict detection anywhere: two tabs/users silently clobber each other via full-document engineState replacement; Assessment.version is an attempt counter, not a concurrency token
*lib/data/assessments.ts:87* — sweep confidence: confirmed

**Claim.** respondToAssessment writes the client's entire engineState blob with no version/updatedAt precondition, so the last writer wins wholesale; the schema's Assessment.version field (schema.prisma:166) is written once at creation as an attempt counter and never read or checked on any write path — it does not implement, and its name collides with, the 'version Int plus updateMany({ where: { id, version }})' fix D-104 prescribed.

**Evidence.** lib/data/assessments.ts:87: 'await tx.assessment.update({ where: { id }, data: { engineState } })' — no precondition. schema.prisma:166: 'version Int @default(1)'. Sole writer: app/api/v1/orgs/[slug]/assessments/route.ts:100 'version: existingCount + 1' at creation; lib/data/framework.ts:42 calls it 'an attempt counter'. grep across lib/ and app/ found no other read/write of Assessment.version.

**Impact.** Two assessors (the platform's explicit multi-user purpose) or one user's two tabs answering the same assessment: each tab holds a full engineState copy and each debounced PATCH replaces the whole document, silently destroying the other's answers with nothing marking the loss. D-104 (Open since 2026-08-03) says this must be fixed 'before the first real team uses the product concurrently'; four phases later nothing has moved, and the field name its cheapest fix proposed has meanwhile been taken by an unrelated semantic.

**Direction (not an implementation).** Add a real concurrency token (updatedAt precondition or a new revision column — version is taken) checked in respondToAssessment's update, plus a client conflict UX; alternatively move to per-response writes so concurrent editors merge instead of clobber.

**Verification: CONFIRMED.** Every element of the claim checks out first-hand: respondToAssessment's update at lib/data/assessments.ts:87 replaces the entire engineState with no version/updatedAt precondition; Assessment.version (schema.prisma:166) is written exactly once at creation as 'existingCount + 1' and read only for display, so it is an attempt counter — framework.ts:42 says so in as many words — not the optimistic lock D-104 prescribed; grep found no updateMany precondition and no FOR UPDATE on assessment rows anywhere in lib/data (the FOR UPDATE precedent exists only in members.ts:130). I tried to refute via a guard elsewhere — the O-14 drift check and completed-status check are the only write gates and neither detects concurrent editors; RLS cannot help since both writers share the org. With multi-user org collaboration the platform's stated purpose and D-104 Open since 2026-08-03, silent last-writer-wins clobbering of the governance record is a concrete High; not Critical because the register consciously triages it as RISK with a pre-pilot pickup trigger and single-user single-tab flows are unaffected.

*Verifier evidence:* lib/data/assessments.ts:87 ('await tx.assessment.update({ where: { id }, data: { engineState } })'); prisma/schema.prisma:166 ('version Int @default(1)'); app/api/v1/orgs/[slug]/assessments/route.ts:100 ('version: existingCount + 1' — sole writer per grep); lib/data/framework.ts:42 ('Assessment.version (an attempt counter)'); grep 'FOR UPDATE|updateMany' lib/data/*.ts — only members.ts:130 and preauth.ts:322 (invitations); docs/DEFERRED_REGISTER.md D-104: Open, re-targeted 2026-08-09, 'the second save silently overwrites the first... nothing marks the loss'.

### AC-07 [High] Completion handlers never cancel the pending autosave debounce and never check res.ok — D-130's reproducible silent-failure bounce is fully intact
*app/(authenticated)/orgs/[slug]/assessment/[id]/AssessmentPageClient.tsx:592* — sweep confidence: confirmed

**Claim.** handleGenerateReport (:592-613) and handleContinueToNext (:615-638) PATCH and (for the former) POST /complete without clearing saveTimerRef, so a debounce armed by the final answer (near-certain when a user answers then clicks Complete within 1s) can land its stale pre-completion PATCH around the completion write; neither fetch checks res.ok and the catch says 'Continue to report even if API call fails', so a no_stages 400 or drifted 409 silently navigates to /report, which bounces back to the assessment page with no message ever shown.

**Evidence.** AssessmentPageClient.tsx:599-610: two awaited fetches, no res.ok, 'catch { // Continue to report even if API call fails }'; no clearTimeout(saveTimerRef.current) anywhere in either handler. report/page.tsx:60-63: 'if (assessment.status !== &#x27;completed&#x27;) { router.replace(...assessment/${assessmentId}); return; }'. D-130 register row: failure reproduced '3 consecutive single-worker reruns' via exactly this mechanism.

**Impact.** User clicks 'View Full Report', completion silently fails, and they are wordlessly bounced back to the page they left — the register's own e2e suite failed reproducibly on this, and it remains unchanged. Also the enabling condition for AC-06's server-side interleaving. handleContinueToNext additionally advances the UI to the next stage even when the completing PATCH was refused, after which every further answer is also silently discarded (AC-04).

**Direction (not an implementation).** Clear the pending debounce timer at the top of both handlers (its state is already included in the explicit PATCH), check res.ok on both calls, and block navigation with a visible error on failure.

**Verification: CONFIRMED.** Verified line-by-line: neither completion handler clears saveTimerRef (clearTimeout exists only inside autoSave itself at :319 and the unmount cleanup at :336), neither checks res.ok, both catches explicitly continue ('Continue to report even if API call fails' / 'Continue even if save fails'), and report/page.tsx:60-63 wordlessly bounces a non-completed assessment back — so a stale debounced PATCH racing the completion write produces exactly the silent no_stages-400-then-bounce loop D-130 reproduced in 3 consecutive single-worker e2e reruns, and nothing in the code has changed since that row was written. handleContinueToNext additionally advances selectedStage regardless of whether its PATCH was refused, after which AC-04 silently discards all further answers. I tried to kill it by checking whether autoSave's own clearTimeout-on-call covers the handlers (it does not — they fetch directly, never through autoSave) and whether the modal interaction delay outruns the 1s debounce (it does not close the window — the timer's async PATCH stays in flight past the debounce by network latency, and respondToAssessment has no precondition so last-landed wins). Reproduced-in-project, production-reachable, zero user feedback: High stands.

*Verifier evidence:* AssessmentPageClient.tsx:592-613 and :615-638 (no clearTimeout, no res.ok, 'catch { // Continue to report even if API call fails }'); grep clearTimeout in the file: only :319 and :336; app/(authenticated)/orgs/[slug]/assessment/[id]/report/page.tsx:60-63 ('if (assessment.status !== completed) { router.replace(...) }'); app/api/v1/orgs/[slug]/assessments/[id]/complete/route.ts:34-37 (no_stages → 400); lib/data/assessments.ts:87 (no precondition, last write wins); docs/DEFERRED_REGISTER.md D-130: 'failed reproducibly at the SAME step across three consecutive single-worker reruns... NO error ever surfaced to the user'.

### AC-01 [Medium] D-185 verified still present: mount effect sets engineState with no staleness/ordering guard
*app/(authenticated)/orgs/[slug]/assessment/[id]/AssessmentPageClient.tsx:205* — sweep confidence: confirmed

**Claim.** The mount effect's setEngineState(data.engineState) at line 205 remains completely guardless — no AbortController, no request-ordering token, no 'user has already edited' check, not even the isMountedRef guard its sibling setLoading has at :210 — so a late/duplicate GET response still overwrites newer local answers.

**Evidence.** AssessmentPageClient.tsx:204-206: '} else if (data.engineState) { setEngineState(data.engineState); }' inside the effect at :177-217; cleanup (:214-216) only flips isMountedRef. D-185's register row root-caused exactly this line with an instrumented reproduction ('two checked property writes, both true -> false ... 19ms after the last, late response landed').

**Impact.** Any duplicate, retried, or slow assessment GET that resolves after the user starts answering silently wipes their answers; the next answer then PATCHes the wiped full state to the server (full-document replacement), converting a transient UI wipe into permanent server-side data loss. Deterministic under dev StrictMode double-mount; production-reachable via retried/slow responses. Also note isMountedRef is shared across StrictMode mount cycles (remount sets it back to true), so it could not serve as the guard even where applied.

**Direction (not an implementation).** Abort the in-flight fetch in the effect cleanup (AbortController) AND ignore any response once the user has locally edited (e.g. a hasEditedRef or a monotonic request-sequence check) — the register's own analysis shows a timeout can never fix this.

**Verification: OVERSTATED (severity corrected to Medium).** The code claim is fully accurate — setEngineState(data.engineState) at :205 is guardless and the cleanup only flips isMountedRef — but the High severity rests on the assertion that the wipe is 'production-reachable via retried/slow responses', which my reading refutes: the component issues exactly one GET per mount in a production build (StrictMode double-mount is dev-only; next.config.ts never sets reactStrictMode, and D-185's own register row verifies the double-invoke functions are absent from react-dom's production bundle and records the production GET count as UNMEASURED), nothing in the component retries or re-fetches, and the loading gate at :648-658 prevents any input from rendering until that single fetch has settled — so no response can land after the user starts answering in production. Demonstrated harm is dev-mode answer wipes and the e2e quarantine, and the quarantine is already counted separately as AC-12. Residual uncertainty: D-185 records an unexplained 4-GET doubling in the failing dev run, so production exposure is unmeasured rather than disproven, but the affirmative production-reachability claim carrying the High is unsupported by any mechanism in the code.

*Verifier evidence:* AssessmentPageClient.tsx:204-206 (guardless setEngineState), :214-216 (cleanup flips isMountedRef only), :648-658 (loading gate hides inputs until fetch settles), :177-217 (single fetch per mount, deps [assessmentId, apiBase] both stable); next.config.ts (no reactStrictMode key — read whole file); playwright.config.ts:27 ('process.env.CI ? npm run start : npm run dev'); docs/DEFERRED_REGISTER.md row D-185: 'Every observation of this symptom... is under npm run dev', 'the production-build GET count is UNMEASURED', 'shouldDoubleInvokeUserFnsInHooksDEV is assigned !1' in react-dom production build.

### AC-02 [Medium] D-198 verified still present: autoSave side effect inside both setEngineState updater functions
*app/(authenticated)/orgs/[slug]/assessment/[id]/AssessmentPageClient.tsx:434* — sweep confidence: confirmed

**Claim.** handleResponseChange calls autoSave(next) at :434 and handleChecklistChange at :449, both inside setEngineState((prev)=>{...}) updaters, violating React's purity requirement for updaters.

**Evidence.** AssessmentPageClient.tsx:431-438: 'setEngineState((prev) => { ... const next = engineSetResponse(prev, selectedStage, qId, value); autoSave(next); return next; });' — identical shape at :441-452.

**Impact.** Under React 19 StrictMode the dev runtime deliberately double-invokes updaters that must be pure, arming the debounce timer twice per answer (masked only because clearTimeout re-arms); structurally worse, React may invoke an updater during a render it then discards, so autoSave can arm a PATCH persisting an engineState the user never reached — a phantom write. Register row D-198 (Open, Phase 1d) records this precisely; trigger has not fired.

**Direction (not an implementation).** Compute next outside the updater (responses are derivable from current state + event) and call setEngineState(next); autoSave(next) sequentially, or move autosave into an effect keyed on engineState.

### AC-03 [Medium] D-145 verified still present: StartAssessmentButton parses body before res.ok; four bare catches remain in the client
*components/assessment/StartAssessmentButton.tsx:33* — sweep confidence: confirmed

**Claim.** StartAssessmentButton still calls await res.json() unconditionally before checking res.ok, with the bare catch at :39 replacing any real server error (including a non-JSON 500 page or auth failure) with 'Something went wrong. Please try again.' AssessmentPageClient retains exactly the four bare catch blocks the register counted.

**Evidence.** StartAssessmentButton.tsx:33-40: 'const data = await res.json(); if (!res.ok) {...} catch { setError(&#x27;Something went wrong...&#x27;) }'. AssessmentPageClient.tsx bare catches at :207 (fetchAssessment), :327 (autoSave), :608 (handleGenerateReport), :627 (handleContinueToNext) — matching D-145's reconciliation note 'four bare catch blocks remain'.

**Impact.** Users see a generic message where the server sent a specific one (e.g. the framework-drift 409's explanatory text, or resolvePublishedVersionId's 500); auth failures are indistinguishable from network blips. D-145 is Open, re-targeted twice already, recommended as 'Phase 1d — first task, not an incidental pickup' — a third pass has now also not landed it.

**Direction (not an implementation).** The shared fetch-and-parse helper D-145 itself prescribes (surface res.status plus parsed error even when the body is not JSON), applied at all ~13 sites at once.

### AC-06 [Medium] Completion vs autosave server-side race is narrowed, not closed — doc comments claim it fixed, but READ COMMITTED with no row lock leaves the window open
*lib/data/assessments.ts:143* — sweep confidence: probable

**Claim.** Both fix-round-1 comments assert the race was 'Fixed by moving the read ... and write inside ONE withOrg callback', but withOrg runs appClient.$transaction with no isolationLevel (Postgres default READ COMMITTED) and both functions read via plain findUnique with no FOR UPDATE — so between completeAssessment's read of engineState and its update, a concurrent autosave can still commit newer state (yielding an immutable completed assessment whose cached reportData mismatches its own engineState), and between respondToAssessment's status check and its update a concurrent completion can commit (its update then mutates a completed assessment, violating O-24).

**Evidence.** lib/data/tenant.ts:210: 'return appClient.$transaction(async (tx) => {' — no isolationLevel argument. lib/data/assessments.ts:66 and :143: plain 'tx.assessment.findUnique' with no locking. D-130's own status note confirms the precedent exists elsewhere: 'Task 7 closed a TOCTOU race between evidence deletion and assessment completion with SELECT ... FOR UPDATE ... but that does not itself close this row'.

**Impact.** The single-transaction change closed the wide two-transaction gap but the intra-transaction window remains, made non-theoretical by AC-07 (an uncancelled debounce timer routinely fires during completion). Damage is permanent and invisible: O-24 immutability freezes a wrong reportData forever, or a completed record's engineState is silently mutated. The doc comments recording the obligation as discharged is itself the D-191 class the project's own rules name.

**Direction (not an implementation).** SELECT ... FOR UPDATE on the assessment row in both functions (the Task 7 precedent), or a status/version precondition on the update; correct the doc comments to stop claiming closure.

### AC-08 [Medium] Pending autosave is silently discarded on unmount and the beforeunload guard tests the wrong predicate — up to 1s of answers (or an entire reset) lost on navigation or tab close
*app/(authenticated)/orgs/[slug]/assessment/[id]/AssessmentPageClient.tsx:334* — sweep confidence: confirmed

**Claim.** The unmount cleanup clears saveTimerRef without flushing the pending PATCH, and no sendBeacon/keepalive/visibilitychange flush exists anywhere; the beforeunload warning fires on 'current stage has any responses' rather than 'unsaved changes pending', so it nags when everything is saved and stays silent in real pending-save cases (e.g. on the stage-selector screen where selectedStage is null — including within 1s of a reset, whose destructive rewrite rides the same fire-and-forget debounce).

**Evidence.** AssessmentPageClient.tsx:334-338: 'return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };' — clear, no flush. :342: 'const hasResponses = selectedStage && Object.keys(getResponses(engineState, selectedStage)).length > 0;'. grep for sendBeacon|keepalive|visibilitychange across app/, components/, lib/: no matches. Reset paths :727-733 and :868-874 both call autoSave(fresh) (debounced).

**Impact.** Client-side navigation to any other page (beforeunload does not fire for SPA navigation) silently drops the last ≤1s of answers; closing the tab within 1s of confirming a reset leaves the server un-reset while the user believes it done; conversely users who have everything saved get a spurious leave warning, training them to ignore it.

**Direction (not an implementation).** Track a dirty/pending flag (set on arm, cleared on successful PATCH) and key beforeunload on it; flush pending state on unmount/pagehide via fetch keepalive or sendBeacon; make reset an immediate awaited PATCH with error feedback, not a debounced one.

### AC-09 [Medium] Validation errors are visually rendered but never programmatically announced or associated — the main accessibility gap in an otherwise decent question UI
*components/assessment/QuestionBlock.tsx:153* — sweep confidence: confirmed

**Claim.** The per-question error <p> has no id and no input references it via aria-describedby; inputs get no aria-invalid; the validation banner is a plain div with no role='alert'/aria-live; failing validation scrolls to the first error but never moves focus. Additional minor gaps: the progress bar div has no role='progressbar'/aria-valuenow, module tabs lack aria-controls/tabpanel and forward tabs are silently inert with no aria-disabled, and 🔒 emoji lack aria-hidden.

**Evidence.** QuestionBlock.tsx:153: '{validationErrors[q.id] && <p className="question-block__error-msg">...' — no id/role. AssessmentPageClient.tsx:790-794: '<div className="validation-banner">' — no live region; :572-573: 'el.scrollIntoView(...)' with no focus(); :769-771 progress-bar div; :776-786 tab buttons where onClick is a no-op unless idx < currentModuleIdx. Sound parts verified too: radiogroups with aria-labelledby (:116, :129), native <dialog> modals, roving tabindex with arrow keys (:742-756).

**Impact.** A screen-reader user who clicks Next Module with unanswered questions hears nothing: the page scrolls visually, errors paint red, and no announcement or focus change reaches assistive tech — the core answering loop is not operable non-visually when validation fires. This is a WCAG 3.3.1/4.1.3 failure on the product's central workflow.

**Direction (not an implementation).** Give each error message an id referenced by the input group's aria-describedby, set aria-invalid, make the banner role='alert', and move focus to the first invalid group on failed validation.

### AC-10 [Medium] 890-line component carries four concerns through ~19 useState hooks and drills 11 evidence props per question — the state shape invites exactly the defect classes the register keeps recording
*app/(authenticated)/orgs/[slug]/assessment/[id]/AssessmentPageClient.tsx:94* — sweep confidence: confirmed

**Claim.** One component owns assessment-engine editing, the evidence attach cycle (7 state variables), retired quick-mode legacy rendering (4 state variables), and modal/validation UI, totalling ~19 useState hooks; QuestionBlock takes 18 props of which 11 are evidence pass-throughs; roughly half the file is defect-archaeology comments. There is no reducer or state machine for the save lifecycle, which is why 'saving', 'saved', 'failed', 'conflicted' states simply do not exist (AC-04) and effects/handlers coordinate through refs.

**Evidence.** AssessmentPageClient.tsx:94-173: nineteen useState/useRef declarations in sequence; QuestionBlock.tsx:6-59: 18-prop interface, 11 evidence-prefixed; wc -l = 890. The beforeunload effect (:341-351) re-registers on every keystroke via [engineState, selectedStage] deps — a symptom of derived-vs-source state not being separated.

**Impact.** Every race in this audit (D-185, D-198, D-130, AC-04, AC-08) is a coordination failure between independently-updated state atoms and timers — the flat useState + ref + debounce shape has no place to express 'a save is in flight for revision N', so each fix (evidenceStale, isMountedRef, mutateThenConfirm) is bolted on per-symptom. The evidence subsystem is already half-extracted (mutateThenConfirm) precisely because the component itself is untestable (D-169).

**Direction (not an implementation).** Extract a save-lifecycle reducer/hook (state: dirty/saving/saved/failed/conflicted, owning the debounce and the res.ok handling) and an evidence hook; pass QuestionBlock a single evidence context object rather than 11 scalars.

### AC-12 [Medium] The entire assessment flow currently has zero automated coverage: e2e spec quarantined, no DOM test infra, jsdom ruling not yet landed
*e2e/assessment-flow.spec.ts:48* — sweep confidence: confirmed

**Claim.** The one spec covering create→answer→complete→report→PDF is test.fixme'd (D-185 quarantine), AssessmentPageClient has no unit tests and cannot have any (D-169: vitest runs environment:'node', no jsdom/@testing-library), and although the human partner ruled on 2026-08-12 to add jsdom as Phase 1d-ii's first task, package.json still names neither dependency four days later.

**Evidence.** e2e/assessment-flow.spec.ts:48: 'test.fixme(&#x27;create, answer, complete, view report, download PDF&#x27;, ...)'. grep jsdom|testing-library package.json: no matches. D-169 row: 'stateful client components have NO unit coverage at all — AssessmentPageClient.tsx, 890 lines, is the concrete instance'.

**Impact.** Every defect verified in this audit is unprovable by any committed test right now; a fix to D-185/D-198 would ship with no regression net, and the D-185 probe the register records as destroyed cannot be rebuilt until the infra lands. The register tracks this honestly — the gap is known and ruled on, just not yet closed.

**Direction (not an implementation).** Land the D-169 dependency addition and rebuild the D-185 regression probe as a committed unit test before touching the fixes it is meant to guard.

### AC-11 [Low] Two parallel reset flows with different confirmation UIs for the same destructive action
*app/(authenticated)/orgs/[slug]/assessment/[id]/AssessmentPageClient.tsx:728* — sweep confidence: confirmed

**Claim.** StageSelector's 'Start Again' uses window.confirm while the in-stage 'Reset Assessment' button uses the purpose-built ResetModal — same action, two confirmation mechanisms, and the window.confirm path bypasses the accessible <dialog> the project built for exactly this.

**Evidence.** AssessmentPageClient.tsx:727-733: 'if (window.confirm(&#x27;This will clear all your assessment responses...&#x27;))' vs :864-876 rendering <ResetModal> for the same createAssessment()+autoSave(fresh) sequence.

**Impact.** Inconsistent UX and duplicated destructive logic; window.confirm's wording also differs from ResetModal's ('cannot be undone' vs 'Are you sure'), and both inherit AC-08's fire-and-forget persistence of the wipe.

**Direction (not an implementation).** Route both entry points through ResetModal and make the reset PATCH immediate and awaited with error feedback.

### AC-13 [Low] D-170 verified accurate: evidenceStale still covers only the mutated question; shared evidenceListError/evidenceLoading flags still page-global
*app/(authenticated)/orgs/[slug]/assessment/[id]/AssessmentPageClient.tsx:520* — sweep confidence: confirmed

**Claim.** As D-170 records, only the question whose own mutation triggered a failed confirmation re-fetch gets a stale signal (:520, :547); sibling questions with equally-unconfirmed non-empty lists get nothing, and evidenceLoading/evidenceListError remain single page-wide flags threaded identically to every QuestionBlock (:815-816).

**Evidence.** AssessmentPageClient.tsx:519-520: 'else if (result.kind === &#x27;confirm-failed&#x27;) { setEvidenceStale((prev) => ({ ...prev, [qId]: true }));' and :815-816 passing the shared evidenceLoading/evidenceListError to every question. D-170 status: Open, 'no trigger fired yet'.

**Impact.** Register row is accurate; the conscious scope boundary holds. Reported for completeness of the dimension's row-verification mandate — the architectural sharing question D-170 defers remains unaddressed and untriggered.

**Direction (not an implementation).** None now; the row's own trigger (addressing the shared-flag architecture) is the right pickup, and AC-10's evidence-hook extraction would be the natural moment.

**Not examined by this auditor:**
- Live browser reproduction of the D-185/D-130/AC-06 races — Read-only audit; reproduction needs a running dev server, migrated database and auth fixtures, and the races were already root-caused with instrumentation recorded in the register — code-state verification was the assigned question.
- components/evidence/EvidenceAttach.tsx and lib/evidence/mutateThenConfirm.ts internals — Adjacent to the dimension (evidence subsystem); only their contracts as consumed by AssessmentPageClient/QuestionBlock were verified. Capacity spent on the race/save path per the brief.
- lib/engine/AssessmentEngine.js internals (purity of engineSetResponse, completeStage, getResponses) — Treated as pure per its call pattern; if engineSetResponse mutates its input, D-198's StrictMode double-invocation has additional consequences not assessed here.
- report/page.tsx below line 120 (render body, findings display) — The dimension's questions about this file concern the fetch/redirect behaviour, which is in lines 49-112; the render body is the report-surface dimension's territory.
- D-185's register row tail beyond ~6000 chars (its Status field and fix-targeting text) — The row is one very long line; the mechanism, evidence and 'no fix was attempted' sections were read, and the code state was verified directly, which is the stronger source for 'current state'.
- AssessmentPage.css and visual rendering (contrast, focus-visible styling) — Accessibility review was limited to DOM structure/ARIA in the TSX; computed styles need a rendered page.
- GET route handler's full response shape and the assessments creation route beyond line 100 — Only the fields the client consumes (engineState, status, mode, framework, startedAt, version) were traced.

## authn-session

The session-lifecycle core is genuinely well-built: revocation via a sessionEpoch counter is correctly wired to all four triggers (logout-everywhere, password change, admin deactivation, self-scrub), identity is re-read fresh from Postgres on every request at a single choke point so a fired/demoted user's JWT stops working on the next request, the absolute 7-day cap correctly avoids the @auth/core iat-reset trap via a sign-in-only sessionIssuedAt claim, and the getToken/NextAuth secret handling and open-redirect guard are carefully defended. The weaknesses cluster in account recovery and brute-force defense: the only password-recovery path shown to users is a false instruction (it points to an admin capability that does not exist), the entire mustChangePassword enforcement subsystem has no production writer, and the per-account lockout — the real brute-force defense given IP-keyed rate limiting is header-bypassable — both mis-counts under concurrency and enables cheap targeted lockout DoS. Registration and the sign-in path also leak account existence.

**Sound (what is genuinely good):**
- sessionEpoch revocation is correctly and consistently wired: bumpSessionEpoch (sessions route), the atomic hash+epoch UPDATE in password change (route.ts:67), admin deactivation (admin/users/[id]/role/route.ts:82-84), and scrubUserOnDeactivation (lib/data/identity.ts) all increment it, and resolveIdentity compares stored vs token epoch on every request (identity.ts:116-118).
- A deactivated user's live JWT is rejected on the very next request: resolveIdentity throws on both !user.isActive and epoch mismatch (identity.ts:113-118), and deactivation sets both in one statement — the 'fired user keeps access' class is genuinely closed.
- The absolute-session-cap mechanism correctly uses a sign-in-only sessionIssuedAt claim instead of the JWT envelope iat, with the @auth/core re-encode behavior verified live and documented (identity.ts:29-98, ADR-0002 §4 correction) — a subtle trap that was actually tested against the library.
- isPositiveInteger fails closed on NaN/Infinity/missing sessionIssuedAt (identity.ts:68-95), avoiding the NaN-comparison fail-open.
- safeCallbackUrl closes the post-auth open-redirect including protocol-relative // and backslash payloads, verified against the WHATWG parser (lib/safe-callback-url.ts:25-28).
- Password change combines passwordHash + mustChangePassword=false + sessionEpoch bump into one atomic UPDATE so an already-copied old-epoch cookie cannot outlive the change (password/route.ts:56-68).
- Login returns a single generic null for not-found / wrong-password / deactivated / locked, avoiding direct message-based enumeration (lib/auth.ts:52-94).
- requireAuthSecret centralizes the NEXTAUTH_SECRET read so lib/auth.ts and proxy.ts cannot drift, and fails loud rather than silently degrading (lib/auth/secret.ts).

### AUTH-01 [High] Password recovery is a dead end and the recovery instruction shown to users is false
*app/(public)/forgot-password/page.tsx:13* — sweep confidence: confirmed

**Claim.** The forgot-password page tells users to 'contact your platform administrator, who can reset your password from the admin panel', but no admin password-reset capability exists anywhere — the admin panel offers only promote/demote/deactivate/reactivate, and there is no reset API route. A user who forgets their password has no working recovery path, and the single instruction they are given is untrue.

**Evidence.** app/(public)/forgot-password/page.tsx:13-14 quotes '...contact your platform administrator, who can reset your password from the admin panel.' The admin route app/api/admin/users/[id]/role/route.ts handles only 'deactivate' and role in {admin,assessor} (lines 66-98); grep for reset/password across app/(authenticated)/admin/*.tsx returns nothing; `find app app/api -ipath '*reset*'` returns nothing. D-048 (register, Open) tracks the missing *self-service* reset but the D-022 closure explicitly calls this page's message 'honest', so the false admin-panel claim is untracked.

**Impact.** In the stated target context (shared lab machines, intermittent connectivity) forgotten passwords are likely; affected users are permanently locked out with only re-registration as recourse, which does not restore org membership or data. The false instruction sends them and the operator on a wild goose chase.

**Direction (not an implementation).** Either build the admin/self-service reset it references (naturally paired with AUTH-02's dormant mustChangePassword), or change the copy to describe a recovery path that actually exists; do not tell users an admin can do something no admin UI or route can do.

**Verification: CONFIRMED.** The page copy at forgot-password/page.tsx:13-14 does tell users an admin 'can reset your password from the admin panel', and no such capability exists: the admin action route handles only deactivate/reactivate/role-change, no admin UI page mentions passwords, and the only passwordHash writers are registration, invitation-register, the current-password-gated self change, and the deactivation scrub. My refutation attempts made the finding stronger, not weaker: the email UNIQUE constraint plus the 409s in both register routes mean the locked-out user cannot even re-register or be re-invited with the same email, and the register (D-048 Open, D-022 closure) explicitly calls the copy 'honest'/'a legitimate interim UX' while quoting only its true first half — so the false admin-panel claim is indeed untracked. High is the right severity: a permanent user lockout with a false recovery instruction is a concrete user/operator-impact defect, but it does not break tenancy, security, or data integrity.

*Verifier evidence:* app/(public)/forgot-password/page.tsx:13-14 (false instruction); app/(public)/login/page.tsx:60 (linked from login); app/api/admin/users/[id]/role/route.ts:66,90 (only deactivate/role actions); grep -rn passwordHash app lib → only register/route.ts:63, invitations/[token]/register/route.ts:63, users/me/password/route.ts:38+55 (requires currentPassword), lib/data/identity.ts:373 (scrub); prisma/schema.prisma:73 (email @unique); register/route.ts:58-61 and invitations/[token]/register/route.ts:55-61 (409 on existing email); docs/DEFERRED_REGISTER.md D-048 ('legitimate interim UX, not a defect', Open/Phase 2) and D-022 closure ('honest ... message'); grep -i 'password' app/(authenticated)/admin → no matches; scripts/ contains only provision-app-db-role.sh (DB role) and pen-test.mjs.

### AUTH-02 [Medium] mustChangePassword enforcement subsystem has no production writer — the control is inert
*lib/auth/identity.ts:284* — sweep confidence: confirmed

**Claim.** No production code path ever sets mustChangePassword=true. The only writer is the dev seed script. All the enforcement machinery — the second gate in requireIdentity (redirect to /change-password) and requireIdentityForApi (PasswordChangeRequiredError/403), the allowMustChangePassword opt-out, and the toResponse mapping — guards a flag that can never be raised for a real user.

**Evidence.** grep 'mustChangePassword: true' across app/ lib/ returns only lib/auth/identity.ts:108 (a SELECT column, not a write). The sole true-writer is prisma/seed.ts:123 `data: { role: 'admin', mustChangePassword: true }`. Registration (register/route.ts), invitation-register, bootstrapOrgWithOwner/createUserFromInvitation (lib/data/preauth.ts), and the admin route set it nowhere. D-136 and D-172 note in passing that mustChangePassword is a read-with-no-writer, but no open register row commits to wiring or removing it.

**Impact.** A forced-password-change control that ADR-0002 §4 lists as a real capability does nothing in production, and a substantial block of correct-but-unreachable code invites a future reader to assume the feature works. This is the missing writer behind AUTH-01's absent admin reset.

**Direction (not an implementation).** Wire a writer (admin-initiated reset that sets a temp password + mustChangePassword=true is the obvious one), or remove the enforcement scaffolding and open a register row; add a trigger-enumeration entry pinning that the flag has a production writer.

### AUTH-03 [Medium] Failed-login counter is a non-atomic read-modify-write, so lockout is evadable by concurrency
*lib/auth.ts:75* — sweep confidence: confirmed

**Claim.** The lockout counter is incremented as `user.failedLoginAttempts + 1` from a value read earlier in the same handler, not via an atomic DB increment. Concurrent failed sign-in attempts each read the same base count and the last write wins, so N parallel wrong guesses raise the stored counter by roughly 1 — largely defeating the 5-attempt lockout, which is the primary per-account brute-force defense (rate limiting is IP-keyed and x-forwarded-for-bypassable).

**Evidence.** lib/auth.ts:75 `const failedAttempts = user.failedLoginAttempts + 1;` then :85 `identityDb.user.update(... data: { failedLoginAttempts: failedAttempts })`. `user` came from findUnique at :47. No transaction, no `{ increment: 1 }`, no SELECT ... FOR UPDATE.

**Impact.** An attacker who parallelizes guesses gets many password attempts counted as one, so the account never (or rarely) locks — brute-force protection is materially weaker than the '5 attempts' design implies. bcrypt cost and pool size throttle throughput but do not fix the miscount.

**Direction (not an implementation).** Increment atomically in the database (`update ... data: { failedLoginAttempts: { increment: 1 } }` and derive lock state from the returned value) or perform the read-check-write inside a row-locking transaction.

### AUTH-04 [Medium] Targeted account-lockout DoS is cheap and indefinitely sustainable
*lib/auth.ts:64* — sweep confidence: confirmed

**Claim.** Any attacker who knows a victim's email can lock the account for 15 minutes with 5 wrong passwords, and can sustain the lockout indefinitely at near-zero cost: failedLoginAttempts is reset only on a successful login (which is itself blocked during lockout), so after the first lockout every subsequent wrong attempt re-locks, and one attempt per 15-minute window keeps the victim out forever.

**Evidence.** lib/auth.ts:64-68 rejects during lockout before any reset; the reset at :98-103 runs only on the successful-password branch, which is unreachable while locked; :81-82 re-locks at >=5. IP-keyed rate limit for POST:/api/auth is 15/15min (lib/rate-limit.ts:53) and proxy.ts derives ip from client-settable x-forwarded-for (proxy.ts:67-70).

**Impact.** Denial of access to arbitrary named users, made worse by AUTH-01: a maliciously locked user has no self-service or admin recovery to fall back on. This is the classic downside of account lockout, unmitigated here.

**Direction (not an implementation).** Prefer throttling/backoff over hard lockout for this threat model, reset or decay the counter after the lockout window elapses, and pair with a working recovery path.

### AUTH-05 [Medium] Account existence leaks via registration 409 and a sign-in timing side channel
*lib/auth.ts:52* — sweep confidence: confirmed

**Claim.** Registration returns an explicit 'An account with this email already exists' (409), and the sign-in authorize() returns immediately for a non-existent email without running bcrypt, so valid emails take ~one bcrypt (~230ms per the codebase's own measurement) while invalid emails return in well under a millisecond — a reliable enumeration oracle even though the login *message* is generic.

**Evidence.** app/api/auth/register/route.ts:59-60 returns the explicit-existence 409. lib/auth.ts:52 `if (!user) return null;` short-circuits before the compare at :71. Email verification is deferred (D-200), but that row covers verification, not these two enumeration channels.

**Impact.** An attacker can enumerate which emails have accounts on the platform; combined with no email verification and AUTH-04, enumeration feeds targeted lockout and credential-stuffing. For an assurance tool, membership of specific institutions/individuals is itself sensitive (ADR-0002 §10 spends effort hiding org existence but not user existence).

**Direction (not an implementation).** Run a dummy bcrypt compare on the not-found path to equalize timing; consider a neutral 'if this email is registered, ...' response on registration or move existence disclosure behind email verification.

### AUTH-07 [Medium] Auth-endpoint rate limiting uses a per-process in-memory Map, ineffective across instances
*lib/rate-limit.ts:73* — sweep confidence: confirmed

**Claim.** The rate-limit store is a module-level in-memory Map with a setInterval cleaner. In any multi-instance or serverless deployment each process keeps its own counters, so the effective limit multiplies by instance count and resets on redeploy — the login/registration limits that gate auth endpoints become largely nominal at scale.

**Evidence.** lib/rate-limit.ts:73 `const store = new Map<string, RateLimitEntry>();` and :76-85 the setInterval cleanup; no shared/Redis backend. AGENTS.md §3 itself cites 'rate limiting worked but its in-memory store broke under multi-instance hosting' as a known interaction-defect class.

**Impact.** The stated goal is a persistent multi-institutional platform; under horizontal scaling the auth-endpoint limiter provides far less protection than its configured numbers suggest, and provides none of it consistently across restarts.

**Direction (not an implementation).** Back the limiter with a shared store (Redis/Postgres) before multi-instance deployment, or document and enforce single-instance operation as a hard constraint.

### AUTH-06 [Low] Password policy is length-only — no complexity or common-password screening
*lib/validate.ts:28* — sweep confidence: confirmed

**Claim.** validatePassword enforces only 8-128 characters. There is no check against common/breached passwords, no complexity or entropy check. The one blocklist that exists (KNOWN_BAD_ADMIN_PASSWORDS) applies only to the seed admin, not to user-chosen passwords.

**Evidence.** lib/validate.ts:28-39 (only length 8 and 128 bounds). prisma/seed.ts:26 blocks two specific literals but only for the seeded admin.

**Impact.** For a platform with no email verification and header-bypassable IP rate limiting, an 8-char minimum with no 'password123'-class blocklist leaves weak passwords accepted at registration and change, undercutting the lockout/brute-force posture.

**Direction (not an implementation).** Add a common-password/breach blocklist (e.g. a top-N list or k-anonymity HIBP check) and consider a minimum length closer to 12 for admin-capable accounts.

### AUTH-08 [Low] Security-critical next-auth beta is pinned with a caret range
*package.json:38* — sweep confidence: confirmed

**Claim.** next-auth is declared as `^5.0.0-beta.31`. A caret on a prerelease permits later 5.x prereleases and the eventual 5.0.0 stable up to <6.0.0; a fresh install that doesn't honor the lockfile (or an explicit upgrade) can pull a version with breaking auth-layer changes, and the code already depends on undocumented beta-specific behaviors (getToken secret handling, iat reset).

**Evidence.** package.json:38 `"next-auth": "^5.0.0-beta.31"`; installed node_modules/next-auth is 5.0.0-beta.31. lib/auth.ts and proxy.ts document behaviors verified against this exact @auth/core 0.41.2 build.

**Impact.** An unintended version bump could silently change token/secret/session semantics on the platform's authentication path, the highest-blast-radius area to regress.

**Direction (not an implementation).** Pin next-auth to an exact version (no caret) for a beta dependency this security-sensitive, and gate upgrades behind an explicit auth-focused review.

### AUTH-09 [Low] Lockout and failed-login security events omit userId
*lib/auth.ts:65* — sweep confidence: confirmed

**Claim.** AUTH_ACCOUNT_LOCKED and the failed-attempt AUTH_LOGIN_FAILURE events log only the email in details and no userId, even though the user row is already in scope, so lockout/brute-force events cannot be correlated to a user id in the security log the way successful/deactivated events are.

**Evidence.** lib/auth.ts:65-67 logs AUTH_ACCOUNT_LOCKED with only `details: { email }` (no userId), and :90-92 logs the failure with `details: { email, attempts }` and no userId, while the success path at :105-108 does pass userId. `user.id` is available at both sites.

**Impact.** Weaker forensics/alerting on exactly the events (lockouts, repeated failures) an operator most needs to correlate during an attack.

**Direction (not an implementation).** Include userId in the lockout and failed-attempt events (they already have the user row).

**Not examined by this auditor:**
- Live/browser verification of any auth flow (sign-in, lockout, revocation, change-password redirect) — Read-only audit with no running app or database available; all findings are from source and migration reading. Concurrency claims (AUTH-03) and enumeration timing (AUTH-05) were reasoned from code, not measured against a live server.
- Exhaustive confirmation that every one of the ~24 API routes and all pages route through requireIdentity/requireIdentityForApi/requireOrgContext with no raw-session bypass — That is the authorization-surface dimension; I verified the auth-relevant routes and the ESLint-ban/branding design intent (ADR-0002) but did not enumerate every handler's guard call — a route missing the guard would move the AUTH-02/session checks off its path.
- The invitation token lifecycle (expiry, single-use, digest CHECK) beyond how invitation-register creates credentials — Primarily an invitations/tenancy dimension; I read the register branch and the migration's sha256 CHECK constraint but did not audit acceptance atomicity or token TTL.
- Whether the login rate-limit key POST:/api/auth actually throttles the exact NextAuth v5 sign-in POST path (/api/auth/callback/credentials) under real traffic — startsWith('POST:/api/auth') matches it by construction and unit tests are cited, but I did not run the server to confirm the live callback path or that GET session-polling is correctly excluded.

## authz-rbac

The core RBAC machinery is genuinely strong: requireOrgContext proves its six facts with DB-fresh reads, can() fails closed against exotic inputs, all 22 declared route-method entries consult exactly the action ROUTE_ACTIONS declares (verified mechanically), and the 404-vs-403 policy is consistently implemented and tested down to timing equalization. The weaknesses are interaction and lifecycle gaps the unit-level rigor never reached: the last-owner invariant counts membership rows rather than usable owners so platform-admin deactivation can silently orphan an org; the role model has no change/demote path at all, and its natural workaround (re-invite an existing member) dies in an unhandled 500; the enumeration mechanism the project relies on is exhaustive per-file but blind per-method. Several orphaned capabilities (org:delete, invitation revocation, reviewer role) are honestly registered but remain user-visible defects today.

**Sound (what is genuinely good):**
- Route-to-action mapping verified correct, not just present: every exported handler in all 12 org-scoped route files consults exactly the Action ROUTE_ACTIONS declares (grep of requireOrgContext calls vs lib/authz/routeActions.ts:23-54 -- zero divergence), and permission-matrix.test.ts drives the real handlers across ~726 (role x route x org) cells.
- can() (lib/authz/policy.ts:86-90) fails closed against unknown roles, prototype-colliding names, ToString-coercing objects and non-strings, with tests pinning each class (policy.test.ts:88-127) -- an unusually well-hardened authz primitive.
- requireOrgContextFor (lib/auth/context.ts:47-70) runs both lookups unconditionally to keep unknown-slug and non-member 404s timing-indistinguishable, reads role from the DB membership row never the token, and NotFoundError/ForbiddenError carry no distinguishing detail (tenant.ts:75-99); org-context.test.ts covers all six facts including suspended membership and soft-deleted org.
- Privilege-composition checks are right: admin cannot remove an owner (removeMember asserts member:revoke_owner, members.ts:117-123, tested in members.test.ts:40-53), admin cannot mint an owner invitation (createInvitation asserts member:grant_owner, members.ts:43-45, tested), and platformRole is never consulted anywhere in org authorization (grep: absent from context.ts/policy.ts/tenant.ts), so a platform admin gets 404 in orgs they are not a member of.
- Concurrency was taken seriously: last-owner check uses SELECT ... FOR UPDATE before counting (members.ts:126-132); invitation single-use is a conditional status-transition UPDATE, proven by a two-different-users race test (invitations.test.ts:202-227).
- Cross-org id probing returns 404 indistinguishable from nonexistent (RLS returns zero rows, handlers map null to 404), explicitly tested for evidence routes (evidence-download.test.ts:437-446) and at slug level for every route by the O-11 matrix.
- Known dead capabilities are honestly registered with pick-up triggers rather than hidden: D-172 (org:delete/deletedAt), D-181 (org:update, assessment:update/delete orphans), D-177 (invitation revocation), D-002/D-004 (reviewer role inert).

### AUTHZ-1 [High] Last-owner invariant counts membership rows, not usable owners: platform deactivation can orphan an org
*lib/data/members.ts:131* — sweep confidence: confirmed

**Claim.** Every last-owner guard counts memberships with role='owner' AND status='active' but never checks User.isActive, and admin deactivation (the platform axis) leaves memberships untouched -- so a deactivated user still counts as an owner. Two-owner org: platform admin deactivates owner B (routine for departed staff), owner A then leaves or deletes their account; ownerCount reads 2, the removal is allowed, and the org's only remaining owner is an account that cannot log in. No owner-only action (grant owner, invite owner, remove owner) is then reachable by anyone; recovery requires platform-admin reactivation of the departed user. The interaction between the two authority systems (platform User.role/isActive vs org OrgRole) is analyzed nowhere -- no ADR covers the platform-admin axis, and no DEFERRED_REGISTER row covers this (searched: 'last owner' appears only in D-119, which is about cross-org atomicity).

**Evidence.** lib/data/members.ts:131 `const ownerCount = await tx.membership.count({ where: { role: 'owner', status: 'active' } });` (same shape at app/api/users/me/route.ts:77,98); app/api/admin/users/[id]/role/route.ts:82-84 deactivation writes only `{ isActive: nextActive, sessionEpoch: { increment: 1 } }` -- memberships untouched; membershipsForUser (lib/data/preauth.ts:83-87) filters userId/status/org.deletedAt, never user.isActive.

**Impact.** An org can be left with zero functioning owners despite three separately-built last-owner guards, defeating the invariant they exist to hold ('the two paths cannot together leave an organization with zero owners', members/[userId]/route.ts:47-52). Governance product promise (knowing/controlling who has access) is undermined for the affected org until platform intervention.

**Direction (not an implementation).** Decide and record the intended semantics: either owner-counting joins user activity (count only owners whose User.isActive is true), or deactivation of a user must run the same last-owner analysis the removal paths do (refuse or warn when the target is a sole owner). Add the platform-role authority model to an ADR.

**Verification: CONFIRMED.** Every link in the chain verified against the repo: all three departure paths count owners as membership rows with role='owner' AND status='active' and never join User.isActive (members.ts:131 used by both DELETE members/[userId] and POST members/leave; users/me/route.ts:77,98), while admin deactivation writes only isActive+sessionEpoch and leaves memberships untouched (admin/users/[id]/role/route.ts:82-84), so a deactivated user still satisfies every last-owner guard and the code's own stated invariant (members/[userId]/route.ts:47) is defeated across the two authority axes. I hunted for compensating mechanisms and found none: no isActive consumer anywhere feeds an owner count, no membership cleanup or admin-UI warning exists, no test pins this as intended (deactivation is tested only for session revocation), no ADR covers the platform-axis interaction (ADR-0002 treats deactivation purely as a revocation trigger), and the register rows mentioning 'last owner' (D-088/D-106/D-119 — slightly more than the auditor's 'only D-119', a trivial inaccuracy) all concern other properties. Recovery genuinely requires platform intervention: platformRole is never consulted in org authorization (grep of context.ts/policy.ts/tenant.ts returns zero) and the only owner-role writers are the owner-gated grant PATCH and org creation. The finding is if anything understated: the admin route does no org-ownership analysis at all, so deactivating the SOLE owner of an org orphans it in one step with no second actor needed. High is the correct severity — concrete operator/user impact (silent, hard-to-diagnose loss of all org ownership management; recovery re-enables a departed user's login) without a tenancy/security/data-integrity breach that would make it Critical.

*Verifier evidence:* lib/data/members.ts:130-132 (FOR UPDATE + count on role/status only); app/api/users/me/route.ts:77,98 (same shape); app/api/admin/users/[id]/role/route.ts:62-64,82-84 (self-check only; writes isActive+sessionEpoch); lib/data/preauth.ts:83-87 (membershipsForUser never filters user.isActive); grep -rn isActive lib/ app/ → consumers are lib/auth.ts:55, lib/auth/identity.ts:113, the admin route, and display/export only; grep 'last owner' docs/DEFERRED_REGISTER.md → D-088/D-106/D-119, none covering deactivation; grep platformRole lib/auth/context.ts lib/authz/policy.ts lib/data/tenant.ts → zero hits; grep -rln deactivat __tests__/ → identity.test.ts and password-gate.test.ts (session revocation only).

### AUTHZ-2 [Medium] Role lifecycle is one-way: no role change or demotion exists for any member
*lib/authz/routeActions.ts:49* — sweep confidence: confirmed

**Claim.** The only role mutation in the entire system is PATCH members/[userId] hard-coded to `role: 'owner'`. There is no endpoint, action consultation, or UI to change a member to any other role, and no demotion of an owner (member:revoke_owner exists as an Action but is only consulted as a secondary check inside removeMember/createInvitation -- no route implements actual revocation). The only way to change someone's role is remove + re-invite + re-accept.

**Evidence.** routeActions.ts:49-52 declares only `PATCH: 'member:grant_owner', DELETE: 'member:remove'` for members/[userId]; the PATCH handler writes `data: { role: 'owner' }` unconditionally (members/[userId]/route.ts:25-30); MembersManager.tsx renders no role editor (only Make owner / Remove / Leave, lines 122-144); grep confirms member:revoke_owner has no route consumer.

**Impact.** An owner granted by mistake (one idempotent, unconfirmed button click) can only be corrected by expelling the person; a viewer who should become an assessor must be removed and re-invited, losing membership history (createdAt) and requiring their cooperation. For a governance product whose subject is access control, the access-change primitive is missing. The 2026-08-14 collaboration-model proposal restructures roles but is explicitly undecided; the current model's gap is registered nowhere I could find.

**Direction (not an implementation).** Add a role-change operation (PATCH with a role body, gated so only owners can touch owner in either direction and reusing the last-owner count for owner-to-nonowner demotion), or register the gap with a trigger tied to the collaboration-model decision.

### AUTHZ-3 [Medium] Accepting an invitation while already a member is an unhandled P2002 that surfaces as a 500
*lib/data/preauth.ts:334* — sweep confidence: probable

**Claim.** acceptInvitation unconditionally creates a Membership; Membership has @@unique([orgId, userId]); nothing in createInvitation or acceptInvitation checks whether the invitee is already a member. Prisma's P2002 is not an InvitationError, so the route's catch maps it via toResponse, which rethrows unknown errors -- a 500 to the user. Reachable through the natural path AUTHZ-2 creates: an admin 're-invites' an existing viewer at a higher role to upgrade them; acceptance crashes (invitation rolls back to pending, so it also lingers). invitations.test.ts has no already-a-member case.

**Evidence.** preauth.ts:334-336 `await tx.membership.create({ data: { orgId: inv.orgId, userId, role: inv.role } })` with no prior membership check; prisma/schema.prisma:303 `@@unique([orgId, userId])`; app/api/v1/invitations/[token]/route.ts:40-46 maps only InvitationError to 410, `return toResponse(e)` otherwise, and toResponse.ts:41 `throw e` for unknown types; createInvitation (members.ts:40-83) performs no member/duplicate-pending check.

**Impact.** A known-reachable, user-drivable input class produces an unhandled 500 in the one flow that grants org access -- and because the transaction rolls back, the confusing state (invitation still pending, user already a member) persists. Also allows unlimited duplicate pending invitations for the same email/org.

**Direction (not an implementation).** Detect the already-member case inside acceptInvitation (or catch P2002 on this create) and return a deliberate outcome (e.g., InvitationError variant or an explicit already-member response); add the test case. Decide whether re-invite-as-role-change should update the existing membership -- which ties into AUTHZ-2.

### AUTHZ-4 [Medium] Route-action enumeration is exhaustive per file but blind per method
*__tests__/integration/port-completeness.test.ts:14* — sweep confidence: confirmed

**Claim.** port-completeness accepts a route file if it appears in ROUTE_ACTIONS with at least one method or in NON_ACTION_ROUTES; permission-matrix iterates only the declared methods. Nothing enumerates a route module's actual exports, so a newly added handler on an existing file (e.g. a DELETE on assessments/[id], or a PUT -- a method the Method type cannot even declare) with no requireOrgContext gate would pass every enumeration test and never receive a matrix cell. This contradicts routeActions.ts's own guarantee ('one key per HTTP method it implements... what makes this map exhaustive rather than aspirational').

**Evidence.** port-completeness.test.ts:14-18 `isDeclared` returns true when `Object.keys(actions).length > 0`; permission-matrix.test.ts:556-557 iterates `Object.entries(ROUTE_ACTIONS)` then `Object.entries(methods)` -- declared methods only; routeActions.ts:3 `type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'` (no PUT); grep across __tests__ finds no test reading route-module exports. I verified no undeclared method exists today (all exported handlers match declarations).

**Impact.** The mechanism the project explicitly relies on to make authorization coverage mechanical rather than review-dependent (AGENTS.md 'a new route with no entry fails a test, not a review') has a hole exactly one increment wide: the most likely future change (adding a method to an existing route) is the one it cannot see.

**Direction (not an implementation).** Extend port-completeness to import each route module (or grep its exported handler names) and require every exported HTTP-method handler to have a ROUTE_ACTIONS entry or a documented exemption.

### AUTHZ-5 [Medium] Owner-invitation cap is creation-time only; a demoted/removed owner's pending owner-grant stays redeemable for 7 days and cannot be withdrawn
*lib/data/preauth.ts:321* — sweep confidence: confirmed

**Claim.** The role cap (only owners may mint owner invitations) is enforced solely at creation; acceptInvitation re-validates nothing about the inviter's current status or membership. An owner who mints an owner invitation and is then demoted... (no demotion exists, AUTHZ-2) removed from the org -- or has their account deactivated -- leaves behind a live grant of owner that remains redeemable until expiry. Combined with the registered absence of any revocation or listing surface (D-177), no one in the org can see or stop it.

**Evidence.** createInvitation caps at creation only (members.ts:43-45, doc: 'enforced AT CREATION'); acceptInvitation (preauth.ts:321-339) checks only tokenHash/status/expiresAt/email -- invitedById is never re-validated; D-177 (DEFERRED_REGISTER.md:226) records no revoke route, no pending-invitations list, only creation-time cap; INVITATION_TTL_MS = 7 days (members.ts:10).

**Impact.** Authority outlives its holder: removing a rogue or compromised owner does not remove the owner-grants they issued, and the org has no visibility into them. D-177 registers the revocation gap but frames it as UX (mis-typed email); the stale-authority escalation angle is not named there or anywhere.

**Direction (not an implementation).** At acceptance, re-check that the inviter still holds an active membership able to grant the invitation's role (or void an org's pending invitations when the inviter loses the minting privilege); at minimum add this angle to D-177 so the eventual fix covers it.

### AUTHZ-6 [Medium] No last-admin guard on the platform axis; concurrent mutual demotion/deactivation can zero out platform administration
*app/api/admin/users/[id]/role/route.ts:62* — sweep confidence: confirmed

**Claim.** The admin route blocks only self-demotion/self-deactivation. Two admins can demote or deactivate each other; interleaved requests both pass the self-check and both apply, leaving zero active platform admins with no in-app recovery (admin pages redirect all non-admins, and nothing else can write User.role). This is asymmetric with the org axis, where the same codebase takes FOR UPDATE locks specifically against the two-concurrent-removals race (members.ts:126-132).

**Evidence.** route.ts:62-64 `if (target.id === identity.userId) { return NextResponse.redirect(.../admin/users?error=self...) }` is the only guard; no count of remaining active admins anywhere in the handler (lines 66-98); recovery surface: admin/users/page.tsx:24 and admin/settings/page.tsx:25 both `redirect('/')` for non-admins.

**Impact.** Total loss of platform administration (user management, reactivation -- including the recovery path for AUTHZ-1) recoverable only by direct database surgery. Race-dependent, so low probability, but the same two-actor race was judged worth a row lock on the org side.

**Direction (not an implementation).** Mirror the org-side pattern: lock and count active admins before applying a demotion/deactivation whose target is an admin, refusing when the result would be zero.

### AUTHZ-7 [Low] reviewer is a selectable role with zero capability difference from viewer, unsignalled at the point of choice
*lib/authz/policy.ts:50* — sweep confidence: confirmed

**Claim.** reviewer and viewer have byte-identical grants, deliberately (registered D-002/D-004, powers deferred to the Phase-2 review workflow). But the invite UI offers 'reviewer' as a distinct choice with nothing indicating it currently confers nothing beyond viewer -- an inviter reasonably believes they granted review capability. On its own terms the current model also has only org-wide granularity (no per-project grants), which the 2026-08-14 proposal acknowledges by restructuring it.

**Evidence.** policy.ts:50-51: reviewer and viewer rows are identical arrays; MembersManager.tsx:175 `selectableRoles = ALL_ORG_ROLES.filter(...)` includes reviewer with no caption; D-002/D-004 open in DEFERRED_REGISTER.md:48,50.

**Impact.** For a governance product, a role label that overstates granted capability is a small integrity defect in its own domain: the org's access records say 'reviewer' while the system grants 'viewer'. Honestly registered, but the register does not make the UI honest.

**Direction (not an implementation).** Until D-002 lands, either drop reviewer from the invite dropdown or annotate it ('currently same access as viewer').

### AUTHZ-8 [Low] Account-deletion refusal instructs users to 'delete the organization' -- an operation that does not exist
*app/api/users/me/route.ts:82* — sweep confidence: confirmed

**Claim.** The last-owner 409 from DELETE /api/users/me tells the user to 'Transfer ownership or delete the organization before deleting your account', but org deletion has no route, no UI, and no writer of Organization.deletedAt (registered as D-172, open). One of the two suggested resolutions is impossible; the possible one (grant owner to someone, then delete) is not what the message says either ('transfer' implies a swap that also does not exist).

**Evidence.** route.ts:82 error string; grep for deletedAt writers in lib/ and app/ returns zero assignments (only `deletedAt: null` filters); D-172 (DEFERRED_REGISTER.md:221) confirms 'organisation deletion does not exist as a feature'.

**Impact.** A sole owner wanting to leave the platform is handed an instruction that cannot be followed; the actual escape path (grant a co-owner, retry) is undocumented in the message.

**Direction (not an implementation).** Reword the 409 to describe the operations that exist (grant owner to another member first), or prioritize D-172.

### AUTHZ-9 [Low] Dead states in the authz-relevant enums: Membership 'suspended' and Invitation 'expired'/'revoked' are never written
*prisma/schema.prisma:266* — sweep confidence: confirmed

**Claim.** MembershipStatus.suspended has no writer anywhere in lib/ or app/ (only read as a filter and in tests), and InvitationStatus expired/revoked likewise (registered, D-177). The suspended state is handled correctly everywhere if it ever appears (fails closed to 404, tested), but a state machine the product cannot drive misleads readers into assuming suspension exists as a feature.

**Evidence.** schema.prisma:266-276 declares the enums; `grep -rn "suspended" lib app` returns only two comments in lib/auth/context.ts (no writes); the only production Invitation status write is 'accepted' at preauth.ts:324 (confirmed by D-177's own verification and my grep for `status: 'expired'|'revoked'` returning nothing).

**Impact.** Same class as D-172/D-181 (declared capability with no trigger); for suspended specifically there is no register row -- it can silently persist as scaffolding-mistaken-for-feature.

**Direction (not an implementation).** Open a register row for Membership.suspended (build suspension or remove the state), consistent with how D-172/D-181/D-177 handled their siblings.

### AUTHZ-10 [Low] Org-scoped pages have no mechanical action-enumeration equivalent to ROUTE_ACTIONS
*lib/authz/routeActions.ts:22* — sweep confidence: confirmed

**Claim.** The exhaustiveness machinery (ROUTE_ACTIONS + port-completeness + permission matrix) covers only app/api/** route handlers. Server components under app/(authenticated)/orgs/[slug]/** each choose their own action ad hoc (layout: org:read; members page: member:read) with no map, no completeness test, and no matrix -- a future page that renders privileged data gated only by the layout's org:read would be caught by nothing mechanical. Mutations all go through the covered API, so today this is exposure-of-rendered-data risk only.

**Evidence.** routeActions.ts:22 scope is 'one entry per org-scoped app/api/v1/orgs/[slug]/** route'; port-completeness.test.ts:22 `find app/api -name route.ts` only; pages consult actions inline, e.g. app/(authenticated)/orgs/[slug]/layout.tsx:46 ('org:read') and settings/members/page.tsx:29 ('member:read'), with no enumeration test over app/(authenticated).

**Impact.** The project's own doctrine (mechanism beats prose; hand-maintained completeness is a latent defect) is applied to API routes but not to the page surface that renders the same tenant data.

**Direction (not an implementation).** Extend the enumeration approach: a disk-walk test asserting every org-scoped page.tsx (or its layout chain) calls requireOrgContextFor with a declared action.

### AUTHZ-11 [Low] Any authenticated user can mint unbounded live tenants via POST /api/v1/orgs
*app/api/v1/orgs/route.ts:30* — sweep confidence: confirmed

**Claim.** Creating an additional org is gated on identity alone (deliberate and documented, D-078) with only the default rate limit (60/min per user) between one user and ~86k live tenant orgs per day, each with owner membership. Registration abuse is thoroughly analyzed (D-195/D-199/D-200) but I found no register row for post-registration org-creation volume specifically.

**Evidence.** route.ts:30-49: requireIdentityForApi + name validation, then createOrgForUser -- no org-count cap, no dedicated RATE_LIMITS key (lib/rate-limit.ts:20-71 lists register/auth/users-me-delete/evidence/default only).

**Impact.** Resource abuse and org-slug namespace pollution by a single hostile account; not an authorization defect (the gate itself matches ADR-0001/D-078 reasoning).

**Direction (not an implementation).** Belongs to the abuse/rate-limit workstream: a per-user org cap or a dedicated rate key, or a register row alongside D-200.

**Not examined by this auditor:**
- Live execution of any scenario (AUTHZ-1 orphaning sequence, AUTHZ-3 P2002-to-500, AUTHZ-6 race) — Read-only audit with no running app/database session; every link in each chain is cited from source instead, and confidence is marked probable where a chain was not executed.
- e2e/two-orgs.spec.ts and e2e/security.spec.ts — Capacity; integration suites for the same surfaces were read in full, and register rows D-188/D-196 describe the e2e invitation coverage.
- lib/data/identity.ts Proxy guard internals (assertNoTenantRelation) and lib/security-logger.ts — Skimmed for the identityDb tenant-relation boundary only; full verification of the guard belongs to the data-access/tenancy dimension.
- proxy.ts in full (rate limiting wiring, x-pathname forwarding, CSRF posture beyond the admin route) — Adjacent dimension (edge/middleware); read only the fragments authorization depends on.
- Cross-org id-probing 404 tests for projects/assessments/remediation routes specifically — Confirmed explicitly for evidence routes (evidence-download.test.ts:437-446) and structurally for the rest (findUnique-under-RLS returns null -> 404, assessments/[id] GET read); did not read every route-family test file.
- RLS policies and migrations themselves — Another auditor's dimension per the tenancy note in my brief; I took ADR-0001's RLS-owns-isolation contract as given and audited the authorization layer above it.
- Sidebar/nav gating of admin links for non-admin users — Cosmetic; server-side gates on the admin pages and route were verified directly.

## ci-devx

The CI pipeline itself is unusually well-engineered: real Postgres with migrations and role provisioning in both jobs, a genuinely booted production build for e2e, zero secret dependencies, and mechanical guards (node-version-alignment, effective-config pin) that embody the project's "mechanism beats prose" doctrine. The coherence failures are at the edges CI does not exercise: docker-compose.prod.yml is missing four env vars the app's own CI file painstakingly documents as boot-fatal (the documented production deploy cannot serve a single logged-in request), the README is the untouched create-next-app stock file so there is no working documented cold start, and several declared couplings (@types/node vs Node 22, job-name-to-required-context, the concurrency block's stated purpose) are guarded by prose or by nothing — the concurrency claim is empirically false (duplicate push+PR runs both complete on every PR push).

**Sound (what is genuinely good):**
- Both CI jobs provision real Postgres (service container, health-gated), run all migrations as superuser, and run the same provision-app-db-role.sh local dev uses — integration tests hit a real RLS database, not mocks (ci.yml:58-104,149-177,284-336).
- CI needs zero GitHub secrets: grep for 'secrets.' in ci.yml returns nothing; every value is a documented, deliberately-public dev literal, with the one CI-only NEXTAUTH_SECRET reasoned inline (ci.yml:242-249).
- Branch protection verified live: required contexts are exactly ["lint, typecheck, test, build","e2e"], strict=true, enforce_admins=true (gh api), matching ci.yml job names at :35 and :213 exactly.
- The e2e job builds and boots the real app (npm run build, Playwright-owned webServer 'npm run start'), drives ~20 real logins, and uses --fail-on-flaky-tests plus a reasoned --no-deps optimization, each claim verified against installed Playwright source (ci.yml:338-385).
- Reproducible installs: package-lock.json committed (lockfileVersion 3), npm ci everywhere, setup-node reads .nvmrc (ci.yml:115), Dockerfile ARG default pinned to .nvmrc by a test whose site discovery is generated from git ls-files with an anti-vacuity guard (node-version-alignment.test.ts:136-142).
- The D-136 flat-config lesson is institutionalized, not just fixed: one config object owns no-restricted-imports for the general glob, overrides derive via patternsExcept() from a shared list, and __tests__/lint/effective-config.test.ts pins the RESOLVED config via eslint --print-config including a live probe-file lint (eslint.config.mjs:81-92,167-222).
- Turbopack coherence: no build/dev flags anywhere (package.json scripts, Dockerfile, ci.yml all plain 'next build'/'next dev'); Next 16 defaults Turbopack for both (node_modules/next/dist/docs/.../06-cli/next.md:68,98), so dev, CI, and the Docker build all use the identical default path.
- Two-layer .env leak defense with root cause documented on both layers (.dockerignore header, package.json:14 postbuild, next.config.ts:24-42), each explicitly stating why the other layer is not sufficient.
- Fail-fast job ordering (lint/typecheck before any DB step, ci.yml:139-147) and timeout backstops with recorded rationale rather than folklore.

### CFG-01 [Critical] docker-compose.prod.yml omits four env vars the app cannot run without — documented production deploy is dead on arrival
*docker/docker-compose.prod.yml:11* — sweep confidence: confirmed

**Claim.** The nextjs service's environment block passes only DATABASE_URL, NEXTAUTH_SECRET, NEXTAUTH_URL (lines 11-14). It omits APP_DATABASE_URL, AUTH_TRUST_HOST/AUTH_URL, RESEND_API_KEY, and EMAIL_FROM_ADDRESS — and the image contains no .env to fall back on (.dockerignore:37-39 excludes it from the build context; package.json:14 postbuild deletes .next/standalone/.env*). The runbook (docs/runbooks/deployment.md §4) has the operator write these values into repo-root .env, but nothing carries them into the container.

**Evidence.** docker/docker-compose.prod.yml:11-14 (only 3 vars); lib/data/connection.ts:23-31 'throw new Error(`${name} is not set...`)' for APP_DATABASE_URL via lib/data/tenant.ts createAppClient; @auth/core/lib/utils/env.js:40 trustHost = !!(AUTH_URL ?? AUTH_TRUST_HOST ?? VERCEL ?? CF_PAGES ?? NODE_ENV !== "production") — NEXTAUTH_URL not consulted, no trustHost anywhere in app code (grep -rn trustHost lib/ app/ proxy.ts: empty), Dockerfile:33 sets NODE_ENV=production; ci.yml:262-282 records the repo's own live reproduction of the resulting UntrustedHost HTTP 500; ci.yml:250-252 cites members/route.ts:105-108 throwing when EMAIL_FROM_ADDRESS unset.

**Impact.** On the documented deployment path: every login/auth request 500s (UntrustedHost), every tenant-data request throws (APP_DATABASE_URL unset — the RLS client cannot be constructed), invites throw (EMAIL_FROM_ADDRESS/RESEND_API_KEY). The platform's entire production path is non-functional; it fails closed (no isolation breach), but the core promise of a deployable multi-user platform is invalidated. The env contract this file violates is documented in exhaustive detail inside the repo's own ci.yml e2e job (lines 230-282) — the two files describe the same application and were never reconciled.

**Direction (not an implementation).** Reconcile docker-compose.prod.yml's environment block with the env contract ci.yml already documents (APP_DATABASE_URL, AUTH_TRUST_HOST=true or AUTH_URL, RESEND_API_KEY, EMAIL_FROM_ADDRESS), or switch to env_file; consider a boot-time env-contract assertion so a missing var fails the container at startup with one clear message.

**Verification: CONFIRMED.** Every element of the claim held under independent re-verification, and all four refutation avenues I tried failed. docker-compose.prod.yml:11-14 passes only DATABASE_URL/NEXTAUTH_SECRET/NEXTAUTH_URL with no env_file, and the runbook's documented deploy (deployment.md section 6.1) is a bare 'docker compose -f docker/docker-compose.prod.yml up -d --build', so nothing carries APP_DATABASE_URL, AUTH_TRUST_HOST, RESEND_API_KEY, or EMAIL_FROM_ADDRESS into the container even though the runbook has the operator write some of them into repo-root .env (host .env feeds only ${...} interpolation). The critical trustHost sub-claim is correct: next-auth/lib/env.js maps NEXTAUTH_URL only to secret/basePath, @auth/core computes trustHost from AUTH_URL/AUTH_TRUST_HOST/VERCEL/CF_PAGES/NODE_ENV only, Dockerfile:33 sets NODE_ENV=production, and no app code sets trustHost (grep empty) — so every auth request 500s (UntrustedHost, with a live repro recorded in ci.yml:262-282), every tenant-data request throws (tenant.ts:125 requireDatabaseUrl('APP_DATABASE_URL') with no fallback), and no .env exists in the image (.dockerignore excludes it; postbuild deletes .next/standalone/.env*). Critical is warranted under the given rubric: the only documented production deployment path yields a platform that cannot serve a single logged-in request, invalidating the core deployable-multi-user-platform promise; it fails closed, so no tenancy breach, but that is exactly the 'invalidates a core product promise' branch of Critical. No DEFERRED_REGISTER row records this gap.

*Verifier evidence:* docker/docker-compose.prod.yml:11-14 (only 3 vars, no env_file); node_modules/next-auth/lib/env.js setEnvDefaults (NEXTAUTH_URL -> secret/basePath only) + node_modules/@auth/core/lib/utils/env.js trustHost expression (AUTH_URL not NEXTAUTH_URL); grep -rn trustHost app/ lib/ proxy.ts components/ types/ scripts/ -> no matches; docker/Dockerfile:33 ENV NODE_ENV=production; lib/data/tenant.ts:125 + lib/data/connection.ts:23-31 (APP_DATABASE_URL throw); app/api/v1/orgs/[slug]/members/route.ts:105-107 and lib/email/send.ts:32-34 (email throws); .dockerignore '.env/.env.*' exclusion + package.json postbuild 'rm -rf .next/standalone/.env*'; docs/runbooks/deployment.md sections 4 and 6.1; .github/workflows/ci.yml:250-282 (env contract + recorded UntrustedHost repro); grep of docs/DEFERRED_REGISTER.md for compose-prod/AUTH_TRUST_HOST -> no row.

### CFG-02 [High] README is the stock create-next-app file; the only documented cold start (npm run dev) cannot work and no local-setup document exists
*README.md:1* — sweep confidence: confirmed

**Claim.** README.md is untouched create-next-app boilerplate ('First, run the development server: npm run dev ... You can start editing the page by modifying app/page.tsx', even 'Deploy on Vercel'). The real cold start requires .env creation, docker:up, migrate, db:provision, db:seed — none documented in any one place; the fragments live in .env.example comments (line 18) and package.json script names. docs/runbooks/ contains only deployment, backup-restore, and troubleshooting (production docs).

**Evidence.** README.md:1-36 (stock content, verbatim); ls docs/runbooks/ → backup-restore.md, deployment.md, troubleshooting.md; bare `npm run dev` fails on unset env: lib/data/connection.ts:23-31 throws for DATABASE_URL/APP_DATABASE_URL, and ci.yml:242-243 cites lib/auth/secret.ts:44-49 throwing when NEXTAUTH_SECRET is unset.

**Impact.** A new contributor following the repo's front-door document gets a broken app and no path to a working one; the correct sequence (docker:up → migrate → db:provision → seed → dev) must be reverse-engineered from config comments. Pointed for a product whose own diagnosis target is documentation deficits (AGENTS.md §6).

**Direction (not an implementation).** Replace the README with the actual cold-start sequence (or a docs/runbooks/local-dev.md the README points to), and consider a make/npm 'setup' script encoding it — the project's own 'generate, don't hand-write' doctrine applied to onboarding.

**Verification: CONFIRMED.** README.md:1-36 is verbatim untouched create-next-app boilerplate ('First, run the development server: npm run dev', 'Deploy on Vercel'), and its documented cold start cannot work: with no .env, requireAuthSecret() throws on unset NEXTAUTH_SECRET and requireDatabaseUrl() throws on DATABASE_URL/APP_DATABASE_URL, and a working app additionally needs docker:up -> db:migrate -> db:provision -> db:seed, a sequence written down nowhere. I hunted for a setup document the auditor might have missed and found none: no CONTRIBUTING.md, no Makefile, docs/runbooks/ holds only backup-restore/deployment/troubleshooting (all production-scoped — troubleshooting's headings are SSL renewal, DB connection refused, OOM), and 'db:provision' appears in no onboarding doc — only in the production runbook, a planning doc, and the register. The fragments genuinely live only in .env.example comments and package.json script names. High is warranted: concrete contributor/operator impact (the front-door doc is actively misleading, and the non-obvious db:provision step is one the RLS design depends on — skipping it leaves the makrai_app role absent), in a repo whose own product mission is diagnosing documentation deficits. No register row tracks it.

*Verifier evidence:* README.md:1-36 (read in full, stock content); ls docs/runbooks/ -> backup-restore.md, deployment.md, troubleshooting.md; troubleshooting.md headings (production ops only); ls CONTRIBUTING.md Makefile -> No such file; lib/auth/secret.ts requireAuthSecret() throw + lib/data/connection.ts:23-31 throws; .env.example (fragmentary comments incl. 'Create with prisma migrate deploy, then npm run db:provision'); package.json scripts (docker:up/db:migrate/db:provision/db:seed exist only as script names); grep -rl 'db:provision' docs/ -> deployment.md, a plan doc, DEFERRED_REGISTER.md only; register grep for README/local-dev/cold-start -> no row.

### CFG-03 [Medium] @types/node is ^20 (installed 20.19.43) against Node 22 everywhere else, and node-version-alignment.test.ts cannot see it
*package.json:48* — sweep confidence: confirmed

**Claim.** package.json declares engines.node '>=22' (line 5) and .nvmrc says 22, but devDependencies pin '@types/node': '^20' (line 48), resolving to 20.19.43. The alignment test scans only workflows (node-version/-file), Dockerfiles (FROM node:), and engines.node — @types/node is a Node-version declaration site its stated property ('the Node major version declared for this project cannot silently diverge across the places that declare it') covers but its scan does not.

**Evidence.** package.json:48 '"@types/node": "^20"' vs :5 '"node": ">=22"'; package-lock resolution: node -e ... → '@types/node: 20.19.43'; ran `npx vitest run __tests__/lint/node-version-alignment.test.ts` on Node v22.22.3 → 5 passed (test blind to the drift); scan surface at node-version-alignment.test.ts:83-128,158-162.

**Impact.** tsc typechecks the codebase against the Node 20 API surface while dev, CI, and Docker all run 22 — Node 22-only APIs fail typecheck despite working at runtime, and type/runtime semantics silently diverge in the exact 'divergence is a property of the set' shape the test's own docstring names (lines 17-21). This is the same defect class D-192 closed, one declaration site short.

**Direction (not an implementation).** Bump @types/node to ^22 and add a package.json devDependencies['@types/node'] site to the alignment test's scan, alongside the engines.node check it already performs.

### CFG-04 [Medium] The concurrency block does not do what its comment says: push and pull_request runs of the same commit both run to completion
*.github/workflows/ci.yml:29* — sweep confidence: confirmed

**Claim.** The comment (lines 25-31) says the concurrency group exists because 'push and pull_request both fire for the same commit on an open PR, so without this every PR push runs the whole job twice in parallel'. But the group key is `${{ github.workflow }}-${{ github.ref }}`, and github.ref differs by event (refs/heads/<branch> vs refs/pull/<n>/merge), so the two runs land in different groups and neither cancels the other.

**Evidence.** ci.yml:29-31; empirical: `gh run list --json headSha,event,conclusion` shows e5bceee, 6412559, ec2f663, d56694f, ff7f611, ea5f0e5 each with BOTH a pull_request and a push run, all 'success' — none cancelled.

**Impact.** Every push to an open PR runs the entire pipeline twice — including the expensive e2e job (browser install + full build + ~20 live logins) — exactly the waste the block claims to prevent. The comment also misdescribes the mechanism, the failure mode this repo's config comments are otherwise scrupulous about.

**Direction (not an implementation).** Either scope pull_request to main only (push already covers every branch), or key the group on the head SHA / branch name so the two event types collide; fix the comment to match whatever the mechanism actually does.

### CFG-05 [Medium] ESLint import bans cover only app/** and lib/** — components/, proxy.ts, scripts/, types/ are outside every ban object
*eslint.config.mjs:173* — sweep confidence: confirmed

**Claim.** The general ban object matches files: ['app/**/*.{ts,tsx}', 'lib/**/*.{ts,tsx}'] only. components/ (20 .ts/.tsx files), root-level proxy.ts, scripts/, and types/ receive neither no-restricted-imports nor the dynamic-import no-restricted-syntax guards; a server component in components/ or code in proxy.ts importing '@/lib/db' or `auth` from '@/lib/auth' lints clean. effective-config.test.ts pins resolution only for app/lib files, so the hole is also unpinned.

**Evidence.** eslint.config.mjs:173 'files: [\'app/**/*.{ts,tsx}\', \'lib/**/*.{ts,tsx}\']'; grep across the tree excluding app/, lib/, __tests__ found only proxy.ts:4 importing '@/lib/auth/secret' (not banned, correctly); all 20 components files are 'use client' today (grep count 20/20), so no current violation exists — the hole is future-facing.

**Impact.** The ADR-0001/ADR-0002 chokepoints are enforced by directory convention, not by the lint mechanism, for every directory that could grow server code. proxy.ts is precisely the file AGENTS.md §3 records reading a stale JWT field undetected — it sits outside the ban that exists because of that class. First violation ships silently.

**Direction (not an implementation).** Widen the general ban object to all TS sources (or add components/**, proxy.ts, scripts/**, types/** explicitly), and add one representative outside-app/lib file to effective-config.test.ts so the coverage boundary itself is pinned.

### CFG-06 [Medium] prisma.config.ts imports 'dotenv/config' but dotenv is not a declared dependency — phantom dependency via @prisma/config→c12
*prisma.config.ts:3* — sweep confidence: confirmed

**Claim.** prisma.config.ts line 3 does `import "dotenv/config"`, and its own generated header says 'assumes you have installed ... prisma dotenv' — but package.json declares dotenv nowhere. It resolves only because c12 (a dependency of @prisma/config) hoists dotenv@17.4.2 to node_modules/dotenv.

**Evidence.** prisma.config.ts:1-3; package.json:32-58 (no dotenv); package-lock.json: only dependent is 'node_modules/c12 -> ^17.3.1', c12's sole dependent is 'node_modules/@prisma/config'; node_modules/dotenv resolves to 17.4.2.

**Impact.** Any Prisma upgrade that drops or un-hoists c12/dotenv breaks every prisma.config.ts consumer (db:migrate, db:seed, db:reset, migrate deploy in CI and the Docker build) with a module-not-found error at a moment unrelated to the change that caused it. The install is currently reproducible only by accident of hoisting.

**Direction (not an implementation).** Add dotenv to devDependencies (the header comment already says to), or drop the import in favor of Prisma 7's own env loading if it suffices.

### CFG-07 [Medium] The required e2e gate boots the app with `next start` — a mode Next itself warns does not work with output:'standalone' — while production ships `node server.js`
*playwright.config.ts:27* — sweep confidence: confirmed

**Claim.** In CI, Playwright's webServer runs 'npm run start' (next start) against a build produced with output:'standalone' (next.config.ts:4). Next 16 explicitly warns '"next start" does not work with "output: standalone" configuration. Use "node .next/standalone/server.js" instead.' The Docker image runs the standalone server.js (docker/Dockerfile:48). So the merge-blocking e2e check exercises a server entry, env-loading path, and file layout that production never runs, and the standalone server the image ships is never booted by any gate.

**Evidence.** playwright.config.ts:27 'command: process.env.CI ? \'npm run start\' : \'npm run dev\''; next.config.ts:4 "output: 'standalone'"; node_modules/next/dist/server/next.js:225-227 (the warning, keyed on conf.output === 'standalone'); docker/Dockerfile:39,48 (copies .next/standalone, CMD ["node","server.js"]).

**Impact.** Defects specific to the standalone artifact — missing traced files (exactly the class next.config.ts:5-19's outputFileTracingIncludes comment worries about), the deleted-.env behavior, path/asset layout — are invisible to CI and first observed in the deployed image. The gate is green against a server production never runs.

**Direction (not an implementation).** Have the CI webServer command run the standalone artifact (node .next/standalone/server.js, with static/public copied as the Dockerfile does), or add a smoke job that boots the standalone output; at minimum record the divergence as a register row.

### CFG-08 [Low] Job-name-to-required-context coupling is guarded by comment only; a rename blocks all merges until branch-protection settings are hand-edited
*.github/workflows/ci.yml:35* — sweep confidence: confirmed

**Claim.** Required contexts ('lint, typecheck, test, build' and 'e2e', strict + enforce_admins — verified live) are string-matched against job name: fields at ci.yml:35 and :213. Nothing mechanical pins these names; the only guard is the comment at :395-401. A rename leaves every PR waiting on a check that never reports (no admin override with enforce_admins) until someone edits the protection settings.

**Evidence.** gh api repos/Alvin-Nahabwe/makai-rai-platform/branches/main/protection → contexts ["lint, typecheck, test, build","e2e"], strict:true, enforce_admins:true; ci.yml:35 'name: lint, typecheck, test, build', :213 'name: e2e'; no test scans ci.yml job names (node-version-alignment.test.ts is the only workflow-scanning test).

**Impact.** A well-intentioned rename (e.g. splitting the verify job) silently strands every open PR; the failure presents as 'expected checks' that never arrive, hours from the change that caused it. Recoverable via settings, so Low — but it is exactly the unguarded-coupling shape this project's doctrine targets.

**Direction (not an implementation).** Add a tiny test pinning the two name: literals in ci.yml (with a comment pointing at the protection settings), the same pattern node-version-alignment already uses for FROM lines.

### CFG-09 [Low] Dockerfile's deps stage is orphaned dead config using a deprecated npm flag
*docker/Dockerfile:15* — sweep confidence: confirmed

**Claim.** The deps stage (FROM base AS deps; npm ci --only=production) is referenced by no other stage — runner copies exclusively --from=builder (lines 38-42). It is dead config; --only=production is additionally deprecated in npm 10 (--omit=dev).

**Evidence.** docker/Dockerfile:15-18 defines deps; grep of the file shows no 'COPY --from=deps' anywhere (all copies are --from=builder, lines 38-42).

**Impact.** BuildKit skips the unused stage so cost is zero today, but the stage misleads readers into thinking a production-pruned node_modules feeds the image (the standalone output made that pattern obsolete), and a legacy builder would pay for a full extra npm ci.

**Direction (not an implementation).** Delete the deps stage.

### CFG-10 [Low] ci.yml's load-bearing comments carry stale line/path citations into playwright.config.ts and the fixture manifest
*.github/workflows/ci.yml:345* — sweep confidence: confirmed

**Claim.** ci.yml cites 'playwright.config.ts:19' for reuseExistingServer (actually :29), ':53' for the setup project (actually :63), ':58' for dependencies (actually :68), and twice names 'e2e/fixtures/manifest.json' where the real path is e2e/fixtures/.auth/manifest.json (manifest.ts:14,23 — which is what makes it gitignored, as the comment claims).

**Evidence.** ci.yml:345,353,364,370 vs playwright.config.ts:29,63,68; e2e/fixtures/manifest.ts:14 'AUTH_DIR = path.join(__dirname, \'.auth\')', :23 'MANIFEST_PATH = path.join(AUTH_DIR, \'manifest.json\')'; git check-ignore confirms .auth/manifest.json ignored, e2e/fixtures/manifest.json not.

**Impact.** This repo's comments are its institutional memory and are written to be trusted as evidence ('verified at <file>:<line>'); stale citations erode exactly that. The manifest-path error would also mislead anyone checking the 'gitignored' claim against the literal path given.

**Direction (not an implementation).** Correct the four citations; where a comment cites a line number in another file, prefer citing a symbol name that survives drift.

### CFG-11 [Low] package.json's "prisma".seed block appears to be dead config in Prisma 7, duplicating prisma.config.ts
*package.json:8* — sweep confidence: probable

**Claim.** package.json:8-10 declares "prisma": {"seed": "npx tsx prisma/seed.ts"} while prisma.config.ts:10 declares migrations.seed with the identical string. Prisma 7's config loader appears not to read package.json ('do not load from nearest package.json', @prisma/config/dist/index.js:611), making the package.json block inert duplication that can silently drift.

**Evidence.** package.json:8-10; prisma.config.ts:8-11; node_modules/@prisma/config/dist/index.js:611 '// do not load from nearest package.json'.

**Impact.** Two declarations of one command: an edit to only the dead one changes nothing while looking like it did — a miniature of the D-136 'assumed to merge' class.

**Direction (not an implementation).** Delete the package.json "prisma" block after confirming db:seed still resolves through prisma.config.ts.

### CFG-12 [Low] GitHub Actions pinned by tag (@v4), not commit SHA
*.github/workflows/ci.yml:108* — sweep confidence: confirmed

**Claim.** actions/checkout@v4, actions/setup-node@v4, actions/upload-artifact@v4 are mutable-tag pins. A workflow that deliberately narrows GITHUB_TOKEN to contents:read (lines 17-23) accepts a larger supply-chain surface from tag mutability than the token it hardened.

**Evidence.** ci.yml:108,111,304,307,389 (all uses: lines are @v4 tags).

**Impact.** A compromised or re-pointed tag executes arbitrary code in CI with repo read access and the inline (deliberately public) credentials. Low given the token is read-only and values are non-secrets, but inconsistent with the workflow's own least-privilege posture.

**Direction (not an implementation).** Pin to full commit SHAs with a tag comment (standard hardening), optionally with Dependabot updating them.

### CFG-13 [Low] .gitignore carries a stale /app/generated/prisma entry for an output path the generator no longer uses
*.gitignore:44* — sweep confidence: confirmed

**Claim.** prisma/schema.prisma uses the default prisma-client-js generator with no output override, generating into node_modules/.prisma (confirmed present); app/generated/prisma does not exist. The ignore entry (and .dockerignore:76's mirror, which at least documents itself as regenerated-in-container) is residue from an earlier generator config.

**Evidence.** .gitignore:44 '/app/generated/prisma'; prisma/schema.prisma:1-3 'generator client { provider = "prisma-client-js" }' (no output); ls node_modules/.prisma → client.

**Impact.** Harmless today, but a future reader may conclude the client generates into app/ and 'fix' code or Docker copies to match a path that is fiction.

**Direction (not an implementation).** Drop the entry or restore an explicit output to make it true.

### CFG-14 [Low] Playwright worker count is unpinned; fullyParallel:false serializes only within a file, so spec files can run concurrently against the one shared DB/server in CI
*playwright.config.ts:5* — sweep confidence: unconfirmed

**Claim.** The config sets fullyParallel: false but no workers value. Playwright's default worker count runs different spec FILES in parallel; only tests within a file are ordered. vitest.config.ts:15 explicitly serializes for the same shared-database reason ('one file's truncate deletes rows another file just created') — the e2e config makes no equivalent decision and records none.

**Evidence.** playwright.config.ts:5 'fullyParallel: false' with no workers key anywhere in the file; contrast vitest.config.ts:9-15.

**Impact.** If two spec files ever mutate overlapping state (shared org, rate-limiter counters — ci.yml:415-420 already documents the login rate limit as a shared-state hazard), CI gets ordering-dependent flakes that --fail-on-flaky-tests then converts into hard job failures. Suite is green today, so impact is latent.

**Direction (not an implementation).** Either pin workers: 1 in CI with a comment, or record why cross-file parallelism is safe (throwaway users per spec) where the vitest config records its opposite choice.

### CFG-15 [Low] effective-config.test.ts writes its lint probe into the tracked app/ tree; a killed run leaves residue that breaks npm run lint — and the residue was observed
*__tests__/lint/effective-config.test.ts:127* — sweep confidence: confirmed

**Claim.** The probe test writes app/__effective_config_probe.ts (importing `auth` from '@/lib/auth') into the real working tree and unlinks it in finally. A SIGKILL mid-test leaks it; while present, npm run lint fails on the ADR-0002 ban and the file sits as untracked residue. This session's starting git status showed exactly that residue ('?? app/__effective_config_probe.ts'); the file was gone by the time this audit inspected it (a later suite run rewrites-then-unlinks the same path).

**Evidence.** effective-config.test.ts:127-138 (writeFileSync to 'app/__effective_config_probe.ts', unlinkSync in finally); session-start git status: '?? app/__effective_config_probe.ts'; cat of the path during audit: No such file or directory.

**Impact.** A developer whose test run was killed sees npm run lint fail with an import-ban error in a file they never wrote — and per §4's own doctrine, untracked residue pollutes review packages. Low, but self-inflicted by probe placement.

**Direction (not an implementation).** Write the probe to a temp dir passed to eslint with --no-ignore, or at minimum add app/__effective_config_probe.ts to .gitignore and the eslint globalIgnores.

**Not examined by this auditor:**
- Whether the Docker image actually builds and boots (docker build + run of the standalone server, including the node_modules/.prisma copy working under Prisma 7) — Heavyweight multi-minute build; image-runtime correctness sits with the deployment-dimension auditor. Config-level coherence of the Dockerfile was reviewed instead.
- Full vitest, eslint, and Playwright suites end-to-end — Requires a provisioned local Postgres and a booted app; read-only audit budget went to config analysis. Only node-version-alignment.test.ts was executed (needed to prove the @types/node blind spot).
- docker/nginx/default.conf contents (proxy headers, X-Forwarded-For chain feeding the rate limiter, TLS config) — Existence verified only; correctness belongs to the deployment/security dimensions — note its X-Forwarded-For handling interacts with D-199 per ci.yml:415-420.
- Docker Compose v2 project-directory/.env resolution when run as `docker compose -f docker/docker-compose.prod.yml` from the repo root (whether ${POSTGRES_USER} interpolation even finds the runbook's repo-root .env) — Would require a live compose invocation to settle version-specific behavior; if interpolation also fails, finding CFG-01 worsens (empty DB credentials), but CFG-01 stands regardless.
- scripts/pen-test.mjs (npm run test:security) and whether it could/should be a CI job — currently no workflow runs it — Did not read the script to determine its prerequisites (likely a running app); flagging its absence from CI as a question for the security-dimension auditor rather than asserting a gap.
- Resolved-config verification that eslint's base rules actually cover e2e/ and scripts/ (as opposed to the ban rules, whose absence there is finding CFG-05) — eslint v9 flat-config default '.'-scan behavior was relied on; no --print-config run was performed for a file in those directories.

## dependency-platform

The platform's dependency posture is disciplined in structure (exact framework pins, coherent Node 22 everywhere, lockfile matching the installed tree, unusually well-documented Prisma/RLS platform constraints) but carries two unmanaged production vulnerability chains: the entire auth system rides next-auth 5.0.0-beta.31 whose @auth/core dependency has a critical-severity advisory chain fixed in beta.32 (published 2026-07-20, still unapplied), and Next.js 16.2.9 has 9 high-severity advisories fixed in 16.3.1 (published 2026-08-13). Neither risk is recorded in DEFERRED_REGISTER despite the project's own §6 discipline, and no mechanism exists anywhere (CI audit step, dependabot, renovate, register row) to notice dependency CVEs. Production npm audit: 12 vulnerabilities (2 critical, 5 high, 5 moderate). The vendored assessment engine is currently byte-identical to the still-deployed SPA's copy (modulo 3 import lines) but nothing mechanically ties them.

**Sound (what is genuinely good):**
- Prisma 7.8 + @prisma/adapter-pg constraints with the RLS/GUC approach are exceptionally well recorded: docs/superpowers/spikes/2026-08-02-rls-prisma7-findings.md documents the $extends NO-GO (probe A: GUC lands on a different pooled connection, fails closed), the adapter requirement, and names PgBouncer behaviour as unverified; register D-065 tracks pool sizing and unpinned transaction timeout/maxWait with a documented self-correction on PgBouncer modes; D-161 tracks the connection-identity memo assumption. This is the model the other dependency risks should have followed.
- Version pinning is coherent where it matters: next and eslint-config-next both exact-pinned 16.2.9; react and react-dom exact-paired at 19.2.4; all 12 lockfile spot-checks matched the installed tree (npm ls output equals package-lock resolved versions).
- Node 22 is coherent across .nvmrc (22), package.json engines (>=22), docker/Dockerfile ARG NODE_VERSION=22 (node:22-alpine), CI node-version-file: '.nvmrc', and the running runtime (v22.22.3) — with the single exception of @types/node (finding DEP-4).
- next-auth blast radius is contained by design: only 6 files import next-auth (lib/auth.ts, proxy.ts, types/next-auth.d.ts augmentation, 3 client components); identity flows through the requireIdentity() choke point per types/next-auth.d.ts's documented rationale; and D-053 deliberately avoids committing the identity model to the beta's adapter schema — a conscious hedge against exactly the v5-GA-breaking-change scenario.
- bcryptjs's CPU cost was measured (230ms mean at cost 12, lib/rate-limit.ts:39) and explicitly factored into rate-limit sizing (D-195's closure derivation computes the CPU ceiling per IP per window from it) — the operational consequence of the hashing choice is understood even though the choice itself is unrecorded.
- resend is caret-ranged (^6.16.0) but locked at 6.16.0 and isolated behind a single module (lib/email/send.ts), so provider swap-out cost is low; email-path risk is already tracked across multiple register rows (D-018, D-048, D-067, D-091, D-097, D-122, D-123).

### DEP-1 [High] Entire auth system on next-auth beta carrying a critical @auth/core advisory chain; fix one beta-step away for ~4 weeks; risk recorded nowhere
*package.json:38* — sweep confidence: confirmed

**Claim.** next-auth ^5.0.0-beta.31 (resolved beta.31) is the whole auth system, v5 has never gone GA (registry dist-tags: latest=4.24.15, beta=5.0.0-beta.32), and the installed beta depends on @auth/core <=0.41.2 which npm audit rates critical with 3 advisories (homoglyph email-normalizer bypass GHSA-7rqj-j65f-68wh, getToken() uncaught exception on malformed Bearer headers GHSA-xmf8-cvqr-rfgj, OAuth state/nonce/PKCE cookies not provider-bound GHSA-x445-f3h2-j279). beta.32, which clears the audit, was published 2026-07-20 — four weeks before this audit — and has not been taken. The beta-line risk itself has no DEFERRED_REGISTER row: grep for 'next-auth@'/'beta' finds only D-053's passing mention (about avoiding the beta's adapter schema, not about the auth stack riding a beta).

**Evidence.** package.json:38 "next-auth": "^5.0.0-beta.31"; npm audit --omit=dev: "@auth/core <=0.41.2 / Severity: critical ... node_modules/next-auth Depends on vulnerable versions of @auth/core"; npm view next-auth dist-tags: {latest: "4.24.15", beta: "5.0.0-beta.32"}; npm view next-auth time: beta.31=2026-04-14, beta.32=2026-07-20; grep -n "beta.3" docs/DEFERRED_REGISTER.md → only D-053 (line 99).

**Impact.** Known-critical advisories sit in the auth core of a security-governance product with a drop-in fix available. Direct exploitability is limited by configuration — credentials-only (no OAuth providers, so the cookie-binding advisory is moot) and proxy.ts wraps getToken in try/catch with logging (proxy.ts:119-124), mitigating the uncaught-exception DoS — but the email-normalizer path was not traced and the vulnerable code ships. Separately, v5 GA remains a standing breaking-change event with no owner: nothing will fire when it lands.

**Direction (not an implementation).** Take beta.32 now (clears the audit criticals within the same beta line), and open a register row for the beta-line dependency with a pick-up trigger bound to the v5 GA release event, per the project's own §6.

**Verification: CONFIRMED.** Every load-bearing fact reproduced independently: the pin, the installed @auth/core 0.41.2 critical chain with the three named GHSA ids, the beta.31/beta.32 publish dates (4-week gap to audit date), beta.32 resolving to @auth/core 0.41.3 which exits the vulnerable range, and the register containing only D-053's passing beta mention. I tried to kill it on reachability and went further than the auditor: the homoglyph normalizer runs only in @auth/core's email-provider send-token action (node_modules/@auth/core/lib/actions/signin/send-token.js:11-12) and lib/auth.ts:37-38 configures Credentials only, so with the OAuth advisory mooted and getToken wrapped in a logged try/catch (proxy.ts:119-141), no advisory is directly reachable today — but the finding already discounted Critical to High on exactly these grounds, and the residual gap (audit-critical code shipping in the auth core of a security-governance product, drop-in fix un-taken for 4 weeks, unrecorded per the project's own §6, one configuration change from reachable with no surveillance mechanism to notice) is a real defect with concrete operator impact. High stands.

*Verifier evidence:* package.json:38; npm audit --omit=dev output: '@auth/core <=0.41.2 / Severity: critical' with GHSA-7rqj-j65f-68wh, GHSA-xmf8-cvqr-rfgj, GHSA-x445-f3h2-j279; npm view next-auth dist-tags → latest=4.24.15, beta=5.0.0-beta.32; npm view next-auth time → beta.31=2026-04-14, beta.32=2026-07-20; npm view next-auth@5.0.0-beta.32 dependencies → {"@auth/core":"0.41.3"}; node_modules/next-auth/package.json → 5.0.0-beta.31/@auth/core 0.41.2; lib/auth.ts:37-38 (Credentials only); proxy.ts:119-141 (getToken in logged try/catch); node_modules/@auth/core/lib/actions/signin/send-token.js:11-12; grep of docs/DEFERRED_REGISTER.md for next-auth/beta/CVE/advisor/vulnerab/GA/upgrade → only D-053 at line 99

### DEP-2 [High] Next.js 16.2.9 carries 9 high-severity advisories fixed in 16.3.1, including proxy/middleware bypass relevant to proxy.ts, plus vulnerable bundled postcss/sharp/nanoid
*package.json:37* — sweep confidence: confirmed

**Claim.** next is exact-pinned 16.2.9 (a stable-line release, 2026-06-09; not canary) but npm audit lists 9 advisories against it — middleware/proxy bypass with Turbopack (GHSA-6gpp-xcg3-4w24), Server Action DoS and SSRF, cache confusion of response bodies (x2), unbounded Edge payload, SSRF in rewrites, SVG image-optimization DoS (GHSA-q8wf-6r8g-63ch), and unauthenticated disclosure of Server Function endpoints — all fixed in 16.3.1 (published 2026-08-13). Its bundled chain is also flagged: postcss 8.4.31 (high, 4 advisories), sharp 0.34.5 (high, libvips CVEs), nanoid 3.3.15 (high). The app plausibly exposes several: it has a proxy.ts doing rate limiting and token decode on matched routes, builds with Turbopack (next.config.ts's own comment describes 'files Turbopack's tracer placed inside .next/standalone'), and uses next/image in at least 3 components (Sidebar.tsx, register/page.tsx, forgot-password/page.tsx). No Server Actions ('use server' grep: zero hits), so those advisories are not in path.

**Evidence.** npm audit: "next 9.3.4-canary.0 - 16.3.0-preview.10 / Severity: high / [9 advisories] / Will install next@16.3.1"; npm view next dist-tags: latest=16.3.1; npm view next time: 16.2.9=2026-06-09, 16.3.1=2026-08-13; npm ls: next@16.2.9 → postcss@8.4.31 → nanoid@3.3.15, sharp@0.34.5; grep proxy.ts:2 "import { getToken } from 'next-auth/jwt'".

**Impact.** A proxy/middleware bypass would defeat the rate limiter and any residual gating in proxy.ts (auth redirect decisions moved to requireIdentity(), limiting but not eliminating the blast radius); the SVG image-optimization DoS is reachable if the image optimizer is enabled. Fix is a minor-version bump, but the AGENTS.md warning that this Next has breaking changes vs training data means the upgrade needs its docs read, not assumed. The advisories are 4 days old at audit time, so the staleness window is small — the sharper problem is that nothing would ever have surfaced them (DEP-3).

**Direction (not an implementation).** Upgrade to 16.3.1 (and re-run the live e2e suite per C5); verify whether the deployed topology meets GHSA-6gpp's 'single locale' precondition before treating the proxy bypass as theoretical.

**Verification: CONFIRMED.** Reproduced the audit myself: next 16.2.9 (exact-pinned, installed) carries exactly the 9 named high advisories with 'Will install next@16.3.1', publish dates 16.2.9=2026-06-09 and 16.3.1=2026-08-13 (latest), and the bundled postcss 8.4.31→nanoid 3.3.15 and sharp 0.34.5 chains all flagged. Exposure claims check out: Turbopack is in the build path (next.config.ts:9 comment), next/image is used in 4 files, proxy.ts does rate limiting plus token decode on matched routes, and 'use server' greps zero — the finding already excludes the Server-Action advisories honestly. I tried to narrow it via unverified preconditions and the absence of any production deployment (D-018 parked, D-038: 'No production deployment exists'), but the cache-confusion pair and the middleware/proxy bypass sit in the default request path of the self-hosted standalone topology this repo builds, the app is multi-tenant, and the fix is a drop-in minor version — a real defect with concrete operator impact before any deploy can happen.

*Verifier evidence:* package.json:37 '"next": "16.2.9"'; npm audit --omit=dev output listing all 9 GHSA ids (GHSA-6gpp-xcg3-4w24, GHSA-m99w-x7hq-7vfj, GHSA-89xv-2m56-2m9x, GHSA-68g3-v927-f742, GHSA-4633-3j49-mh5q, GHSA-4c39-4ccg-62r3, GHSA-p9j2-gv94-2wf4, GHSA-q8wf-6r8g-63ch, GHSA-955p-x3mx-jcvp) and 'Will install next@16.3.1'; npm view next dist-tags → latest=16.3.1; npm view next time → 16.2.9=2026-06-09T23:02Z, 16.3.1=2026-08-13T22:45Z; npm ls → next@16.2.9→postcss@8.4.31→nanoid@3.3.15, sharp@0.34.5; next.config.ts:9 (Turbopack tracer), next.config.ts:4 output:'standalone'; grep next/image → 4 files; grep 'use server' → zero hits; docs/DEFERRED_REGISTER.md rows D-018 (line 64) and D-038 (line 84)

### DEP-11 [High] Full production npm audit enumeration (for the record): 12 vulnerabilities — 2 critical, 5 high, 5 moderate
*package-lock.json* — sweep confidence: confirmed

**Claim.** npm audit --omit=dev (run 2026-08-17): @auth/core <=0.41.2 CRITICAL (3 advisories, via next-auth — see DEP-1); next 16.2.9 HIGH (9 advisories — see DEP-2); postcss 8.4.31 HIGH (4 advisories, via next); sharp 0.34.5 HIGH (libvips CVE batch, via next); nanoid 3.3.15 HIGH (2 advisories, via postcss←next); fast-uri 3.1.3 HIGH (2 advisories, via ajv←@prisma/dev←prisma); hono <=4.12.33 MODERATE (4 advisories) and @hono/node-server MODERATE (2) and valibot MODERATE (1), all via @prisma/dev←prisma. Note: the prisma CLI chain (fast-uri/hono/valibot) is nominally a devDependency yet npm's --omit=dev audit still reports it — in practice it is dev-tooling exposure (Prisma's local dev server), not request-path code. Dev-only additions in the full audit: brace-expansion HIGH, js-yaml 4.3.0 HIGH (via eslint) → 14 total (5 moderate, 7 high, 2 critical).

**Evidence.** `npm audit --omit=dev` → '12 vulnerabilities (5 moderate, 5 high, 2 critical)'; `npm audit` → '14 vulnerabilities (5 moderate, 7 high, 2 critical)'; parent chains confirmed via `npm ls nanoid fast-uri js-yaml postcss sharp`.

**Impact.** The genuinely request-path-exposed set is the @auth/core criticals and the next/postcss/sharp/nanoid chain — all cleared by exactly two upgrades: next-auth beta.31→beta.32 and next 16.2.9→16.3.1.

**Direction (not an implementation).** Treat DEP-1 and DEP-2's two upgrades as the remediation; the prisma-CLI moderates follow whenever prisma is next bumped.

**Verification: CONFIRMED.** The enumeration is exact against my own reruns on 2026-08-17: npm audit --omit=dev reports precisely '12 vulnerabilities (5 moderate, 5 high, 2 critical)' and the full audit '14 vulnerabilities (5 moderate, 7 high, 2 critical)', with every package, severity, advisory count, and parent chain matching (including the dev-only brace-expansion and js-yaml 4.3.0-via-eslint additions, and fast-uri 3.1.3 reached via ajv under @prisma/streams-local under @prisma/dev under prisma). The anomaly the finding honestly reports — the prisma devDependency chain still appearing under --omit=dev — reproduces in my run too. The impact framing is correct: the request-path exposure is the @auth/core criticals plus the next/postcss/sharp/nanoid chain, and both are cleared by exactly the two upgrades named in DEP-1/DEP-2. High is inherited from those request-path chains and stands; nothing I checked contradicts a single cell of the enumeration.

*Verifier evidence:* npm audit --omit=dev (run 2026-08-17) → '12 vulnerabilities (5 moderate, 5 high, 2 critical)'; npm audit → '14 vulnerabilities (5 moderate, 7 high, 2 critical)'; npm ls postcss sharp nanoid fast-uri hono valibot js-yaml → next@16.2.9→postcss@8.4.31→nanoid@3.3.15, sharp@0.34.5; prisma@7.8.0→@prisma/dev@0.24.3→{@hono/node-server@1.19.11→hono@4.12.27, @prisma/streams-local@0.1.2→ajv@8.20.0→fast-uri@3.1.3, valibot@1.2.0}; eslint@9.39.4→@eslint/eslintrc@3.3.5→js-yaml@4.3.0; audit output sections for @auth/core (critical, 3 advisories), next (9), postcss (4), sharp (libvips CVE batch), nanoid (2), fast-uri (2), hono (4 moderate), @hono/node-server (2 moderate), valibot (1 moderate), brace-expansion (dev)

### DEP-3 [Medium] No dependency-vulnerability surveillance exists anywhere: no CI audit step, no dependabot/renovate, no register row — by the project's own §6 standard, an unrecorded accepted risk
*.github/workflows/ci.yml* — sweep confidence: confirmed

**Claim.** There is no mechanism that would ever notice a dependency CVE: grep -rn -i 'audit' .github/workflows/ returns nothing; .github/dependabot.yml and renovate.json do not exist; grep -n 'npm audit' docs/DEFERRED_REGISTER.md returns nothing across 144 open rows. DEP-1 and DEP-2 are the direct product of this gap — a critical auth advisory and 9 framework advisories accumulated with fixes published weeks/days ago and nothing fired.

**Evidence.** Commands run 2026-08-17: `grep -rn -i "audit\|outdated" .github/workflows/` → empty; `ls .github/dependabot.yml renovate.json` → No such file or directory (both); `grep -n "npm audit" docs/DEFERRED_REGISTER.md` → empty. Full npm audit: 14 vulnerabilities (5 moderate, 7 high, 2 critical); --omit=dev: 12 (5 moderate, 5 high, 2 critical).

**Impact.** For a platform whose product is governance discipline and whose AGENTS.md §7.1 declares security foundational, third-party code — the majority of the running system — is an unwatched surface. The project's own doctrine (§0: 'an obligation that names no observable trigger will not fire') predicts exactly this outcome: dependency review bound to no checkpoint fired zero times.

**Direction (not an implementation).** Add an `npm audit --omit=dev --audit-level=high` step to ci.yml (a mechanical trigger, matching §0.4 'prefer converting a rule into a script'), and a register row for the currently-known advisory set with a pick-up trigger.

### DEP-4 [Medium] @types/node pinned to ^20 while every runtime surface is Node 22
*package.json:48* — sweep confidence: confirmed

**Claim.** devDependencies declare "@types/node": "^20" (resolved 20.19.43) while .nvmrc says 22, engines says >=22, the Dockerfile builds node:22-alpine, CI uses node-version-file '.nvmrc', and the local runtime is v22.22.3. Typecheck therefore validates against the Node 20 API surface: Node 22-only APIs are untyped or mistyped, and the caret can never reach 22.x.

**Evidence.** package.json:48 '"@types/node": "^20"'; lockfile: node_modules/@types/node -> 20.19.43; .nvmrc contents '22'; docker/Dockerfile:11-12 'ARG NODE_VERSION=22 / FROM node:${NODE_VERSION}-alpine'; ci.yml:115 "node-version-file: '.nvmrc'"; node --version → v22.22.3.

**Impact.** tsc can pass code that fails at runtime on Node-version-dependent behaviour, and Node 22 APIs are unusable without ts-ignore — a silent two-major skew in the platform contract the type system is supposed to enforce.

**Direction (not an implementation).** Bump to @types/node ^22 and re-run typecheck.

### DEP-5 [Medium] Password hashing is pure-JS bcryptjs on the main event loop; the library-choice tradeoff (vs threadpool-offloaded native bcrypt/argon2) is recorded nowhere
*lib/rate-limit.ts:39* — sweep confidence: confirmed

**Claim.** bcryptjs 3.0.3 (pure JS, no libuv threadpool offload) performs all password hashing at cost 12, measured by the project itself at 230ms mean per hash — CPU burned on the JS event loop for every login, registration, and password change, serializing under concurrency. The cost consequence is understood and factored into rate-limit sizing (D-195's derivation computes an ~11.5 CPU-seconds-per-IP-per-window ceiling from it), but the choice of bcryptjs over native bcrypt/argon2 — which would move that CPU off the event loop — appears in no ADR and no register row: grep -i 'bcrypt|argon|hashing' over docs/adr/*.md returns nothing, and the register has no row for it.

**Evidence.** lib/rate-limit.ts:39 "bcryptjs hash(cost=12) measured at 230ms mean -- 50 accepted"; package.json:36 '"bcryptjs": "^3.0.3"'; `grep -rn -i "bcrypt\|argon" docs/adr/*.md` → empty; hash call sites confirmed at app/api/auth/register/route.ts:63, app/api/v1/invitations/[token]/register/route.ts:63, app/api/users/me/route.ts:122, app/api/users/me/password/route.ts:55, prisma/seed.ts:108.

**Impact.** Every concurrent login stalls all other requests on the same Node process for ~230ms of pure CPU — an amplification lever for cheap request floods that native hashing would blunt by ~3x speed and threadpool offload. Defensible as a deliberate tradeoff (no native build deps in the alpine Docker image), but it is exactly the class of choice the project's own §6 says gets a row, and D-195 already documented that the CPU ceiling, not abuse policy, is what bounds the registration cap.

**Direction (not an implementation).** Record the hashing-library decision (ADR or register row) with the CPU-ceiling reasoning; evaluate argon2/native bcrypt when hosting (D-018) is decided, since the alpine-build-deps constraint is a hosting property.

### DEP-6 [Medium] Vendored engine is an unmanaged fork of the still-deployed SPA — currently in sync, but nothing mechanically ties them and no register row names the divergence risk
*lib/engine/AssessmentEngine.js:18* — sweep confidence: confirmed

**Claim.** lib/engine/AssessmentEngine.js is a copy of ../toolkit/src/engine/AssessmentEngine.js differing only in 3 import-path lines (diff confirms; data/questionBank.json, scoringConfig.json, assessmentAreas.json are byte-identical across the two repos). The SPA is still present, has a netlify.toml (deployed), had feature commits through 2026-06 (engine last touched 2026-06-19, repo last commit 2026-06-29), and AGENTS.md §7.4 declares 'The live SPA is the baseline.' No sync mechanism exists: no checksum test, no submodule, no script, and the register's closest row (D-034, harvest classification of engine mechanics) is about classification, not synchronization — grep -i 'diverge|fork|vendor' finds no row naming SPA↔platform engine drift.

**Evidence.** `diff toolkit/src/engine/AssessmentEngine.js toolkit-platform/lib/engine/AssessmentEngine.js` → only lines 18-20 (import paths) differ; `diff -q` on the three data JSONs → no output (identical); `git -C toolkit log -1` → 244b9bb 2026-06-29; platform migration commit 886b243 'feat: migrate engine, data, tests, and assets from Vite SPA'.

**Impact.** The scoring engine — the product's core intellectual property — can silently diverge in either direction: an SPA content/logic fix never reaches the platform, or platform scores stop matching the 'baseline' the whole project is judged against. Because the copies are identical today, the first divergence will be invisible to every diff-scoped review (the §3 whole-tree class). Secondary evidence of copy-not-adapt: the header comment still says 'sessionStorage persistence' (line 12) while the code uses localStorage (lines 83-107), and the browser persistence exports (saveState/loadState/clearState) have zero platform callers — the latter already tracked as D-182.

**Direction (not an implementation).** Either declare the fork authoritative (retire the SPA as baseline, record it) or add a mechanical sync check (a test hashing both engines/data when the SPA repo is present) plus a register row with the divergence event as pick-up trigger.

### DEP-7 [Low] bcrypt cost factor 12 duplicated as a bare literal at 5 sites with no shared constant
*app/api/auth/register/route.ts:63* — sweep confidence: confirmed

**Claim.** The work factor 12 is hand-written independently in app/api/auth/register/route.ts:63, app/api/v1/invitations/[token]/register/route.ts:63, app/api/users/me/route.ts:122, app/api/users/me/password/route.ts:55, and prisma/seed.ts:108. No shared BCRYPT_COST constant exists, and the rate limiter's sizing math (lib/rate-limit.ts:39) also depends on this exact number.

**Evidence.** grep -rn "hash(" across app/lib/prisma → five call sites all passing literal 12; no grep hit for a shared cost constant.

**Impact.** Raising the cost at one site (e.g. after a hardware review) silently leaves the others weaker, and desynchronizes the rate-limit CPU-budget reasoning that D-195 recorded — the project's own §3 principle ('a hand-written list that must be complete is a latent defect') applies.

**Direction (not an implementation).** Hoist to one exported constant next to the hashing helper; reference it from rate-limit.ts's comment.

### DEP-8 [Low] @types/bcryptjs ^2.4.6 is for the 2.x API while bcryptjs 3.0.3 ships its own types
*package.json:47* — sweep confidence: confirmed

**Claim.** devDependencies include @types/bcryptjs ^2.4.6 (written for bcryptjs 2.x), but installed bcryptjs 3.0.3 declares its own types ("types": "umd/index.d.ts"), making the DefinitelyTyped package redundant and a potential source of stale/conflicting signatures depending on resolution order.

**Evidence.** package.json:47 '"@types/bcryptjs": "^2.4.6"'; node -e reading node_modules/bcryptjs/package.json → '3.0.3 umd/index.d.ts'.

**Impact.** Type resolution may bind to the 2.x-era definitions, hiding 3.x API changes from typecheck.

**Direction (not an implementation).** Remove @types/bcryptjs.

### DEP-9 [Low] Five extraneous packages in node_modules not recorded by the dependency tree
*package.json* — sweep confidence: confirmed

**Claim.** npm ls --depth=0 flags @emnapi/core@1.10.0, @emnapi/runtime@1.11.1, @emnapi/wasi-threads@1.2.1, @napi-rs/wasm-runtime@1.1.6, and @tybys/wasm-util@0.10.3 as extraneous — installed but owned by nothing in the tree.

**Evidence.** npm ls --depth=0 output: five entries suffixed 'extraneous'; npm ls @emnapi/core confirms the orphan subtree.

**Impact.** node_modules does not exactly reproduce from the lockfile (npm ci would not install these), so local behaviour can differ from CI — the exact class of drift the project's C4 untracked-residue rule exists to catch, in dependency form.

**Direction (not an implementation).** npm prune, or re-run npm ci and confirm the flag clears.

### DEP-10 [Low] Hand-maintained AssessmentEngine.d.ts duplicates the JS export surface with no mechanical check tying them
*lib/engine/AssessmentEngine.d.ts:1* — sweep confidence: confirmed

**Claim.** The type surface for the 26KB plain-JS engine is a separately hand-written .d.ts. The 19 declared exports match the JS's 19 `export function`s today, but nothing (no checkJs, no test) verifies the pairing — a signature change in the JS silently strands the types.

**Evidence.** `grep -c '^export' AssessmentEngine.js` → 19; `grep -c 'export' AssessmentEngine.d.ts` → 19; no test references the .d.ts (no grep hits outside the file).

**Impact.** Consumers (lib/data/assessments.ts) typecheck against a description that can rot independently of the implementation — the same declared-but-unverified pattern D-209 names as having seven prior members in this codebase.

**Direction (not an implementation).** Enable checkJs for lib/engine or add a test that imports the JS under the declared types and exercises each export's arity.

**Not examined by this auditor:**
- Per-advisory exploitability of the 9 Next.js CVEs in this deployment topology (e.g. GHSA-6gpp's 'single locale' precondition, cache-confusion deployment conditions, whether the image optimizer serves SVGs here) — Requires reading each advisory's full text and the deployed hosting config; hosting is itself still parked (D-018), so topology is undecided
- Whether @auth/core's vulnerable email normalizer is actually reachable in this credentials-only configuration — Would require tracing @auth/core's credentials/registration code paths in node_modules; registration is handled by the app's own routes, making reachability plausible-but-unproven either way
- Currency of @react-pdf/renderer 4.5.1, recharts 3.9.0, pg 8.22.0, @playwright/test, vitest against their latest releases — No advisories flagged against them; staleness-without-vulnerability was lower priority than the flagged chains within capacity
- Why the prisma devDependency chain (fast-uri/hono/valibot) still appears in npm audit --omit=dev output — Anomaly observed and reported honestly in DEP-11; diagnosing npm's omit semantics for this npm version was not load-bearing for any finding
- Full package-lock.json integrity audit (resolved URLs, integrity hashes, registry provenance) beyond the 12-package version spot check — Capacity; no signal of tampering arose from the spot checks
- The claim that vendored node_modules/next/dist/docs diverges from public Next.js documentation (AGENTS.md's 'NOT the Next.js you know') — Verifying would require comparing vendored docs against upstream; treated as a given of the environment, not a risk finding

## deployment-ops

The deployment layer is the one part of this project that never received the project's own rigor: it predates the current architecture (compose/nginx from June, runbooks never re-executed) and following the deployment runbook verbatim on a fresh VPS fails at multiple independent, confirmed points — compose never receives the .env values (proven empirically), the app container is given only 3 of the ~8 env vars it needs (APP_DATABASE_URL, the RLS-critical one, is missing), production login is dead on arrival from NextAuth's trustHost default (a failure CI itself reproduced and fixed only in CI), and there is no workable path to run migrations or seed inside the shipped image. Ops posture is thin: security logs are erased by every redeploy, backup failures are structurally silent, restore has never been executed, and monitoring is an external ping. The genuinely good news: failure modes are consistently fail-closed (misconfig produces loud 500s, never silent RLS bypass), and most gaps are honestly recorded in the deferred register — but the register rows are gated on D-018 (hosting), whose trigger has now fired while the row still says PARKED.

**Sound (what is genuinely good):**
- Fail-closed discipline is real and tested: lib/data/connection.ts refuses missing/partial APP_DATABASE_URL and PGOPTIONS injection so a deployment misconfig 500s loudly instead of silently connecting as the RLS-bypassing owner (D-086); lib/email/send.ts throws on Resend error-as-value; seed refuses known-bad admin passwords.
- .dockerignore is exemplary: root-caused (D-149 .env leak into the image was found live, not assumed), two independent layers (.dockerignore + postbuild rm of .next/standalone/.env*), each justified against the other.
- Evidence bytes live in Postgres (schema.prisma:404 EvidenceBlob.content Bytes), so pg_dump genuinely covers evidence — one backup artifact protects everything.
- Prod compose does not publish Postgres to the host (attack surface); Dockerfile runs as non-root nextjs, multi-stage, standalone output, with a Node-version alignment test (.nvmrc 22 == Dockerfile ARG 22).
- Known single-instance and trusted-proxy limitations are honestly recorded with triggers: D-046 (in-memory rate limit store breaks multi-instance), D-199/D-124 (x-forwarded-for spoofable, blocked on topology), D-076 (app-role password), D-107 (unbounded org creation).
- nginx TLS config is modern (TLS1.2/1.3, HSTS, sane ciphers), certbot renewal cron has pre/post hooks, DNS section exists, and the runbook covers firewall/non-root user basics.
- Backup script verifies gzip integrity, has a 30-day retention prune, and the restore procedure includes row-count verification; troubleshooting.md (500 lines) covers OOM, disk-full, build failures and migration conflicts with concrete commands.
- CI e2e runs a real production server (npm run start) — which is exactly how the trustHost failure got reproduced and documented (ci.yml:261-282), even though the fix never propagated to production config.

### DEP-01 [Critical] Runbook's compose invocation receives no environment values — Postgres cannot even start
*docs/runbooks/deployment.md:185* — sweep confidence: confirmed

**Claim.** The runbook (section 4: `cp .env.example .env` at repo root; section 6.1: `docker compose -f docker/docker-compose.prod.yml up -d --build` from repo root) does not work: compose resolves the .env interpolation file against the compose file's directory (project dir = docker/, `name: docker`), not the cwd, so every variable is blank.

**Evidence.** Ran `docker compose -f docker/docker-compose.prod.yml config` from the repo root with a populated repo-root .env present (it defines NEXTAUTH_SECRET, DATABASE_URL, etc. — verified by listing its keys): output warns 'The "NEXTAUTH_SECRET" variable is not set. Defaulting to a blank string' for all six variables and renders `DATABASE_URL: postgresql://:@postgres:5432/`, `NEXTAUTH_SECRET: ""`. No docker/.env exists.

**Impact.** First deployment fails at step 6.1: postgres:16-alpine refuses to start with an empty POSTGRES_PASSWORD, so the healthcheck never passes and nextjs never starts. Every later runbook step is unreachable. This also proves the runbook was never executed end-to-end.

**Direction (not an implementation).** Make the compose invocation and env location agree (env_file: directive, --env-file flag, or document .env living in docker/), then actually walk the runbook on a scratch VM before the real deploy.

**Verification: CONFIRMED.** Reproduced the mechanism myself, not from the auditor's output: with a populated repo-root .env (keys include NEXTAUTH_SECRET, DATABASE_URL, APP_DATABASE_URL — verified by listing), `docker compose -f docker/docker-compose.prod.yml config` from the repo root warns 'variable is not set. Defaulting to a blank string' for every variable and renders `DATABASE_URL: postgresql://:@postgres:5432/` with project `name: docker`; no docker/.env exists and the compose file has no env_file directive. The runbook (section 4 `cp .env.example .env` at repo root, section 6.1 compose up from repo root) therefore hands Postgres an empty POSTGRES_PASSWORD, which the official image refuses, so the healthcheck never passes and nextjs (depends_on: service_healthy) never starts. I tried to kill it via a shell-export path or an alternate env location — the runbook instructs neither, and nothing else supplies the values. Failure is loud and quick to fix once seen, but it independently renders the entire documented deployment inoperative at its first step, which invalidates the core promise of a deployable platform; Critical stands.

*Verifier evidence:* Command: `docker compose -f docker/docker-compose.prod.yml config` from /home/alvin/Downloads/MAK_RAI/toolkit-platform → 'The "NEXTAUTH_SECRET" variable is not set...' (all vars), `name: docker`, `DATABASE_URL: postgresql://:@postgres:5432/`; `ls docker/.env` → no such file; docs/runbooks/deployment.md:100,183-185; docker/docker-compose.prod.yml:11-14 (no env_file)

### DEP-02 [Critical] Prod compose passes only 3 env vars to the app — APP_DATABASE_URL (the RLS spine), Resend and admin-seed vars never reach the container
*docker/docker-compose.prod.yml:11* — sweep confidence: confirmed

**Claim.** The nextjs `environment:` block passes only DATABASE_URL, NEXTAUTH_SECRET, NEXTAUTH_URL. APP_DATABASE_URL, RESEND_API_KEY, EMAIL_FROM_ADDRESS and ADMIN_* are never injected, so even with DEP-01 fixed the container lacks them. The D-076 'docs half fixed' closure (adding APP_DATABASE_URL to the runbook's .env block) is ineffective: nothing carries that .env value into the container.

**Evidence.** docker/docker-compose.prod.yml:11-14 — `environment: DATABASE_URL... NEXTAUTH_SECRET... NEXTAUTH_URL` and nothing else (no env_file). lib/data/connection.ts:23-31 throws when APP_DATABASE_URL is unset ('Refusing to construct a connection pool'). app/api/v1/orgs/[slug]/members/route.ts:105-107 throws when EMAIL_FROM_ADDRESS unset. DEFERRED_REGISTER.md D-076 row records the runbook fix on 2026-08-12 without touching compose.

**Impact.** Every tenant-data request 500s at first data access (appClient is lazy, so the container boots and looks healthy, then fails on real traffic); every invitation 500s. Fail-closed by design — no silent RLS bypass — but the deployment is dead, and the register believes this class was half-fixed.

**Direction (not an implementation).** Pass the full required env set into the nextjs service (env_file or explicit entries), and add a startup-time env preflight so missing vars fail the container at boot instead of at first request.

**Verification: CONFIRMED.** docker/docker-compose.prod.yml:11-14 passes exactly DATABASE_URL, NEXTAUTH_SECRET, NEXTAUTH_URL to the nextjs service — no APP_DATABASE_URL, RESEND_API_KEY, EMAIL_FROM_ADDRESS, or ADMIN_*, and no env_file. lib/data/connection.ts:23-31 throws on unset APP_DATABASE_URL, and the client is a lazy Proxy (hmrSingleton, connection.ts:294) constructed at first property access, so the container boots healthy and every tenant-data request then 500s — exactly as claimed. The D-076 register row confirms the 2026-08-12 fix touched only the runbook's .env block ('DOCS HALF FIXED... enforcement half remains open'), never compose, so the register does believe the class was half-addressed. One evidence correction that does not change the verdict: invitations do NOT 500 — the EMAIL_FROM_ADDRESS throw at members/route.ts:105-107 is caught at :117 and returns 201 with emailSent:false — but the APP_DATABASE_URL outage alone (all tenant data dead in production) sustains Critical.

*Verifier evidence:* docker/docker-compose.prod.yml:11-14; lib/data/connection.ts:23-31,294; app/api/v1/orgs/[slug]/members/route.ts:105-141 (throw caught, 201 returned); docs/DEFERRED_REGISTER.md:122 (D-076 row)

### DEP-03 [Critical] Production login is a guaranteed outage: NextAuth trustHost is false under NODE_ENV=production, and the fix CI already proved is absent from prod config
*docker/docker-compose.prod.yml:13* — sweep confidence: confirmed

**Claim.** With NODE_ENV=production (Dockerfile:33) and only NEXTAUTH_URL set, @auth/core computes trustHost=false (it reads AUTH_URL, not NEXTAUTH_URL) and every Auth() call returns UntrustedHost — login, session, callback all fail. CI reproduced exactly this against `npm run start` and fixed it with AUTH_TRUST_HOST='true' in CI only; neither docker-compose.prod.yml, .env.example, nor deployment.md section 4 sets AUTH_TRUST_HOST or AUTH_URL, and lib/auth.ts sets no trustHost.

**Evidence.** node_modules/@auth/core/lib/utils/env.js:40: `config.trustHost ??= !!(envObject.AUTH_URL ?? AUTH_TRUST_HOST ?? VERCEL ?? CF_PAGES ?? NODE_ENV !== "production")`; assert.js:56-57: `if (!options.trustHost) return new UntrustedHost(...)`. next-auth/lib/env.js maps NEXTAUTH_URL only to basePath, never to AUTH_URL. .github/workflows/ci.yml:261-282: 'Reproduced live: a real `npm run build && npm run start` under this ... adding only AUTH_TRUST_HOST=true (no NEXTAUTH_URL) made the [failure disappear]' + `AUTH_TRUST_HOST: 'true'`. grep for trustHost in lib/ and app/: no hits.

**Impact.** Complete authentication outage on the VPS from the first request — the platform cannot be logged into at all. The knowledge to prevent it exists in the repo (CI comment) and never reached the production configuration; nothing in the deployment path tests a TLS/proxied production topology.

**Direction (not an implementation).** Set AUTH_TRUST_HOST=true (or trustHost:true in lib/auth.ts with a comment citing the CI reproduction) in the production environment, and add a deploy smoke test that performs a real login through nginx.

**Verification: CONFIRMED.** Every link verified in the installed packages (@auth/core 0.41.2 / next-auth 5.0.0-beta.31): env.js computes `config.trustHost ??= !!(AUTH_URL ?? AUTH_TRUST_HOST ?? VERCEL ?? CF_PAGES ?? NODE_ENV !== "production")` and next-auth/lib/env.js maps NEXTAUTH_URL only to secret/basePath, never to AUTH_URL — so with Dockerfile:33's NODE_ENV=production and compose passing only NEXTAUTH_URL, trustHost is false and assert.js:56-57 returns UntrustedHost on every Auth() call. My repo-wide grep for AUTH_TRUST_HOST outside ci.yml returned nothing, and lib/ and app/ contain no trustHost; ci.yml:261-284 records CI's own live reproduction (csrf → 500 UntrustedHost; adding only AUTH_TRUST_HOST=true → 200) with the fix applied in CI only. I could find no production-side escape hatch — no runtime env injection in next.config.ts, no trustHost in lib/auth.ts. Complete login outage on the documented deployment; Critical stands.

*Verifier evidence:* node_modules/@auth/core/lib/utils/env.js:40-44; node_modules/@auth/core/lib/utils/assert.js:56-57; node_modules/next-auth/lib/env.js (setEnvDefaults); docker/Dockerfile:33; grep -rn AUTH_TRUST_HOST (repo, excluding ci.yml) → no matches; .github/workflows/ci.yml:261-284

### DEP-04 [High] proxy.ts cannot see the session cookie behind TLS — every userId-keyed rate limit silently degrades to shared per-NAT-IP buckets in production
*proxy.ts:120* — sweep confidence: confirmed

**Claim.** getToken is called without secureCookie/cookieName, so it looks for `authjs.session-token`; in production over HTTPS @auth/core names the cookie `__Secure-authjs.session-token` (NEXTAUTH_URL is https), so token resolution returns null on every request — silently, since null is the legitimate no-cookie result. All keyBy:'userId' limits (default 60/min, DELETE /api/users/me at 1/hour, evidence uploads 10/min) fall back to IP keying, exactly the D-114-Finding-2 failure the comment above this line says was fixed.

**Evidence.** proxy.ts:120 `getToken({ req: request, secret: requireAuthSecret() })` — no secureCookie param. node_modules/@auth/core/jwt.js:86: `cookieName = defaultCookies(secureCookie ?? false).sessionToken.name`. node_modules/@auth/core/lib/utils/cookie.js: `const cookiePrefix = useSecureCookies ? "__Secure-" : ""`; lib/init.js:69 derives useSecureCookies from `url.protocol === "https:"`. e2e runs over http (playwright.config.ts:19 baseURL http://localhost:3000) so no test can catch this.

**Impact.** For the NAT'd classroom population this product explicitly targets (lib/rate-limit.ts:2-4 'designed for shared-IP classroom deployments'), a whole lab shares 60 req/min and one account-deletion per hour; page auth still works (layouts use auth(), which resolves cookies correctly), so the degradation is invisible until a class hits it. Structurally identical to the bug class this file already documents fixing once.

**Direction (not an implementation).** Pass secureCookie (derived from NEXTAUTH_URL protocol or x-forwarded-proto) or the explicit cookieName to getToken, and add a production-mode/TLS-shaped test for cookie-name resolution.

**Verification: CONFIRMED.** proxy.ts:120 calls `getToken({ req: request, secret: requireAuthSecret() })` with no secureCookie/cookieName; @auth/core/jwt.js getToken defaults `cookieName = defaultCookies(secureCookie ?? false).sessionToken.name` = 'authjs.session-token', while in production (NEXTAUTH_URL https) init.js:69 derives useSecureCookies from `url.protocol === "https:"` so the cookie is set as '__Secure-authjs.session-token' — getToken silently resolves null on every request. I attempted two kill-shots and both failed: next-auth/jwt.js is a bare `export * from "@auth/core/jwt"` (no env-derived secureCookie as in v4), and lib/auth.ts sets no custom cookies config. lib/rate-limit.ts:181 then keys every userId rule by IP, so the NAT'd classroom population the limiter is explicitly designed for (rate-limit.ts:2-4) shares the default 60/min and the 1/hour account-deletion bucket; playwright.config.ts:19 runs e2e over http so no test can see it. High stands: silent production degradation with concrete user impact for the exact target population.

*Verifier evidence:* proxy.ts:120; node_modules/@auth/core/jwt.js (getToken destructuring: `defaultCookies(secureCookie ?? false)`); node_modules/@auth/core/lib/utils/cookie.js:44-49; node_modules/@auth/core/lib/init.js:69; node_modules/next-auth/jwt.js; lib/rate-limit.ts:54,69-70,181; playwright.config.ts:19

### DEP-05 [High] No workable path to run migrations or seed in production: wrong container names, prisma/tsx absent from the runner image, seed's imports not shipped, DB unreachable from host
*docs/runbooks/deployment.md:204* — sweep confidence: confirmed

**Claim.** Runbook 6.3/6.4 (`docker exec nextjs npx prisma migrate deploy`, `docker exec nextjs npx prisma db seed`) fail on four independent grounds: (1) no container is named `nextjs`/`postgres` (compose project name is `docker`, so names are docker-nextjs-1/docker-postgres-1 — no container_name: set anywhere); (2) prisma and tsx are devDependencies not present in the runner image, so npx must network-fetch an unpinned prisma@latest at deploy time; (3) seed is structurally impossible in the image — prisma/seed.ts imports ../lib/data/identity and ../lib/data/preauth, and lib/ TS sources are never copied into the runner (Dockerfile copies only standalone, static, public, prisma/, node_modules/.prisma); (4) running from the host instead is also impossible — prod compose publishes no Postgres port.

**Evidence.** `docker compose -f docker/docker-compose.prod.yml config` → `name: docker`; scripts/provision-app-db-role.sh:38's own default is `docker exec -i docker-postgres-1 psql` (the real name). ls .next/standalone/node_modules: no prisma package, no .bin/prisma or .bin/tsx. prisma/seed.ts:5-6 `import { identityDb } from '../lib/data/identity'`. docker/Dockerfile:38-42 COPY list. docker-compose.prod.yml postgres service: no ports.

**Impact.** On the VPS, the operator cannot create the schema or the platform admin by any documented means; ADMIN_* env is additionally absent from the container (DEP-02). Migration-as-owner is the right role choice (DATABASE_URL = makrai), but there is no execution path for it. Every step after 'containers up' in the runbook is fiction.

**Direction (not an implementation).** Either ship a migration entry (prisma CLI pinned in the image, or a one-shot compose 'migrate' service using the builder stage), or document host-side execution with a real network path; replace seed-in-container with a compiled seed or run it via the builder image.

**Verification: CONFIRMED.** All four grounds verified independently: (1) my compose-config run shows project `name: docker` and the compose file sets no container_name, so `docker exec nextjs` (runbook 6.3/6.4) targets a container that does not exist — the provision script's own default (`docker exec -i docker-postgres-1`) confirms the real naming; (2) prisma and tsx are devDependencies only (package.json, verified via node) and my ls of .next/standalone/node_modules shows no prisma, no tsx, no .bin entries, so `npx prisma` inside the runner means a network fetch of unpinned prisma at deploy time; (3) prisma/seed.ts:5-6 imports ../lib/data/identity and ../lib/data/preauth, and Dockerfile:38-42 copies only public, standalone, static, prisma/ and node_modules/.prisma — no lib/ — so seed is structurally impossible in the image; (4) the postgres service publishes no ports, and the runbook installs no Node/npm on the VPS, so host-side execution is also closed. No documented path to schema or admin bootstrap; High stands.

*Verifier evidence:* docker compose config → `name: docker`; docker/docker-compose.prod.yml (no container_name, postgres has no ports:); node -e over package.json → prisma/tsx in devDependencies only; ls .next/standalone/node_modules → no prisma/tsx; prisma/seed.ts:5-6; docker/Dockerfile:38-42; scripts/provision-app-db-role.sh:39; docs/runbooks/deployment.md:204-210

### DEP-06 [High] makrai_app password provisioning is absent from the deployment sequence — the RLS role is left passwordless and the app cannot authenticate
*docs/runbooks/deployment.md:203* — sweep confidence: confirmed

**Claim.** Section 6 runs up → migrate → seed → verify and never runs db:provision, so makrai_app (created by migration with NO password, by design) has no password; scram auth over TCP fails for a passwordless role, so even a correctly-passed APP_DATABASE_URL cannot connect. The runbook's section-4 comment says to use 'the SAME secret you pass as APP_DB_PASSWORD to npm run db:provision' but the step never appears; `npm run db:provision` would also half-fail in prod (it provisions makrai_test, which won't exist) and requires Node/npm the runbook never installs on the VPS.

**Evidence.** deployment.md sections 6.1-6.5 (lines 178-224): no provision step. package.json:25 `db:provision: scripts/provision-app-db-role.sh makrai && scripts/provision-app-db-role.sh makrai_test`. D-076 register row's still-open half: 'assert in the deploy runbook that provisioning runs after every migrate deploy' — not done, while the same row was marked DOCS HALF FIXED for the .env text.

**Impact.** Tenant data access fails (loudly) even after DEP-01/02 are fixed. The risk is recorded (D-076) but the recorded fix trigger — 'first non-local deployment is prepared' — has now fired without the row being acted on.

**Direction (not an implementation).** Add an explicit provisioning step (prod-shaped: single database, PSQL_CMD documented for the prod container name) to section 6 between migrate and seed, and make the app's startup preflight distinguish 'role has no password' from other connection failures.

**Verification: CONFIRMED.** The migration creates the role with no password by design (`CREATE ROLE makrai_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`, migration 20260803062144:12), and I read runbook section 6 in full: the sequence is up → migrate → seed → verify with no db:provision step anywhere — section 4's comment references the script but nothing executes it. A passwordless role cannot pass the postgres image's default scram-sha-256 TCP auth, so even a correctly-injected APP_DATABASE_URL fails loudly. The half-fail claim also holds: package.json:25 provisions both makrai and makrai_test (the latter absent in prod), and the runbook installs no Node/npm on the VPS. The D-076 row confirms verbatim that 'assert in the deploy runbook that provisioning runs after every migrate deploy' is the still-open enforcement half and that its pick-up trigger is 'the first non-local deployment is prepared' — which the audit context says has now fired. High stands.

*Verifier evidence:* prisma/migrations/20260803062144_add_restricted_app_role/migration.sql:12; docs/runbooks/deployment.md:178-224 (sections 6.1-6.5, no provision step; :112-116 comment only); package.json:25; scripts/provision-app-db-role.sh:14-21,39; docs/DEFERRED_REGISTER.md:122 (D-076 row)

### DEP-07 [High] Security audit trail is ephemeral: stdout-only logging with no shipping, no rotation, and total loss on every redeploy
*lib/security-logger.ts:3* — sweep confidence: confirmed

**Claim.** All security events (AUTH_*, EVIDENCE_*, RATE_LIMIT_EXCEEDED, ADMIN_ACTION) go to stdout 'for Docker/ELK/CloudWatch consumption' — but no ELK/CloudWatch/shipping/rotation exists anywhere in compose, runbooks, or docs. Docker's default json-file driver is unbounded (no logging: options in compose, no daemon.json step in the runbook), and the runbook's own update procedure (`up -d --build`, section 8) recreates the container, which deletes the old container and its entire log file.

**Evidence.** lib/security-logger.ts:2-4 'Outputs JSON to stdout for Docker/ELK/CloudWatch consumption'; docker-compose.prod.yml has no logging: keys; deployment.md section 7 lists only UptimeRobot + manual docker stats; grep for log shipping/rotation across docker/ and docs/runbooks/: nothing.

**Impact.** For an RAI-governance platform whose product thesis is diagnosing documentation deficits, every deployment erases the security audit history, and between deployments logs grow unbounded on an 80GB disk shared with the database and backups. Incident investigation after any redeploy is impossible.

**Direction (not an implementation).** At minimum: json-file max-size/max-file options in compose plus a host-side persistence path (volume-mounted log file or journald/vector shipping), and state a retention policy.

**Verification: CONFIRMED.** lib/security-logger.ts:1-4 declares stdout-only output 'for Docker/ELK/CloudWatch consumption', and my greps found no logging: keys in either compose file and no rotation/shipping configuration (logrotate, max-size, journald, vector, fluent, loki, elk, cloudwatch) anywhere in docker/ or docs/runbooks/. The runbook's monitoring section (7) is UptimeRobot plus manual docker stats/df/htop, and its install path (get.docker.com, no daemon.json step) leaves Docker's default unbounded json-file driver; the update procedure (section 8, `up -d --build`) recreates the container, which deletes the prior container's log file and with it the entire security-event history. I looked for any host-side persistence path (volume-mounted log, syslog driver) and found none. For a governance platform whose audit trail is a product concern, losing all security events on every redeploy plus unbounded growth between them is a real operator-impact gap; High stands.

*Verifier evidence:* lib/security-logger.ts:1-4; grep -n logging docker/docker-compose.prod.yml docker/docker-compose.yml → no matches; grep -rniE 'logrotate|max-size|journald|vector|fluent|loki|elk|cloudwatch' docker/ docs/runbooks/ → empty; docs/runbooks/deployment.md:228-256,264-282

### DEP-08 [High] Backups: failures are structurally silent, storage is same-disk by default, restore has never been executed, and fresh-VPS restore loses the cluster-level app role
*docs/runbooks/backup-restore.md:61* — sweep confidence: confirmed

**Claim.** Four compounding problems: (1) the backup script's error-logging branches are dead code — `set -euo pipefail` (line 42) exits at the failed pipeline before either `if [ $? -eq 0 ]` check runs, so a failed backup writes NO log line, and with no MTA the cron failure alerts no one; (2) `docker exec postgres pg_dump` uses a container name that does not exist (docker-postgres-1 is real — see DEP-05), proving the script and the restore procedure have never been run; (3) off-site backup is an optional 'Recommended' section with placeholder destinations — the default is /backups on the same VPS disk as the data; (4) pg_dump of a single DB excludes cluster-level roles, so restore onto a fresh VPS has no makrai_app and the piped psql (no ON_ERROR_STOP) will 'complete' past failed GRANT/POLICY statements — this last chain is reasoned from Postgres semantics, not executed.

**Evidence.** backup-restore.md:42 `set -euo pipefail`; :58-66 pipeline then `if [ $? -eq 0 ] ... ERROR: Backup failed!` (unreachable); :58 `docker exec postgres pg_dump`; section 5 header 'Off-Site Backup (Recommended)' with example.com/your-bucket-name placeholders; restore section 4.3 pipes gunzip into psql without ON_ERROR_STOP and never runs role provisioning.

**Impact.** RPO is 24h (daily 03:00 dump) and is nowhere stated as an accepted decision; a disk failure loses data AND backups; a backup job that starts failing will be discovered only when a restore is needed; disaster recovery onto a new server fails in untested ways.

**Direction (not an implementation).** Fix the dead error branches (trap or explicit checks), add success/failure signaling (healthchecks.io ping or similar), make off-site sync part of the mandatory procedure, add pg_dumpall --globals-only (or a documented provision step) to the restore path, and perform one full restore drill before go-live.

**Verification: CONFIRMED.** All four legs verified in backup-restore.md: the script sets `set -euo pipefail` then follows both the pg_dump pipeline and `gunzip -t` with `if [ $? -eq 0 ]` blocks — under set -e a failed pipeline exits the script before either check, so the ERROR branches are dead code and a failing backup leaves only a 'Starting backup...' line with no alerting (cron mail requires an MTA the runbook never installs); the script says `docker exec postgres pg_dump` while the real container is docker-postgres-1 (per compose `name: docker` and the provision script's own default), so it has never successfully run as written; off-site backup is section 5 'Recommended' with placeholder destinations, leaving /backups on the same disk as the data by default; and the restore pipes gunzip into psql with no ON_ERROR_STOP and no globals/role provisioning step (grep for ON_ERROR_STOP/pg_dumpall/makrai_app in the file: absent from the restore path). The auditor honestly marked the fresh-VPS role-loss chain as reasoned from pg_dump semantics rather than executed, which is correct labeling. High stands.

*Verifier evidence:* docs/runbooks/backup-restore.md:42 (set -euo pipefail), :57-75 (pipeline + dead $? branches, `docker exec postgres`), :190-191 (gunzip | psql, no ON_ERROR_STOP), :222-227 (Off-Site 'Recommended'); grep -n 'ON_ERROR_STOP|pg_dumpall|makrai_app' backup-restore.md → none in restore path

### DEP-09 [Medium] No documented path for production invitation email to real university addresses
*docs/runbooks/deployment.md:121* — sweep confidence: confirmed

**Claim.** deployment.md section 4 sets RESEND_API_KEY but never EMAIL_FROM_ADDRESS, whose only documented value is Resend's shared testing sender onboarding@resend.dev — which .env.example itself says 'Delivers ONLY to the address that owns the API key'. No runbook step verifies a sending domain in Resend, and the DNS section (10) lists only A/AAAA records — no SPF/DKIM/return-path entries. Compose additionally passes neither var (DEP-02).

**Evidence.** .env.example:5-8: 'Resend's shared testing sender. Delivers ONLY to the address that owns the API key above, until a custom domain is verified'; deployment.md:104-125 env block lists RESEND_API_KEY but no EMAIL_FROM_ADDRESS; deployment.md:329-343 DNS table has only A/AAAA rows.

**Impact.** Invitations — the only multi-user onboarding path for a multi-tenant platform — cannot be delivered to any real colleague in production. Failure is loud (sendEmail throws, invite API 500s: good design), but the operator has no instruction that would ever make it work.

**Direction (not an implementation).** Add a runbook step: verify rai.air.ug (or air.ug) in Resend, add the SPF/DKIM records to the DNS section, set EMAIL_FROM_ADDRESS to the verified sender, and smoke-test one invite to an external mailbox post-deploy.

**Verification: OVERSTATED (severity corrected to Medium).** The documentation claims are all true — I verified deployment.md's env block (:104-125) lists RESEND_API_KEY but never EMAIL_FROM_ADDRESS, .env.example:5-8 documents the only known value (onboarding@resend.dev) as delivering solely to the API-key owner, and the DNS section (:329-343) has only A/AAAA rows with no SPF/DKIM or Resend domain-verification step. But the severity rests on a false impact chain: the invite API does not 500 — the EMAIL_FROM_ADDRESS/sendEmail throw is caught (members/route.ts:117-127) and the route returns 201 with the acceptUrl and emailSent:false, and MembersManager.tsx:222-228 explicitly renders 'Invitation created, but the email could not be sent... Share this one-time link directly instead' with the working link. So multi-user onboarding is not dead in production: the email transport is unconfigurable from the docs (real gap, fix needed before a polished pilot), but the product ships a designed, user-visible out-of-band fallback that keeps colleagues onboardable. That narrows 'the only multi-user onboarding path cannot be delivered' to 'the email leg fails visibly with an in-product workaround' — Medium, not High.

*Verifier evidence:* app/api/v1/orgs/[slug]/members/route.ts:105-141 (throw caught, 201 + acceptUrl + emailSent:false); app/(authenticated)/orgs/[slug]/settings/members/MembersManager.tsx:215-228 ('Share this one-time link directly instead'); .env.example:5-8; docs/runbooks/deployment.md:104-125,329-343

### DEP-10 [Medium] Runbooks have drifted from the system they describe and show no evidence of ever being executed
*docs/runbooks/deployment.md:4* — sweep confidence: confirmed

**Claim.** Beyond the blocking defects: wrong container names appear in all three runbooks (deployment.md, backup-restore.md, troubleshooting.md:98,134); deployment.md's header says 'Last updated: 2026-06-29' though git shows an edit on 2026-08-12 (commit 5337039); section 3 clones into /home/alvin/Downloads/MAK_RAI (the developer's laptop layout) on a fresh VPS with a YOUR_ORG placeholder URL; section 8 claims 'zero-downtime if no schema changes' though `up -d` recreates the container (seconds of downtime, and no health-gated cutover); the rollback procedure (git checkout <hash> → rebuild → restore backup) never warns that restoring the 03:00 backup discards everything since.

**Evidence.** deployment.md:4 'Last updated: 2026-06-29' vs `git log -- docs/runbooks/deployment.md` → 5337039 (2026-08-12 D-076 fix); :90-92 `cd /home/alvin/Downloads/MAK_RAI; git clone https://github.com/YOUR_ORG/toolkit-platform.git`; :270 'zero-downtime if no schema changes'; troubleshooting.md:98 `docker exec postgres pg_isready`.

**Impact.** An operator (including the author a month from now) following these documents hits confusing failures at nearly every step; trust in the runbooks collapses at first contact, which is when they are most needed.

**Direction (not an implementation).** Execute the runbook once end-to-end on a throwaway VM, correcting as you go; that single drill will catch every naming/path/ordering error at once.

### DEP-11 [Medium] Update procedure runs new code against the old schema; no health-gated deploy or migration-failure path in the deployment doc
*docs/runbooks/deployment.md:271* — sweep confidence: confirmed

**Claim.** Section 8 orders: build → `up -d` (new code serving) → `migrate deploy`. Any schema-dependent release errors for the window between cutover and migration; nothing gates nginx on app health (no nextjs healthcheck exists — compose nginx depends_on is implicit service_started), and deployment.md offers no guidance for a failed/partial migration (troubleshooting.md:333 covers some conflict cases).

**Evidence.** deployment.md:264-276 sequence; docker-compose.prod.yml nextjs service has no healthcheck; nginx service `depends_on: - nextjs` (short form).

**Impact.** Real releases with migrations produce a user-visible error window sized by operator speed; a failed migration mid-deploy leaves new code + old schema with no documented recovery beyond full restore (which loses the day's data).

**Direction (not an implementation).** Reorder to migrate-then-cutover for additive migrations (the expand/contract pattern), add a container healthcheck, and document `prisma migrate resolve` handling in the deployment doc itself.

### DEP-12 [Medium] D-018's trigger has fired (VPS procured) but the register still says PARKED — and its gated queue includes a known day-one classroom login lockout
*docs/DEFERRED_REGISTER.md:64* — sweep confidence: confirmed

**Claim.** D-018 (hosting model) lists its own pick-up trigger as 'Raised by the user, or first deploy need' — that has now fired, yet the row is Open/PARKED and the risks gated on it are unworked: D-199/D-124/D-125 (trusted-proxy allowlist — whose stated blocker 'no topology to trust it against' is dissolved by the repo's own docker/nginx/default.conf, which already defines the topology and appends client XFF via $proxy_add_x_forwarded_for, so proxy.ts:68's split(',')[0] stays spoofable straight through nginx), D-076 (password enforcement), D-046 (in-memory limiter), D-107 (unbounded org creation). Most concretely: D-124's login cap — POST:/api/auth at 15 attempts/15min per IP (lib/rate-limit.ts:53) — will lock out the NAT'd classroom population on day one, while registration was raised to 50 on exactly that population's reasoning (D-195) and login was never revisited (nginx's own auth zone, 30r/m, doesn't change the app-level 15/15min bound).

**Evidence.** DEFERRED_REGISTER.md:64 (D-018 row, trigger text, status Open); D-199 row: 'cannot be written without knowing whether this app sits behind a real reverse proxy' — docker/nginx/default.conf:66 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for` (append, client value first); lib/rate-limit.ts:53 `'POST:/api/auth': { window: 15*60*1000, max: 15, keyBy: 'ip' }` vs :52 register max 50 with the D-195 NAT derivation.

**Impact.** Deploying next month without processing this queue ships known-open adversarial gaps and a predictable usability failure (a 40-person lab gets 15 login attempts per 15 minutes) that the project's own register already predicted.

**Direction (not an implementation).** Un-park D-018 now that hosting is decided, and work D-199/D-124/D-076/D-046 as one topology-informed batch before go-live; align the login cap with the registration derivation.

### DEP-13 [Medium] nginx config quality: max-size legal uploads 413 at nginx, unconditional Connection: upgrade, duplicated security headers, no timeouts or static caching
*docker/nginx/default.conf:56* — sweep confidence: confirmed

**Claim.** client_max_body_size 10m equals the app's MAX_BYTES (both 10485760), but evidence uploads are multipart (route reads req.formData()), so any legal file within a few hundred bytes of the 10MiB cap exceeds the nginx limit with the boundary overhead and dies as an nginx-branded 413 the app never sees. Also: `proxy_set_header Connection "upgrade"` is set unconditionally on the catch-all location (no $http_upgrade map), the standard misconfiguration; X-Frame-Options/X-Content-Type-Options/Referrer-Policy are set by BOTH nginx (add_header) and next.config.ts headers() so responses carry duplicates; no proxy_read_timeout, no HTTP/2, no caching for /_next/static; an HMR comment reveals the config was written for dev.

**Evidence.** default.conf:56 `client_max_body_size 10m`; lib/evidence/inspect.ts:10 `MAX_BYTES = 10 * 1024 * 1024`; evidence route.ts:101 `await req.formData()`; default.conf:91-92 unconditional Upgrade/Connection; default.conf:34-38 vs next.config.ts:48-60 header overlap.

**Impact.** Users uploading files near the documented 10MiB limit get an unstyled nginx error instead of the app's JSON 413; upstream keep-alive is disabled; header duplication is untidy and can confuse scanners.

**Direction (not an implementation).** Set nginx's limit a margin above the app's (e.g. 11m) so the app's own 413 path owns the boundary; use the standard $http_upgrade map; pick one owner per security header.

### DEP-14 [Medium] Monitoring is an external ping plus manual commands — no disk, error-rate, or backup alerting for a box that will fill its own disk
*docs/runbooks/deployment.md:228* — sweep confidence: confirmed

**Claim.** The entire monitoring story is UptimeRobot HTTP checks and ad-hoc `docker stats`/`df -h`/`htop`. Nothing watches disk (80GB shared by pg data with evidence blobs up to 10MiB/file, docker images rebuilt on every deploy, unbounded container logs, and 30 daily backups), nothing watches application errors or the security-event stream, nothing verifies backups succeeded, and there is no /api/health endpoint (find app -path '*health*' returns nothing) so even UptimeRobot can only assert the homepage renders.

**Evidence.** deployment.md:228-256 (section 7 in full); find over app/ for a health route: no results; troubleshooting.md section 5 exists for 'Disk Full' — reactive, no alert precedes it.

**Impact.** The first signal of disk exhaustion, backup failure, or an error storm will be a user report or an outage; on a single VPS every failure domain is coupled.

**Direction (not an implementation).** Add a /api/health endpoint (DB-touch), point UptimeRobot at it, add node-exporter-level basics or even a cron that alerts on df thresholds and backup-log staleness.

### DEP-15 [Low] Compose/Docker hygiene: obsolete version key, unpinned images, no healthcheck or resource limits, dead deps build stage
*docker/docker-compose.prod.yml:4* — sweep confidence: confirmed

**Claim.** `version: '3.8'` draws a deprecation warning; postgres:16-alpine and nginx:alpine float (restore requires dump-version compatibility; a silent minor/major bump on rebuild changes the DB under you); the nextjs service has no healthcheck and no resource limits (troubleshooting.md proposes adding limits reactively after an OOM); Dockerfile's `deps` stage (npm ci --only=production) is never COPY'd from — pure wasted build time; postgres runs with stock tuning on an 8GB host, a choice recorded nowhere.

**Evidence.** compose config output: 'the attribute `version` is obsolete'; Dockerfile:15-18 deps stage vs :38-42 runner COPY list (only builder referenced); docker-compose.prod.yml:21 `image: postgres:16-alpine` (no digest/minor pin).

**Impact.** Slow builds on a small VPS, drift risk on rebuild, and no early failure detection — individually minor, collectively the texture of infrastructure that was scaffolded once and never revisited.

**Direction (not an implementation).** Drop the version key and dead stage, pin images at least to minor (postgres:16.x-alpine), add a healthcheck, and record the tuning decision even if the decision is 'defaults are fine for the pilot'.

**Not examined by this auditor:**
- Actually building the Docker image and running the prod compose stack — Read-only audit on a dev machine with no deploy target; the standalone contents of the last local build were inspected instead, which confirms the runner-image composition claims but not runtime behavior like npx-download-as-nextjs-user (whether alpine adduser --system creates a writable HOME for the npm cache is unverified)
- A live restore drill of the backup procedure — Would require executing destructive commands against a database; the fresh-VPS role-restore failure chain in DEP-08 is reasoned from Postgres semantics (pg_dump excludes cluster roles) rather than executed, and is marked accordingly
- External account state: the actual VPS, DNS zone for rai.air.ug, and the Resend account/domain verification status — Not represented in the repository; findings are scoped to what the repo and runbooks would produce
- Live TLS reproduction of DEP-03/DEP-04 (UntrustedHost and __Secure- cookie mismatch) — No TLS deployment exists to test against; both are confirmed at source level end-to-end (every link in each mechanism read in node_modules and app code), and DEP-03 additionally has CI's own recorded live reproduction
- CI pipeline depth, pen-test.mjs, e2e suite internals, and the RLS/tenancy design itself — Other auditors' dimensions; touched only where they intersected deployment (CI's AUTH_TRUST_HOST, playwright webServer)
- Postgres performance tuning adequacy for the CX32 under real load — No load profile exists to judge against; flagged only that the default-tuning decision is unrecorded (DEP-15)

## docs-accuracy

The inner record (ADRs, DEFERRED_REGISTER, specs) is exceptionally rigorous and mostly matches the code, but the outer record — the documents a newcomer or operator would actually reach first — is badly out of truth. The README is untouched create-next-app boilerplate; the deployment and backup runbooks describe a procedure that demonstrably cannot produce or restore a working system under the RLS role architecture the platform now depends on; and there is no index or status document, so the project's real state (plans 1a–1d executed, Phase 1d-ii next, a pending collaboration-model fork) is reconstructible only from register rows and git log. Several specific ADR claims have drifted from code without amendment (dead module path, 404-vs-403 wording, a 'required' memoisation that was never built), a class of rot the project itself diagnosed (D-100/D-132) but whose mechanism was never shipped.

**Sound (what is genuinely good):**
- The three ADRs are evidence-backed to an unusual degree: claims cite commands, library source lines, and live spikes; ADR-0002's iat correction and ADR-0003's F5 amendment show the record being repaired honestly and in the right way (mechanism corrected, decision preserved, rename table included).
- docs/DEFERRED_REGISTER.md is a genuinely rigorous audit trail — closures carry commit hashes and state what was and was not verified live; D-210 preserved the collaboration-model proposal and its measured evidence before it could be lost to compaction.
- docs/superpowers/{plans,specs,spikes} are committed (verified via git ls-files), so ADR references like the RLS spike resolve for anyone who clones.
- The project self-identified the exact defect class this audit keeps finding — dangling cross-document references invisible to tsc/ESLint/tests (D-100) — and correctly spun the missing mechanism into its own row (D-132) rather than closing it silently.
- ADR-0003's claimed doc-comment corrections were real: lib/data/framework.ts's getPinnedVersion comment now accurately describes both load-bearing reads (verified at lib/data/framework.ts:11-19).
- Verified-current ADR-0002 mechanisms all hold in code: token carries only id/sessionEpoch/sessionIssuedAt (lib/auth.ts:124-150), maxAge 12h (lib/auth.ts:158), invitation tokens sha256-hashed with a CHECK constraint (lib/data/invitationToken.ts:18, lib/data/members.ts:47), eslint auth-import and createOrgContext bans present (eslint.config.mjs:58-60,78).

### DOC-01 [High] README is untouched create-next-app boilerplate — the repo's front door describes a different project
*README.md:7* — sweep confidence: confirmed

**Claim.** README.md has not been edited since the initial commit and contains only stock Next.js starter text; it tells a new engineer that `npm run dev` is all that is needed and suggests deploying on Vercel, while the real project requires .env setup (.env.example exists but is never mentioned), `npm run docker:up`, `db:migrate`, `db:provision`, and seed, and its runbooks target a self-hosted Hetzner/Docker deployment.

**Evidence.** README.md:7-15 ('First, run the development server: npm run dev'); README.md:32-34 ('Deploy on Vercel'); `git log -1 -- README.md` → `0da64e3 2026-06-29 Initial commit from Create Next App`; package.json scripts show the actual bootstrap chain (docker:up, db:provision, db:migrate, db:seed).

**Impact.** A competent engineer cloning today believes this is a fresh starter, runs `npm run dev` against no database and no env, and gets failures the README gives no path out of; none of the project's actual documentation (AGENTS.md, docs/, ADRs) is referenced from the front door.

**Direction (not an implementation).** Replace with a project README: what the platform is, prerequisite services, the exact bootstrap command chain, pointer to docs/ entry points and AGENTS.md.

**Verification: CONFIRMED.** README.md is verbatim create-next-app boilerplate with exactly one commit in its history, telling a newcomer 'npm run dev' suffices and to deploy on Vercel, while the real platform needs .env setup, docker:up, db:migrate, db:provision and seed, and targets self-hosted Docker/Hetzner. I tried to refute the severity by finding an alternate onboarding doc: grep for the bootstrap commands over docs/ hits only the production runbook, a plan file, and the register — no local-dev setup document exists anywhere, and README never mentions .env.example. High stands: the repo's only entry-point document describes a different project and there is no written path to a running dev environment.

*Verifier evidence:* README.md:5-8,32-34 (stock 'npm run dev' / 'Deploy on Vercel' text); `git log --follow -- README.md` → single commit 0da64e3 'Initial commit from Create Next App'; package.json scripts (docker:up, db:provision, db:migrate, db:seed); `grep -rln 'db:provision\|docker:up' docs/ README.md` → only docs/runbooks/deployment.md, docs/superpowers/plans/2026-08-02-phase1a-isolation-spine.md, docs/DEFERRED_REGISTER.md

### DOC-02 [High] Deployment runbook's procedure cannot produce a working deployment — makrai_app is never provisioned and APP_DATABASE_URL never reaches the container
*docs/runbooks/deployment.md:178* — sweep confidence: probable

**Claim.** Followed literally, §6 (First Deployment) yields a system whose entire tenant-data lane fails: the procedure never runs scripts/provision-app-db-role.sh (the migration deliberately creates makrai_app with NO password), and docker-compose.prod.yml forwards only DATABASE_URL/NEXTAUTH_SECRET/NEXTAUTH_URL to the app container, so APP_DATABASE_URL — which §4 tells the operator to put in .env — never reaches the app, and connection.ts throws on every tenant access. Additionally §6.3/6.4's `docker exec nextjs …` and backup's `docker exec postgres …` target container names that do not exist under this compose file (no container_name directives; compose names them docker-nextjs-1 etc., corroborated by scripts/provision-app-db-role.sh's own reference to 'docker-postgres-1'). The runbook's §6.5 'Open https://rai.air.ug … and log in' is asserted, evidently never executed.

**Evidence.** deployment.md:178-224 (procedure has no provision step; only mention of provisioning is a comment at :115); docker/docker-compose.prod.yml:11-14 (environment: only DATABASE_URL, NEXTAUTH_SECRET, NEXTAUTH_URL); prisma/migrations/20260803062144_add_restricted_app_role/migration.sql:6-8 ('NO PASSWORD IS SET HERE… provisioned per environment by scripts/provision-app-db-role.sh'); lib/data/connection.ts:23-29 (throws when APP_DATABASE_URL unset).

**Impact.** An operator performing the documented deployment gets a fail-closed outage of all tenant data access with no runbook path to diagnose it; the 2026-08-12 D-076 fix added the env-var text but not the provisioning step or the compose forwarding, so the doc still asserts a procedure that fails.

**Direction (not an implementation).** Add an explicit provision step (APP_DB_PASSWORD + PSQL_CMD override for prod), fix the exec commands to `docker compose -f … exec`, and actually execute the runbook once end-to-end before asserting §6.5.

**Verification: CONFIRMED (severity corrected to High).** Every link the auditor derived is verified, and I reproduced the two derivable ones with the real docker compose binary: the resolved prod config shows project name 'docker' (so §6.3/6.4's `docker exec nextjs` targets a container that does not exist — actual name docker-nextjs-1) and exactly three env keys reaching the app (DATABASE_URL, NEXTAUTH_SECRET, NEXTAUTH_URL — no APP_DATABASE_URL). §6 has no provisioning step (only a §4 comment at line 115 mentions db:provision), the migration deliberately creates makrai_app with no password, and connection.ts throws on unset APP_DATABASE_URL, so the tenant lane fails closed. Refutation attempts failed: no env_file, no Dockerfile ENV, .dockerignore excludes .env from the build context and postbuild deletes .next/standalone/.env*; the .env.example provisioning breadcrumb is inert because the runbook's server setup installs Docker only, never node/npm. The register's own D-076 row corroborates the gap and its open trigger still says the runbook must one day 'assert provisioning runs after every migrate deploy'. The auditor's 'probable' hedge (no VPS reproduction) is resolved by these local reproductions: the procedure as written cannot work.

*Verifier evidence:* docs/runbooks/deployment.md:178-224 (§6 has no provision step; §4:115 only comment); `docker compose -f docker/docker-compose.prod.yml config --format json` → name 'docker', nextjs env = ['DATABASE_URL','NEXTAUTH_SECRET','NEXTAUTH_URL']; prisma/migrations/20260803062144_add_restricted_app_role/migration.sql:6-12 (no password set); lib/data/connection.ts:23-31 (throws on unset APP_DATABASE_URL); docs/DEFERRED_REGISTER.md:122 (D-076: 'nothing runs the script automatically... LOGIN role with no password set at all'); `grep -in 'npm' docs/runbooks/deployment.md` → only line 115 (no node/npm install on the host)

### DOC-03 [High] Backup/restore runbook predates the RLS role architecture — a disaster restore following it loses the role the isolation design depends on
*docs/runbooks/backup-restore.md:58* — sweep confidence: confirmed

**Claim.** Backups are single-database `pg_dump` and restore is `psql` of that dump; pg_dump does not include cluster-level roles, so on a fresh host makrai_app does not exist — the dump's GRANTs referencing it fail, and nothing in the runbook mentions roles, provisioning, or the RLS architecture at all (grep for 'role|makrai_app' over the file matches nothing). The runbook has not been revised since 2026-06-29, five weeks before RLS/role separation was built.

**Evidence.** backup-restore.md:58 (`docker exec postgres pg_dump -U "${POSTGRES_USER}" "${POSTGRES_DB}"`), :191 (restore pipes into psql of the single DB); grep -n 'role|makrai_app' over the file returns no role-handling lines; header 'Last updated: 2026-06-29'; makrai_app is created only by migration 20260803062144 and passworded only by scripts/provision-app-db-role.sh.

**Impact.** The documented disaster-recovery path, executed after a real loss, produces a database missing the restricted role and its grants — at best a total fail-closed outage of tenant data, at worst an operator 'fixing' it by pointing APP_DATABASE_URL at the superuser, which silently disables tenant isolation (the exact fail-open ADR-0001 exists to prevent).

**Direction (not an implementation).** Rewrite restore to include role recreation (`pg_dumpall --roles-only` or migrate deploy + provision script) and test one full restore; note the RLS dependency prominently.

**Verification: CONFIRMED.** Verified with direct evidence beyond the auditor's: a live pg_dump of the dev database contains dozens of 'GRANT ... TO makrai_app' statements and zero 'CREATE ROLE' statements, so a fresh-host restore errors on every grant while the role itself never exists; §4.4's `migrate deploy` cannot recreate it because the restored _prisma_migrations marks the role-creating migration as applied. The runbook, read end-to-end, contains no mention of roles, makrai_app, provisioning, or RLS, and git history confirms it was written 2026-06-29 and touched only by a 2026-08-01 path-rename — both before the 2026-08-03 role architecture. Refutation attempts failed: the same-host §4 restore does keep cluster roles, but §5 explicitly frames the runbook's purpose as surviving VPS disk failure, i.e. the fresh-host path is in-scope and is exactly the one that loses the role; no other doc or register row covers restore-with-roles; additionally the backup script's `docker exec postgres` does not even resolve under the prod compose (containers are docker-postgres-1). The fail-open operator temptation is real — .env.example hands over the owner credential.

*Verifier evidence:* docs/runbooks/backup-restore.md:58,131,190-191 (single-db pg_dump / psql restore), full read shows zero role/RLS mentions; `docker exec -i docker-postgres-1 pg_dump -U makrai makrai | grep makrai_app` → GRANT USAGE ON SCHEMA public TO makrai_app + per-table grants; same dump `grep -c 'CREATE ROLE'` → 0; `git log --format='%h %ad %s' -- docs/runbooks/backup-restore.md` → ed56e04 2026-06-29 create, 5e8a4f7 2026-08-01 path-rename only (6 lines)

### DOC-13 [High] docker-compose.prod.yml forwards no APP_DATABASE_URL (nor RESEND/ADMIN seed vars) to the app container
*docker/docker-compose.prod.yml:11* — sweep confidence: confirmed

**Claim.** Beyond the runbook problem (DOC-02): the production compose file itself only passes DATABASE_URL, NEXTAUTH_SECRET and NEXTAUTH_URL into the nextjs service, so the restricted-role connection string the whole RLS design runs on can never reach the production app, and the seed's ADMIN_*/RESEND vars are likewise absent. This is an infrastructure defect independent of documentation: production as configured cannot serve any tenant data (fail-closed via lib/data/connection.ts).

**Evidence.** docker/docker-compose.prod.yml:11-14 (environment block lists exactly three vars); lib/data/connection.ts:23-29 throws when APP_DATABASE_URL is unset; docs/runbooks/deployment.md:116 instructs setting APP_DATABASE_URL in .env, which compose never forwards to the container.

**Impact.** First real production deployment fails closed on all tenant routes; the likely operator remedy under pressure (point the app at DATABASE_URL/superuser) would disable tenant isolation entirely — the exact fail-open D-076/ADR-0001 warn about.

**Direction (not an implementation).** Add APP_DATABASE_URL (and seed-time vars) to the compose environment/env_file, and cover prod compose in whatever config-completeness test exists.

**Verification: CONFIRMED.** The prod compose file's environment block passes exactly DATABASE_URL, NEXTAUTH_SECRET and NEXTAUTH_URL — confirmed both by reading the file and by resolving it with `docker compose config`. I hunted for any other route by which APP_DATABASE_URL could reach the container and found none: no env_file directive, no ENV in docker/Dockerfile, .dockerignore excludes .env from the build context, and package.json's postbuild deletes .next/standalone/.env*. connection.ts:23-31 then throws at first tenant access, a fail-closed outage of the entire tenant lane; seed.ts reads ADMIN_EMAIL/ADMIN_PASSWORD from env vars that likewise never arrive. No test covers the prod compose and no register row records this forwarding gap, so it is a genuinely unrecorded infrastructure defect. High (not Critical) is correct: it fails closed rather than breaking tenancy, and no production deployment yet exists (D-018 hosting is still parked), so the impact lands at the first real deploy.

*Verifier evidence:* docker/docker-compose.prod.yml:11-14; `docker compose -f docker/docker-compose.prod.yml config --format json` → nextjs env keys exactly ['DATABASE_URL','NEXTAUTH_SECRET','NEXTAUTH_URL']; docker/Dockerfile (no ENV for app vars); .dockerignore ('.env', '.env.*' excluded); lib/data/connection.ts:23-31 (throw on unset APP_DATABASE_URL); prisma/seed.ts:40,97 (reads ADMIN_PASSWORD/ADMIN_EMAIL from process.env); `grep -rln 'docker-compose.prod' __tests__/` → no matches; `grep -n 'docker-compose.prod\|container_name' docs/DEFERRED_REGISTER.md` → only incidental mentions in D-146/D-149

### DOC-04 [Medium] ADR-0002 is implemented and load-bearing but still marked 'Proposed' — a gap the register has known about since 2026-08-05
*docs/adr/0002-identity-and-account-linking.md:3* — sweep confidence: confirmed

**Claim.** Both the ADR file and the index list ADR-0002 as Proposed, while its decisions (sessionEpoch revocation, 12h/7d session caps, hashed invitations, branded OrgContext) are shipped and tested. D-066's closure note explicitly recorded this exact gap on 2026-08-05 ('the index's status word was never flipped') — twelve days later it is still unflipped, and no register row was ever opened for it despite the project's own rule 6.

**Evidence.** 0002-identity-and-account-linking.md:3 ('**Status:** Proposed'); docs/adr/README.md:37 (index row 'Proposed'); docs/DEFERRED_REGISTER.md:112 (D-066 closure: 'still lists ADR-0002's status as `Proposed`, not `Accepted` — a separate, narrower documentation gap'); implementation verified in lib/auth.ts:124-158 and lib/data/invitationToken.ts:18.

**Impact.** A newcomer resolving conflicts between records by ADR status (as the ADR README teaches) treats the implemented identity model as tentative — and in the DOC-06 contradiction would side with the wrong document.

**Direction (not an implementation).** Flip status to Accepted in file and index; open the register row the D-066 note implied.

### DOC-05 [Medium] ADR-0001's layer diagram names lib/data/context.ts, which does not exist — the context layer lives at lib/auth/context.ts
*docs/adr/0001-data-access-architecture.md:71* — sweep confidence: confirmed

**Claim.** The Accepted architecture ADR's central diagram routes 'Context / authorization requireOrgContext(slug, action)' to `lib/data/context.ts`; no such file exists (ls lib/data/ has no context.ts) and the function lives in lib/auth/context.ts. The ADR was never amended. This is precisely the dangling-reference class D-100 named, whose mechanism (a docs link/reference checker, D-132) remains unbuilt and was re-targeted twice.

**Evidence.** 0001-data-access-architecture.md:71 ('requireOrgContext(slug, action)             lib/data/context.ts'); `ls lib/data/` shows no context.ts; lib/auth/context.ts:82 defines requireOrgContext; docs/DEFERRED_REGISTER.md:180 (D-132 'still returns nothing. Not addressed').

**Impact.** A reader following the primary architecture document to the authorization choke point lands on a missing file; trust in the diagram's other paths degrades, and the unbuilt D-132 mechanism means nothing will catch the next instance either.

**Direction (not an implementation).** Amend ADR-0001 with a dated location correction (the ADR README's supersede rule covers decisions, not file paths), and build the D-132 checker extended to code-path references.

### DOC-06 [Medium] ADR-0001 says 'never 403'; ADR-0002 and the shipped code return 403 for a member lacking the action — ADR-0001 unamended
*docs/adr/0001-data-access-architecture.md:96* — sweep confidence: confirmed

**Claim.** ADR-0001 decision 3 states 'Unauthorised access to an existing resource returns **404**, never 403'. ADR-0002 decision 10 refines this into a three-answer table where 'Member, but role lacks the action → 403', and the code implements 0002: requireOrgContextFor throws ForbiddenError for an authorized member without the permission, mapped to 403. The Accepted ADR and the Proposed ADR literally contradict, and code comments have quietly re-scoped 0001's claim to 'never 403 for a non-member'.

**Evidence.** 0001:96 ('returns **404**, never 403'); 0002 decision-10 table ('Member, but role lacks the action | **403**'); lib/auth/context.ts:64 (`if (!can(membership.role, action)) throw new ForbiddenError(...)`) and :59 (comment re-reads it as 'ADR-0001: never 403 for a non-member'); lib/http/toResponse.ts:38-40 (ForbiddenError → 403).

**Impact.** A reader taking the Accepted ADR at its word believes all denials are 404s — wrong for API behavior, wrong for any client handling, and the status hierarchy (Accepted vs Proposed) points them at the incorrect document.

**Direction (not an implementation).** Amend ADR-0001's wording to the non-member scope (a precision fix, not a decision change), or note the refinement with a pointer to 0002 §10.

### DOC-07 [Medium] ADR-0002 declares within-request cache() memoisation 'required'; it was never built, the code asserts the opposite, and the register treats it as deferred
*docs/adr/0002-identity-and-account-linking.md:187* — sweep confidence: confirmed

**Claim.** ADR-0002 decision 5 ends: 'Memoisation **within** a request (`cache()`) is required — see Consequences for why.' No cache() call exists anywhere in lib/ or app/ (grep returns nothing); lib/auth/context.ts's own doc comment says 'no memoization, nothing carried across requests'; and register row D-099 treats per-request memoisation as a *future sanctioned response* to a load trigger that has not fired. The ADR states as a requirement what the rest of the record treats as deferred, and was never amended.

**Evidence.** 0002:187-188 ('Memoisation **within** a request (`cache()`) is required'); `grep -rn "cache(" lib/` and import-grep over lib/+app/ → no matches; lib/auth/context.ts:22-23 ('this function is written the same way — no memoization'); docs/DEFERRED_REGISTER.md:145 (D-099: 'Sanctioned responses in order: per-request memoisation (`cache()`), then pool sizing').

**Impact.** An implementer following ADR-0002 §5 adds memoisation believing it mandated (touching the identity-freshness path where getting the cache scope wrong has security consequences); alternatively a reviewer flags the codebase as non-compliant with its own accepted design. Either way the record misleads.

**Direction (not an implementation).** Amend §5 to state memoisation is permitted-when-triggered per D-099, or implement it deliberately; either way make the three records agree.

### DOC-08 [Medium] Legacy audit docs carry no historical/superseded markers and their headline claims are verifiably no longer true
*docs/ui-ux-audit.md:21* — sweep confidence: confirmed

**Claim.** ui-ux-audit.md (2026-07-02) leads with criticals — 'Sidebar has zero CSS styles', 'Auth pages have zero CSS styles' — that are fixed (globals.css now contains 23 `sidebar-` and 19 `auth-` rule matches), with no resolution note. verification-bugs.md's rows were 'STALE ON ENTRY' per the register's own audit (D-021). audit-phase1-phase5-findings.md's title 'Phase 1 & Phase 5 Findings' collides with the project's Phase 0–4 plan naming though it is a UI audit's internal phases. PHASE_1_FOUNDATION_DESIGN.superseded.md is marked superseded only in its filename — the header still reads 'Draft for sign-off (v0.1)' with no pointer to what superseded it (ADR-0001 supersedes a different spec file's sections). Only security-correctness-audit-2026-07.md is self-contained ('All of these are now fixed').

**Evidence.** ui-ux-audit.md:21-24 ('Sidebar has zero CSS styles… Auth pages have zero CSS styles'); `grep -c "sidebar-" app/globals.css` → 23, `grep -c "auth-" app/globals.css` → 19; DEFERRED_REGISTER.md:67 (D-021 'STALE ON ENTRY… Transcribed from PHASE_0_FINDINGS without checking'); PHASE_1_FOUNDATION_DESIGN.superseded.md:3 ('**Status:** Draft for sign-off (v0.1)').

**Impact.** A newcomer reading the docs/ directory top-down believes the UI has unstyled criticals, that two critical 404 bugs are open, and may conflate a UI-audit 'Phase 1' with the tenancy Phase 1 — all false beliefs the doc set actively creates.

**Direction (not an implementation).** Add a dated HISTORICAL banner to each legacy doc stating what it described, what has since changed, and where the living record is; fix the superseded design doc's own header.

### DOC-09 [Medium] No doc index or status record: the plan of record stops in early August, and current project state is reconstructible only from register rows, planning files, and git log
*docs/VISION_AND_PLAN.md:3* — sweep confidence: confirmed

**Claim.** VISION_AND_PLAN.md — the document AGENTS.md names as plan of record and session-start reading — is 'Draft for review (v0.1)', last touched 2026-08-02, and knows nothing of the executed sub-phases (Plans 1a/1b/1c/1d-i live only in docs/superpowers/plans/ and the register), the two rollbacks, or the pending Phase 1d-ii. docs/ has no index (no docs/README.md). The collaboration-model proposal — a live architectural fork blocking design — is reachable only via register row D-210 or directory browsing; nothing in AGENTS.md, VISION_AND_PLAN, or any ADR points at docs/planning/. AGENTS.md's session-start list (VISION + SKILLS_INVENTORY) omits the register, the ADRs, and planning/, though those hold the actual live state.

**Evidence.** VISION_AND_PLAN.md:3 ('Status: Draft for review (v0.1) · Last updated: 2026-07-19'); `git log -1 -- docs/VISION_AND_PLAN.md` → 2026-08-02; grep 'collaboration' docs/VISION_AND_PLAN.md → no match; citation search: collaboration-model-proposal.md is cited only by DEFERRED_REGISTER.md (D-210, line 259); `ls docs/` shows no index file; AGENTS.md header ('Plan of record: docs/VISION_AND_PLAN.md… Read both at the start of a work session').

**Impact.** A newcomer (human or agent) doing exactly what AGENTS.md instructs reads a plan that ended before most of the work happened and never encounters the proposal that will reshape the role model; load-bearing state exists only in a 379-line register and conversation-preserving planning files they are never directed to.

**Direction (not an implementation).** Add a short docs/README.md entry map (living docs vs historical, current phase, where state lives) and a status/phase-log section to VISION_AND_PLAN or a successor; add the register and planning/ to the session-start list.

### DOC-10 [Low] 'Last updated' headers are stale on exactly the docs that were updated
*docs/runbooks/deployment.md:4* — sweep confidence: confirmed

**Claim.** deployment.md's header says 'Last updated: 2026-06-29' but the file was edited 2026-08-12 (the D-076 fix, which itself cites an August register row inside a file claiming a June date); VISION_AND_PLAN.md says 'Last updated: 2026-07-19' but was edited 2026-08-02. The freshness metadata a reader would use to judge trustworthiness is wrong in both directions.

**Evidence.** deployment.md:4 ('Last updated: 2026-06-29') vs `git log` → `5337039 2026-08-12 fix(docs): D-076…`; VISION_AND_PLAN.md:3 ('Last updated: 2026-07-19') vs `git log` → `9e39878 2026-08-02`.

**Impact.** Readers discount the runbook's genuinely current APP_DATABASE_URL warning as pre-architecture content, or trust the vision doc as fresher than it is; hand-maintained dates that drift are worse than none.

**Direction (not an implementation).** Update the headers when editing, or drop hand-written dates in favor of git history.

### DOC-11 [Low] Stale identifiers survive in the exact comments written as corrections: schema.prisma cites a deleted function; the registry migration still carries the claim ADR-0003 declares false
*prisma/schema.prisma:190* — sweep confidence: confirmed

**Claim.** The FrameworkVersion doc comment — added as the correction ADR-0003 describes — cites `getCurrentVersionId`, which ADR-0003's own F5 amendment says was renamed to `resolveCurrentFramework` with 'old names deleted, not aliased' (the name now exists only in comments). Separately, migration 20260807102031:27-31 still asserts 'SELECT is granted for exactly one reason… if the display requirement ever goes away, this grant goes too' — the precise claim ADR-0003 flags as having become false; the ADR's correction sweep named schema.prisma and framework.ts but never acknowledged the migration comment (immutable by convention, but the ADR doesn't say so).

**Evidence.** prisma/schema.prisma:190 ('(`getCurrentVersionId`, closing D-143)'); grep shows getCurrentVersionId exists only in comments; ADR-0003 amendment table ('old names are **deleted, not aliased**'); prisma/migrations/20260807102031_framework_registry_and_pin/migration.sql:27-31 ('if the display requirement ever goes away, this grant goes too').

**Impact.** A reader greps for getCurrentVersionId and finds nothing runnable; a reader of the migration learns a revocation condition that is false — dropping that grant would break assessment creation.

**Direction (not an implementation).** Fix the schema comment's function name; have ADR-0003 note explicitly that the migration comment is frozen-stale and superseded by the ADR.

### DOC-12 [Low] AGENTS.md claims C1 skill-invocation is 'harness-enforced by a UserPromptSubmit hook' — no such hook ships with the repository
*AGENTS.md:1* — sweep confidence: probable

**Claim.** AGENTS.md C1 states the skills obligation is 'Also harness-enforced by a `UserPromptSubmit` hook', and SKILLS_INVENTORY leans on the same hook in its firing analysis — but .claude/ in the repo contains only an untracked settings.local.json with no hooks key and no UserPromptSubmit anywhere (git tracks nothing under .claude/). The claimed mechanical enforcement does not exist for anyone who clones the repo.

**Evidence.** AGENTS.md §1 C1 ('Also harness-enforced by a `UserPromptSubmit` hook'); `git ls-files .claude/` → empty; `grep -n "UserPromptSubmit|hooks" .claude/settings.local.json` → no matches; docs/SKILLS_INVENTORY.md ('named… in the `UserPromptSubmit` hook').

**Impact.** A document whose entire thesis is 'mechanism beats prose' asserts a mechanism that is absent from the repo; a new environment silently loses the enforcement the rules say exists, and per the project's own §0 law, the unenforced obligation will not fire.

**Direction (not an implementation).** Commit the hook configuration (or a setup script that installs it) to the repo, or amend AGENTS.md to state where the hook must be installed and that it is per-machine.

**Not examined by this auditor:**
- Line-by-line verification of the four Plan 1a–1d specs/plans under docs/superpowers/ against shipped code — ~5 large documents; ADRs were the prioritized record since they are what a newcomer is directed to; specs were only checked for existence and citation resolution
- docs/security/2026-08-10-registration-rate-limit-threat-derivation.md against the implemented rate limiter — ran out of budget after the runbook chain; no claim about it is made either way
- docs/runbooks/troubleshooting.md beyond the header and §1 — same authorship date and container-name class as the other two runbooks; individual fixes not spot-checked
- Whether rai.air.ug resolves or a production server actually exists — no external network probing performed in a read-only audit; DOC-02/03 severity derived from files alone
- ADR-0001's historical call-site census numbers (22 files, 50 call sites) — they describe the 2026-08-02 baseline tree by their own framing, not the current tree, so current-tree divergence is not drift
- backup-restore.md's off-site/encryption sections and the cron script body beyond the pg_dump line — the role-loss finding already invalidates the restore path; deeper command audit deprioritized
- Item-by-item currency of audit-phase1-phase5-findings.md's 19+ findings — only the class was established via ui-ux-audit's headline criticals; per-item re-testing would need live UI runs
- DEFERRED_REGISTER rows other than the ~12 read — 379 lines of dense rows; sampled those bearing on documentation truth

## engine-scoring

The engine is clean, deterministic, immutable-state code with real strengths (server-side score computation in one transaction, cited cross-stage rules, mechanical rule-reference integrity). But the scoring math has a confirmed correctness defect that caps the pre-processing Transparency principle at ~31% even with perfect answers; cross-stage likert evidence (18 question-to-area mappings across 11 of 21 areas) is silently dropped from area scores while the findings layer counts it; engineState is client-authored JSON persisted with near-zero server validation, making the server-side stage gating nonexistent and the "cannot be forged" comment false; and the register's own mitigation for shipping underived scoring (D-037's "provisional" marker) was never implemented — the opaque single percentage VISION 4.1 calls indefensible is still the unmarked headline of the report and PDF. The 4.3 ADOPT/ADAPT/RE-DERIVE gate was tracked honestly in the register but not honored in effect: all classifications remain open while the assets serve production.

**Sound (what is genuinely good):**
- Immutable state updates, no randomness, insertion-order-stable iteration: the engine is deterministic given the same state; the recursion guard on getAreaScore (AssessmentEngine.js:455-477) is honest, documented defensive code.
- Weight normalization is correctly implemented and documented (calculateAreaScores divides by running totalWeight, so scores are independent of raw weight magnitude — AssessmentEngine.js:293-300).
- All 12 cross-stage rules and 6 conditional-question rules reference real questions/areas in the correct stages — verified mechanically (node script over questionBank/scoringConfig/assessmentAreas: zero missing or misplaced references, zero duplicate question IDs across 78 questions).
- Every cross-stage rule carries a rationale and literature citation surfaced to users via getWeightExplanations — a genuine transparency mechanism rare in scoring tools.
- Score computation at completion is server-side, inside one withOrg transaction, with completed-assessment immutability and framework-drift gating on both the PATCH and complete paths (lib/data/assessments.ts:60-208); initial engineState is server-built via createAssessment in the POST route.
- The deferred register is honest about the methodology gap: D-031 (no weight derivation), D-039 (tests validate behaviour against themselves), D-020 (maturity rubric parked) are all openly recorded.
- Iterative hardening is visible and real: B1-B5 fix comments (likert clamping, gate-condition enforcement, array-length condition coercion) each match working code; 83 engine tests pass (vitest run: 4 files, 83 passed).

### ENG-01 [Critical] Gate question's weight:0 is coerced to 1, capping pre-processing Transparency principle score at ~31% even with perfect answers
*lib/engine/AssessmentEngine.js:403* — sweep confidence: confirmed

**Claim.** calculatePrincipleScores uses `const baseWeight = q.weight || 1;` — Q-PP-GATE-SENSITIVE (data/questionBank.json:270-279, weight: 0, principle 'Transparency & Explainability') gets phantom weight 1.0 while normalizeResponse returns 0 for gates (AssessmentEngine.js:282-284). The gate contributes 0 to the numerator and 1.0 to a denominator whose real questions total only 0.45.

**Evidence.** AssessmentEngine.js:403 `const baseWeight = q.weight || 1;`; questionBank.json:279 `"weight": 0`; replication of calculatePrincipleScores over real data: Transparency & Explainability pre-processing max achievable = 31% (totalWeight 1.45, of which 1.0 is the gate; other principles all reach 100). All-max area-score tests pass because the gate has gaps:[] and never enters calculateAreaScores.

**Impact.** Every full assessment's report, PDF, and radar chart shows pre-processing Transparency at <=31% ('Needs Work') no matter what the team answers — a systematic misreport of one of the eight headline principles, invalidating the scoring's correctness promise. No test catches it because tests only assert area scores reach 100, not principle scores.

**Direction (not an implementation).** Treat weight 0 as an explicit exclusion (use `q.weight ?? 1` plus skip gates in principle grouping), and add a test asserting every principle can reach 100 under perfect answers.

**Verification: CONFIRMED.** I ran the production engine itself (only the import mechanism shimmed, logic untouched) with every pre-processing answer at maximum: Transparency & Explainability scores 31 with gate=Yes and 23 with gate=No, while all seven other principles reach 100. Root cause is exactly as claimed: AssessmentEngine.js:403 coerces the gate's weight 0 to 1.0 while gates normalize to 0 (lines 282-284), so 1.0 of a 1.45 denominator can never earn points. The wrong number reaches users in the PDF principle table (ReportPdf.tsx:186-199), report maturity labels (useFindingsData.ts:107-119, level 'critical'), and the dashboard radar; no test asserts any principle-score value, so nothing catches it. Kill attempts failed: no pre-processing modifiers exist to offset it, the gate cannot be excluded from getScoringQuestions, and the UI's gate-answer format ('Yes'/'No' strings) matches my replication — Critical stands because a headline principle is mathematically misreported in every full assessment regardless of answers.

*Verifier evidence:* Ran production code: calculatePrincipleScores(all-max state, 'pre-processing') → {Transparency & Explainability: 31, all others: 100} (gate=Yes) / 23 (gate=No); lib/engine/AssessmentEngine.js:403 `const baseWeight = q.weight || 1;` and :282-284 gate→0; data/questionBank.json:270-279 (weight 0, principle Transparency & Explainability); group weights 0.12+0.15+0.08+0.10=0.45 vs denominator 1.45; lib/pdf/ReportPdf.tsx:186-199; __tests__/engine/AssessmentEngine.test.js:170,562 and E2EAssessment.test.js:197-200 (no value assertions)

### ENG-02 [High] engineState is client-authored JSON persisted with only a truthy-key check; server-side stage gating does not exist
*app/api/v1/orgs/[slug]/assessments/[id]/route.ts:91* — sweep confidence: confirmed

**Claim.** The PATCH route's entire validation is `if (!engineState || typeof engineState !== 'object' || (!engineState.stages && !engineState.quick))` — then respondToAssessment persists it verbatim (lib/data/assessments.ts:87 `tx.assessment.update({ where: { id }, data: { engineState } })`). No schema, no size limit, no mode-consistency check, no re-run of completeStage's prerequisite/required-question validation server-side. The comment at assessments.ts:189 ('Score is computed server-side ... so it cannot be forged by the client') is false as to gating: statuses, completedAt, and responses are all client-supplied.

**Evidence.** route.ts:91-93; assessments.ts:87, 189-196. `{stages: 1}` or `{stages: {}}` passes the guard, persists, then canGenerateReport throws TypeError (`state.stages['pre-processing'].status`) → 500 on POST /complete; a full-mode assessment PATCHed with a `{quick:...}` state crashes the same way. A client can also mark all three stages 'completed' with empty responses, bypassing the engine's sequential gating and unanswered-question validation entirely (completeStage is never invoked server-side).

**Impact.** Any member with assessment:respond can corrupt the org's shared assessment into an uncompletable 500 state, bypass the Pre→In→Post gated methodology the product is built on, or store unbounded junk JSON that is served back to every member. Blast radius is intra-org (RLS holds) but it breaks the integrity of the core artifact.

**Direction (not an implementation).** Validate engineState against a zod schema derived from EngineState (stage keys = STAGE_ORDER, status enum, response value types, size cap), reject mode-mismatched shapes, and re-derive stage statuses server-side rather than trusting them.

**Verification: CONFIRMED.** The truthy-key guard at route.ts:91 is the entire server-side validation, and respondToAssessment persists the client blob verbatim (assessments.ts:87). {stages:1} and {stages:{}} both pass the guard (truthy), persist, and make POST /complete throw TypeError in canGenerateReport (engine line 194), which toResponse.ts:41 rethrows as a 500; a corrupted state also bricks the normal UI since getStageStatus falls back to 'locked' for every stage. completeStage — the only code enforcing Pre→In→Post prerequisites and required-question completeness — is invoked exclusively client-side (AssessmentPageClient.tsx:415,595,618), no zod exists anywhere in app/lib, and the integration test file itself acknowledges the crash path (assessments.test.ts:440-444) without covering it. High (not Critical) is the right level: RLS confines the blast radius intra-org, but any member with assessment:respond can brick, gate-bypass, or junk-fill the org's core artifact.

*Verifier evidence:* app/api/v1/orgs/[slug]/assessments/[id]/route.ts:91-93; lib/data/assessments.ts:87,189-196; lib/engine/AssessmentEngine.js:194 `state.stages[stage].status`; lib/http/toResponse.ts:41 (rethrow→500); grep: completeStage only in AssessmentPageClient.tsx:415,595,618 + .d.ts; grep -rln zod app lib → no hits; __tests__/integration/assessments.test.ts:440-444 ('canGenerateReport(state) would need state.stages[...] ... throw')

### ENG-03 [High] Cross-stage likert gap mappings (18 mappings, 11 of 21 areas) are silently dropped from area scores while the findings layer counts them
*lib/engine/AssessmentEngine.js:339* — sweep confidence: confirmed

**Claim.** calculateAreaScores Source 1 only considers questions in the area's own stage (`questions = getScoringQuestions(state, stage)` filtered by `q.gaps.includes(area.id)`), so a likert question whose gaps reference an area in another stage contributes nothing to that area's score. Source 2 explicitly aggregates checklist optionGapMap evidence cross-stage (lines 322-331), so the identical relationship in likert form being dropped is an asymmetry, not a stated design. The classification layer (useFindingsData.ts:145-178) DOES push cross-stage likert evidence into gap/attention/strength for those same areas.

**Evidence.** Mechanical scan: 18 dropped mappings across 11 areas, e.g. PO-07 'Documentation Deficit' loses 4 of its 7 likert sources (Q-PP-08, Q-PP-15, Q-IP-12, Q-IP-20); PO-05 loses 1 of 2, leaving its score resting on a single question; PP-01 loses 2 of 4 (Q-IP-16, Q-IP-09). Q-PP-07's ONLY gaps entry is PO-05 — its answer affects no area score at all.

**Impact.** The report can flag an area as a gap based on an answer that its numeric score ignored — score and findings disagree about the same evidence. Area scores for 11 areas understate their evidence base, and these scores also feed cross-stage rule triggers (getAreaScore) and the overall rollup.

**Direction (not an implementation).** Either aggregate cross-stage likert gaps in Source 1 the way Source 2 does for checklists, or strip cross-stage entries from the data and document that area scores are stage-local — but make score and classification use the same evidence set.

**Verification: CONFIRMED.** My independent census over questionBank + assessmentAreas reproduced the numbers exactly: 18 cross-stage likert gap mappings across 11 areas, PO-07 losing 4 of its 7 likert sources, PO-05 losing 1 of 2 (its score rests on Q-PO-13 alone), and Q-PP-07's only gaps entry (PO-05) affecting no area score at all. The asymmetry is plain in code — Source 1 is stage-keyed (getScoringQuestions(state, stage) at :313, filter at :339-342) while Source 2 deliberately scans all completed stages for checklists (:322-331) — and useFindingsData.ts:145-178 pushes likert findings to every q.gaps area with no stage check, so classification and score genuinely diverge on the same answer (e.g. Q-PP-08=0 puts PO-07 in the gaps list while PO-07's numeric score ignores it). I hunted for a stated stage-local design decision and found none; D-034 (the engine classification that would have adjudicated this) is Open and never ran. Area scores also feed rule triggers (:472) and the overall rollup (:724-736), as claimed.

*Verifier evidence:* node census: 18 mappings/11 areas {PO-05:1,PO-07:4,PO-01:2,PO-03:1,IP-02:1,PP-01:2,IP-03:1,IP-05:2,IP-01:2,PP-06:1,PP-04:1}; PO-07 same-stage [Q-PO-19,Q-PO-10,Q-PO-15] vs dropped [Q-PP-08,Q-PP-15,Q-IP-12,Q-IP-20]; lib/engine/AssessmentEngine.js:313,322-331,339-342,472; components/report/useFindingsData.ts:145-178 (q.gaps.forEach with no stage filter); grep for stage-local/own-stage design docs → none; DEFERRED_REGISTER.md:80 D-034 Open

### ENG-04 [High] The scoring VISION 4.1 calls 'an opaque absolute' with 'no defensible basis' is still shipped, as the unmarked headline
*lib/engine/AssessmentEngine.js:724* — sweep confidence: confirmed

**Claim.** generateReportData computes overallScore as an unweighted average of per-stage averages of 21 equal-weight area scores (lines 724-736) — exactly the collapse 4.1 criticizes. The UI headlines it in a score ring with encouraging copy (ReportSummary.tsx:100-108 'You're in good shape') and the PDF derives its 'Maturity Level' label directly from that single number (ReportPdf.tsx:178-180). Principle-level maturity labels do exist (useFindingsData.getLevel) — a partial move — but areas get gap/attention/strength classification, not maturity levels, and D-020 (methodology re-derivation) is PARKED/Open.

**Evidence.** VISION_AND_PLAN.md:68 'Move to maturity levels per area/principle, with the single number as a rollup, not the headline'; ReportSummary.tsx:100-101 renders `{overallScore}%` as the executive-summary ring; DEFERRED_REGISTER.md D-020 Open.

**Impact.** Institutions receive a headline percentage the project's own plan of record says has no defensible basis, with a maturity label derived from it, in a PDF designed for external presentation.

**Direction (not an implementation).** Demote the overall percentage to a rollup per the vision, or at minimum gate its external presentation on D-020/D-031 closing.

**Verification: CONFIRMED.** Every citation checks out: VISION 4.1 calls the score 'an opaque absolute' with 'no defensible basis for collapsing 21 areas into one percentage' and directs 'the single number as a rollup, not the headline'; generateReportData:724-736 performs exactly that collapse; ReportSummary.tsx:100-108 headlines it in a score ring with encouraging copy; ReportPdf.tsx:170-181 headlines 'Overall Score' and derives 'Maturity Level' from it by inline ternary in a component whose own comment calls it 'the auditor-facing PDF export'; D-020 is PARKED/Open. The one refutation angle — that this is a recorded, deliberately accepted Phase-1 risk — fails because the register's acceptance (D-037: 'the honest middle path between blocking Phase 1 and shipping an untraceable number unmarked') was conditioned on a provisional marker that was never built, so the shipped state is precisely the branch the register itself names as dishonest. High stands: the unmarked headline contradicts the plan of record in the artifact designed for external presentation.

*Verifier evidence:* docs/VISION_AND_PLAN.md §4.1 (line ~68: 'opaque absolute... rollup, not the headline'); lib/engine/AssessmentEngine.js:724-736; components/report/ReportSummary.tsx:100-108; lib/pdf/ReportPdf.tsx:108 ('auditor-facing'),170-181; docs/DEFERRED_REGISTER.md:66 (D-020 PARKED/Open),83 (D-037 conditions the acceptance on the marker)

### ENG-05 [High] D-037's 'provisional' score marker — the recorded mitigation for shipping underived scoring — was never implemented
*docs/DEFERRED_REGISTER.md:83* — sweep confidence: confirmed

**Claim.** Register row D-037 (RISK, 2026-08-02) states 'Score renders with a provisional marker in UI + PDF; Phase-1 output not presented to any external institution as authoritative', with pick-up trigger 'D-020 and D-031 both closed → remove the marker'. No such marker exists or ever existed in the codebase.

**Evidence.** `grep -rn provisional components app lib` → zero hits; `git log --all -S "provisional" -- components lib app` → zero commits. ReportSummary.tsx and ReportPdf.tsx render score, maturity label, and encouraging copy with no caveat of any kind.

**Impact.** The honest-middle-path justification for letting Phase 1 ship untraceable scoring rests on a mitigation that does not exist — the exact 'obligation recorded as discharged while the mechanism is absent' failure class the project's AGENTS.md §2 and D-191 document. Anyone reading the register believes the score is marked; it is not.

**Direction (not an implementation).** Implement the marker in ReportSummary and ReportPdf now, or amend D-037 to record that the mitigation was never built.

**Verification: CONFIRMED.** The register row (D-037, line 83) states as fact that 'Score renders with a provisional marker in UI + PDF', and the Phase-1 design spec goes further — it REQUIRES 'the score renders with an explicit provisional marker in UI and PDF until D-020 and D-031 both close' (spec lines 301-303). No such marker exists or ever existed: zero occurrences of 'provisional' in components/app/lib; an unfiltered git log --all -S 'provisional' shows the string only ever appeared in three docs commits; and I hunted for the marker under alternate wording (marker/caveat/draft/preliminary/indicative/not-authoritative/beta) across ReportSummary.tsx and ReportPdf.tsx and read both render trees — the score ships with a ring, a maturity label, and encouraging copy, no caveat of any kind. This is the exact obligation-recorded-as-discharged-while-the-mechanism-is-absent class the project's own D-191 documents, and it is the load-bearing justification for shipping Phase-1 scoring at all, so High stands.

*Verifier evidence:* docs/DEFERRED_REGISTER.md:83; docs/superpowers/specs/2026-08-02-phase1-foundation-design.md:301-303 ('renders with an explicit provisional marker in UI and PDF'); grep -rni provisional components app lib → exit 1 (no hits); git log --all --oneline -S 'provisional' → only a83be64/9739454/6610485, all docs-only (--name-only shows no non-docs paths); grep for caveat-wording in ReportSummary.tsx/ReportPdf.tsx → no hits; ReportSummary.tsx:100-108 and ReportPdf.tsx:168-183 render score/label/copy uncaveated

### ENG-06 [Medium] The 4.3 ADOPT/ADAPT/RE-DERIVE gate was not honored in effect: all engine/content/report classifications remain open while the assets serve production
*docs/DEFERRED_REGISTER.md:80* — sweep confidence: confirmed

**Claim.** VISION 4.3: 'no asset ports into the platform without a recorded classification and the evidence behind it.' D-034 (engine mechanics), D-035 (report+PDF), D-049 (UI), D-031 (weights), D-032 (content currency) are all Open, each phase-exit repeating that 'the engine port gate has still not arrived' — while lib/engine is statically imported by production routes and pages (app/api/v1/orgs/[slug]/assessments/route.ts:8, AssessmentPageClient.tsx:16, lib/data/assessments.ts:3-4) and computes every score the product stores and displays.

**Evidence.** D-034 row: 'Proposed ADAPT... The named gate has still not arrived' (DEFERRED_REGISTER.md:80) vs. `grep -rn AssessmentEngine app lib/data` showing seven production import sites; engine files in-tree since 2026-06-29 serving live assessments.

**Impact.** The gate's premise — classification before porting — is factually moot: the port happened without it, and the register's 'gate not yet arrived' framing obscures that the unclassified assets are already load-bearing. The register is honest about the open rows but wrong about the state of the world.

**Direction (not an implementation).** Reframe D-034/D-035 as overdue retroactive audits of in-production assets (the register's own 2026-08-12 'overdue rather than deferred' pattern), not future gates.

### ENG-07 [Medium] Scoring magic numbers have no derivation; the engine's design-decision doc pointer is broken; the 2.0x 'safety cap' is unreachable dead code
*lib/engine/AssessmentEngine.js:8* — sweep confidence: confirmed

**Claim.** AssessmentEngine.js:8 cites 'docs/research/phase4-evidence-synthesis.md' — the file does not exist anywhere in the repo (docs/research/ absent; only stale .next build chunks match). The 78 question weights (0.05-0.2), ROLE_WEIGHTS (1.0/0.6/0.3), rule modifiers (1.3-1.5), and the 50/1 thresholds have no recorded derivation (register D-031 confirms). Under the 'max' overlap strategy with max rule modifier 1.5, the modifierCap of 2.0 can never bind — the 'cap enforced' test (AssessmentEngine.test.js:250-261) passes vacuously and would still pass if the cap logic were deleted.

**Evidence.** `ls docs/research` → No such file or directory; scoringConfig.json:177 `"modifierCap": 2.0, "overlapStrategy": "max"` with all 12 modifiers <=1.5; D-031 (DEFERRED_REGISTER.md:77): weights 'have no recorded derivation... untraceable — the tool's own PO-07 / IP-04 failure'.

**Impact.** The numeric layer driving every score is untraceable, the one pointer to its rationale is dead, and the advertised safety constraint is decorative — the tool commits the documentation-deficit failure it diagnoses. (Credit: each cross-stage rule does carry a rationale and citation.)

**Direction (not an implementation).** Recover or recreate the evidence-synthesis document (it is referenced as existing), or remove the pointer and let D-031's re-derivation own it; delete or make reachable the cap.

### ENG-08 [Medium] Cross-stage weight modifiers have no effect on area scores when the target is a checklist question — but are still reported to users as active
*lib/engine/AssessmentEngine.js:356* — sweep confidence: confirmed

**Claim.** calculateAreaScores Source 2 (lines 356-374) scores checklist contributions using ROLE_WEIGHTS only — it ignores both q.weight and modifiedWeights. CSW-01 targets Q-IP-06, which is a checklist (type checklist, weight 0.12, gaps:[]), so its advertised 1.5x modifier changes no area score; it does apply in calculatePrincipleScores (line 403-405), where checklists are scored by a different model (length/totalOptions x weight). getWeightExplanations still reports the modifier as active on Q-IP-06.

**Evidence.** scoringConfig.json:57 CSW-01 targetQuestions include 'Q-IP-06'; node check: Q-IP-06 type=checklist; AssessmentEngine.js:361-373 uses only roleWeight, no crossMod, no q.weight.

**Impact.** The same question is scored under two different models across the two score views, and the cross-stage 'proportionate response' mechanism silently does nothing for one of its 12 rules' three targets while the explanation UI claims it does.

**Direction (not an implementation).** Apply the modifier to Source 2 contributions (or exclude checklists from rule targets and document why), and unify the two checklist scoring models.

### ENG-09 [Medium] getQuickScore performs no clamping: out-of-range client values produce scores like 10000 or negatives, stored in overallScore
*lib/engine/QuickAssessment.js:63* — sweep confidence: confirmed

**Claim.** `const normalized = typeof value === 'number' ? value / 4 : 0;` has no clamp (unlike the main engine's normalizeResponse B4 fix). completeAssessment feeds client-authored `quickState.quick.responses` straight into it (lib/data/assessments.ts:167-171) and stores the result as overallScore. respondToAssessment accepts `{quick:...}` engineStates (route guard allows them), so any legacy quick-mode assessment can be completed with e.g. value 400 → score 10000, or negative values → negative score.

**Evidence.** QuickAssessment.js:63 (no Math.min/Math.max); assessments.ts:166-171; route.ts:91 accepts engineState.quick; quick-assessment.test.js has no out-of-range test (6 tests, all 0-4 inputs). Path is limited to legacy rows since POST rejects mode:'quick' (D-012).

**Impact.** A nonsense overallScore lands in the DB and dashboard for legacy quick assessments; demonstrates the missing-validation class of ENG-02 on a second surface.

**Direction (not an implementation).** Clamp in getQuickScore exactly as normalizeResponse does, and validate quick responses server-side.

### ENG-10 [Medium] The 'AdversarialClassification' and E2E tests validate copies of logic, not production code
*__tests__/engine/AdversarialClassification.test.js:24* — sweep confidence: confirmed

**Claim.** The classification test file re-implements the report's three-tier classification locally ('Helpers: replicate the ReportPage evidence classification logic so we can test it without rendering React components', lines 24-33) — the production implementation in components/report/useFindingsData.ts:140-241 is never imported, so drift between the two would not fail any test. The E2E test's 'Checklist critical subset rules work correctly' (E2EAssessment.test.js:272-298) defines an inline `checklistRules` system (critical subsets + min thresholds) that exists nowhere in the engine, config, or UI, and asserts its own fixture data satisfies it — it exercises zero production code.

**Evidence.** AdversarialClassification.test.js:24-33 header; E2EAssessment.test.js:279-286 inline checklistRules object with no counterpart anywhere in lib/ or data/ (grep for 'critical'/min-threshold logic: none). Also AssessmentEngine.test.js:244 wraps its overlap assertion in `if (weights['Q-IP-04'])`, silently asserting nothing if the key is absent.

**Impact.** The crown-jewel classification logic has no test coverage of its production implementation; a fabricated rule system in a test named 'work correctly' gives false assurance. This is concrete new evidence for the register's own D-039.

**Direction (not an implementation).** Export the classification function from useFindingsData (it is pure) and test it directly; delete or rewrite the checklist-subset E2E test against real code.

### ENG-11 [Medium] Earlier-stage area scores mutate retroactively after later stages complete, and can toggle the very rules they source
*lib/engine/AssessmentEngine.js:322* — sweep confidence: confirmed

**Claim.** calculateAreaScores gathers checklist optionGapMap contributions from ALL completed stages (lines 322-331: `if (state.stages[s].status !== 'completed' && s !== stage) continue;`). Q-PO-11 (post-processing) maps options to PP-06 and IP-06, so completing post-processing changes the pre-processing PP-06 score shown in the final report versus what the user saw at pre-completion — and PP-06 is the source of rules CSW-04 and CSW-12, so answers in a later stage can flip modifiers applied to that same later stage's scoring. Nothing documents this 'evidence accumulates' semantics.

**Evidence.** AssessmentEngine.js:322-331; node scan: 'CROSS-STAGE OGM: Q-PO-11 (post-processing) -> IP-06@in-processing, PP-06@pre-processing'; scoringConfig CSW-04/CSW-12 sourceArea PP-06.

**Impact.** Scores are not stable over an assessment's lifetime; a user comparing their pre-processing score before and after completing later stages sees unexplained movement, and the feedback path between a stage's answers and its own modifiers is undocumented and unreviewed.

**Direction (not an implementation).** Document the accumulation semantics as a deliberate decision (or snapshot per-stage scores at stage completion), and note the modifier feedback path in the D-034 classification when it runs.

### ENG-12 [Medium] Type declarations assert shapes the data and runtime contradict; boundary casts are unvalidated
*types/domain.ts:36* — sweep confidence: confirmed

**Claim.** QuestionCondition.value is typed `number` but the actual gate conditions in questionBank.json are strings (`"value": "Yes"` for Q-PP-13/Q-PP-14, questionBank.json:299), and the UI stores gate responses as option strings (QuestionBlock.tsx:119 `onChange={() => onResponseChange(q.id, opt)}`) — the types work only because JSON is force-cast (`as unknown as QuestionBank`). EngineState is likewise force-cast at every boundary (assessments.ts:191 `as unknown as EngineState`; loadState JSON.parse with no check), and the .d.ts types stage params as bare `string` with `getStageStatus` returning `string` rather than unions.

**Evidence.** types/domain.ts:34-38 `value?: number`; data/questionBank.json:298-300 `"questionId": "Q-PP-GATE-SENSITIVE", "value": "Yes"`; lib/data/assessments.ts:191.

**Impact.** The declared types are wrong about real data, so the type layer cannot catch exactly the class of engineState-shape bugs found in ENG-02; anyone trusting QuestionCondition.value: number writes broken comparison code that compiles.

**Direction (not an implementation).** Fix QuestionCondition.value to `number | string`, add runtime schema validation at the JSON boundaries, and narrow stage params to StageName.

### ENG-13 [Low] Dead SPA-era exports: localStorage persistence under one global key, and getVisibleQuestions that skips gate conditions
*lib/engine/AssessmentEngine.js:82* — sweep confidence: confirmed

**Claim.** saveState/loadState/clearState/resetAssessment persist to localStorage under the single global key 'makai-unified-assessment' (lines 22, 82-114) — zero consumers in app/ or components/ (grep). If ever called in the multi-assessment, multi-org platform, all assessments would collide on one browser key. The header comment (line 12) still says 'sessionStorage persistence'. getVisibleQuestions (line 664) also has zero consumers and, unlike the UI's own isConditionMet reimplementation (AssessmentPageClient.tsx:40-46), passes no state to getAllQuestionsForStage so it would show gated questions regardless of the gate answer.

**Evidence.** grep -rn 'saveState|loadState|getVisibleQuestions' app components → no hits; AssessmentEngine.js:12 vs :82-84.

**Impact.** Latent cross-assessment data-bleed trap plus duplicated visibility logic (engine vs client) that can drift — concrete residue of the never-run ADAPT classification (D-034).

**Direction (not an implementation).** Delete the localStorage functions and getVisibleQuestions, or make the client consume the engine's (fixed) version.

### ENG-14 [Low] Maturity banding and principle vocabulary duplicated across four code sites plus dead config
*data/scoringConfig.json:44* — sweep confidence: confirmed

**Claim.** scoringConfig.maturityLevels and principles.thresholds are consumed by nothing (only hashed by lib/framework/bundleHash.ts); the same 0/25/50/75 banding is independently hardcoded in useFindingsData.getLevel (lines 74-79), data/constants.ts levelLabels/levelColors (lines 22-34), and an inline ternary in ReportPdf.tsx:179. scoringConfig keys the accountability principle 'reproducibility' while constants.ts principleSlugMap uses 'accountability'.

**Evidence.** grep -rn scoringConfig app components lib → only bundleHash and engine imports; the four threshold sites listed.

**Impact.** Currently consistent, but a change to any one site silently diverges the others — and the 'versioned framework content' promise hashes config that the running code ignores.

**Direction (not an implementation).** Make getLevel/constants read from scoringConfig (the hashed, versioned source) or delete the dead config blocks.

### ENG-15 [Low] Undocumented rule-evaluation asymmetries: strict vs inclusive thresholds, unanswered-equals-failing, and misattributed explanations
*lib/engine/AssessmentEngine.js:525* — sweep confidence: confirmed

**Claim.** Three quiet semantics in getModifiedWeights: (a) areaScore rules fire on `sourceScore < threshold` but questionScore rules on `<= threshold` (lines 525-527) — undocumented in config or code; (b) a completely unanswered upstream stage scores 0, so ALL area rules fire (acknowledged only in a test name, AssessmentEngine.test.js:407); (c) when overlapping rules target one question, the losing rule's id is still pushed (line 538) and getWeightExplanations attributes the winning modifier value to it (lines 586-595) — e.g. CSW-02 (1.4) shown with modifier 1.5 on Q-IP-04.

**Evidence.** AssessmentEngine.js:525-527, 532-539, 564-597; scoringConfig rules CSW-01 (1.5) and CSW-02 (1.4) share target Q-IP-04.

**Impact.** The explanation surface — the product's answer to 'why did my weight change' — can state a numerically wrong modifier per rule, and the threshold semantics cannot be audited from the config alone.

**Direction (not an implementation).** Store per-rule applied modifiers in the weights structure, document the comparison semantics in scoringConfig, and state the unanswered-upstream policy in the engine docstring.

### ENG-16 [Low] Untracked empty probe file app/__effective_config_probe.ts in the working tree
*app/__effective_config_probe.ts* — sweep confidence: confirmed

**Claim.** git status shows `?? app/__effective_config_probe.ts`; the file is empty. The project's own AGENTS.md C4 rule declares untracked residue a finding (invisible to diff-based review).

**Evidence.** gitStatus snapshot: '?? app/__effective_config_probe.ts'; `head` of the file returns nothing (0 bytes).

**Impact.** Residue from a prior session sits in app/, where Next.js route scanning could one day pick up a non-empty version; violates the project's committed-or-declared rule.

**Direction (not an implementation).** Delete it or declare it in the register per §4.

**Not examined by this auditor:**
- Live browser end-to-end drive of the assessment flow and report rendering — Audit is read-only and time-boxed; all findings here are establishable statically, but the user-visible presentation of ENG-01/ENG-11 was inferred from code paths (marked where relevant).
- Content quality of the 78 questions / 21 areas / 28 controls against NIST/UNESCO/EU AI Act sources — Domain-content currency is register row D-032's scope and needs literature access; I verified structure and internal consistency only.
- The PDF route's framework-pinning/hash mechanics and the evidence subsystem — Adjacent dimensions presumably assigned to other auditors; I read only the score-rendering portions of ReportPdf.tsx.
- __tests__/integration/* (trigger-enumeration, assessments integration tests) in detail — Capacity; I confirmed via the register and code comments what they cover but did not audit their assertions line-by-line.
- Floating-point boundary enumeration (whether any real weight combination lands exactly on a Math.round .5 or a 25/50/75 maturity boundary) — Requires exhaustive response-space search; the hazard is inherent and minor, so noted rather than enumerated.
- RadarChart.tsx rendering logic beyond its principleScores consumption — Presentation-layer detail outside the scoring-methodology core.

## evidence-pipeline

The evidence subsystem is unusually well-engineered at the row level: bytes live in Postgres bytea in a blob table split from metadata, both under RLS+FORCE with composite FKs binding blob orgId to its parent, no UPDATE grant (DB-enforced write-once), magic-byte default-deny validation, a hardened download path (fixed octet-stream, attachment, nosniff, RFC 6266, hash-verified fail-closed), and a delete path whose completion-race was closed with FOR UPDATE and proven in both directions. The real weaknesses are at the seams the row-level rigor never reached: the upload half of the same O-24 immutability invariant still has the exact TOCTOU race the delete half fixed (unregistered); the spec's own escape hatch for post-completion evidence removal ("deleting the assessment, which is visible") is implemented as an unlogged whole-project cascade with no assessment-level delete and no visibility mechanism; and the vision's credibility-tier ladder exists only as a two-value derived enum that no UI displays and whose upgraded state no UI can even reach. Storage growth is unbounded by any quota (only a 10/min rate limit), which matters because the bytes are in the database a pg_dump backs up on a future VPS.

**Sound (what is genuinely good):**
- Byte storage design is deliberate and documented: bytea in evidence_blobs split from metadata (spec decision table row 1, human-partner approved), so listing queries never drag TOAST'd blobs; backup-sensitivity change is acknowledged in spec §5.5 and tied to hosting row D-018.
- Upload validation is genuinely default-deny: inspect() (lib/evidence/inspect.ts:46-64) trusts magic bytes only, has no text/plain fallthrough, rejects anything unrecognised; the client's declared MIME is discarded (route comment and test 'discards the client's declared MIME type'). Stored-XSS-via-download is closed twice over: HTML/SVG can't be stored, and downloads always serve application/octet-stream + Content-Disposition: attachment + X-Content-Type-Options: nosniff with RFC 6266 filename encoding (evidence/[evidenceId]/route.ts:55-66,158-172), all pinned by integration tests including CRLF injection.
- Tenancy is structural, not conventional: evidence_blobs' composite FK (orgId, evidenceId) -> evidence(orgId, id) makes a cross-org blob unrepresentable (migration 20260808140048:89-101); RLS policies on both tables; no UPDATE grant makes row immutability a database fact, tested by 'UPDATE on evidence is rejected'.
- The delete-side completion race was found preventively, fixed with SELECT ... FOR UPDATE + SET LOCAL lock_timeout, and non-vacuously tested in both commit and rollback directions (evidence-download.test.ts:497,540).
- mutateThenConfirm does close the failure mode it exists for: the round-1 bug (confirmation-refetch failure indistinguishable from success) is now a three-way return type wired to a distinct 'stale' UI channel, with a call-count spy proving confirm is never called after a failed mutate; residual gaps (sibling-question staleness) are honestly registered as D-170.
- The deferred register is exceptional: D-150 (no text/CSV), D-152 (buffering DoS), D-154 (concurrent dedup 500), D-155 (no pagination), D-162 (unbounded filename), D-176 (single-column remediation FK, proven live), D-187 (accept-list drift), D-189 (dedup provenance inheritance) all pre-empt findings this audit would otherwise have made.
- Integrity: sha256 recorded at upload, recomputed over actual stored bytes before every download, fail-closed with critical-severity logging and no hash leakage; Content-Length derived from the bytes actually served, not the stored column.

### EV-1 [High] O-24's insert half has the exact TOCTOU race the delete half fixed: upload status check is a plain read, not FOR UPDATE
*app/api/v1/orgs/[slug]/assessments/[id]/evidence/route.ts:168* — sweep confidence: confirmed

**Claim.** The evidence upload route checks assessment.status with a plain findUnique, so a completion committing between that read and the evidence insert lets evidence land on a completed assessment — the identical race the DELETE handler documents at length and closes with SELECT ... FOR UPDATE. The asymmetry is unregistered: no DEFERRED_REGISTER row covers it, and no test exercises upload-vs-completion concurrency.

**Evidence.** app/api/v1/orgs/[slug]/assessments/[id]/evidence/route.ts:168 'const assessment = await tx.assessment.findUnique({ where: { id }, select: { status: true } });' and :187 completed check — no lock. Contrast app/api/v1/orgs/[slug]/evidence/[evidenceId]/route.ts:275-276 'SELECT status FROM "assessments" WHERE id = ${row.assessmentId} FOR UPDATE', whose own module doc (lines 191-209) explains this exact race and cites D-130. completeAssessment (lib/data/assessments.ts:141-149) is a plain findUnique+update. grep of DEFERRED_REGISTER.md for upload+lock/race/TOCTOU terms: no row; evidence-upload.test.ts test list has no concurrency test.

**Impact.** Evidence can be attached to a completed assessment during the race window, violating the spec §5.1 promise that 'an auditor can trust that a completed assessment's evidence set is what was actually reviewed'. Worse compounding: the PDF manifest reads evidence fresh per render, so post-completion evidence appears in the auditor-facing manifest; and the slipped row is then undeletable (DELETE refuses on completed assessments), so the corruption is permanent short of deleting the whole project.

**Direction (not an implementation).** Apply the same SELECT ... FOR UPDATE + lock_timeout pattern the DELETE handler uses to the upload route's status read (the project's own probes already established the mechanism works under RLS), or register the asymmetry with a pick-up trigger.

**Verification: CONFIRMED.** The upload route's O-24 check is a plain unlocked read while the DELETE handler for the same invariant uses FOR UPDATE + lock_timeout and documents this exact race; completeAssessment takes no lock either, withOrg runs at default READ COMMITTED with no isolationLevel, no DB trigger/CHECK enforces frozen-after-completion, and Postgres FK locking (FOR KEY SHARE vs FOR NO KEY UPDATE) provides no accidental serialization — so a completion committing between the status read and the evidence insert lands evidence on a completed assessment. The asymmetry is genuinely unregistered (D-130's note credits Task 7 with fixing the delete side only; no upload-race/TOCTOU row exists) and evidence-upload.test.ts has no concurrency test. The compounding impact is verified: DELETE refuses on completed assessments so the slipped row is permanent, and the PDF route reads evidence fresh per render so it enters the auditor-facing manifest. High is correct: narrow window and privileged actors keep it out of Critical, but it permanently corrupts the frozen evidence set the product's core O-24 promise rests on.

*Verifier evidence:* app/api/v1/orgs/[slug]/assessments/[id]/evidence/route.ts:168,187 (plain findUnique + completed check, no lock) vs app/api/v1/orgs/[slug]/evidence/[evidenceId]/route.ts:274-276,286 (FOR UPDATE; delete refused on completed); lib/data/assessments.ts:143-176 (unlocked completeAssessment); lib/data/tenant.ts:209 ($transaction, no isolationLevel); grep of prisma/migrations for triggers/CHECKs on completed status (only evidence_attach_target_check); grep -i toctou docs/DEFERRED_REGISTER.md (only D-111 registration race; D-130 note names the delete-side fix only); test-name listing of __tests__/integration/evidence-upload.test.ts (no concurrency test); reports/[id]/pdf/route.ts:124 (manifest reads evidence fresh)

### EV-2 [High] The immutability promise's documented escape hatch — 'deleting the assessment, which is visible' — is implemented as an unlogged whole-project cascade
*app/api/v1/orgs/[slug]/projects/[id]/route.ts:137* — sweep confidence: confirmed

**Claim.** Spec §5.1 justifies the frozen-evidence design by saying post-completion removal 'requires deleting the assessment, which is visible'. Neither half is true in the implementation: there is no assessment DELETE route at all (assessment:delete is granted but consulted by no route — D-181), and the actual path — project DELETE — cascades every assessment, evidence row and blob with no completion check, no logSecurityEvent call, and no PROJECT_DELETED event type existing anywhere, while a single row-level evidence delete IS logged (EVIDENCE_DELETED).

**Evidence.** docs/superpowers/specs/2026-08-06-phase1c-evidence-and-pinning-design.md:326 'Removing evidence afterwards requires deleting the assessment, which is visible.' app/api/v1/orgs/[slug]/projects/[id]/route.ts:136-138: requireOrgContext then 'await withOrg(ctx, (tx) => tx.project.delete({ where: { id } }));' — grep logSecurityEvent in that file exits 1; grep PROJECT_DELETED/ASSESSMENT_DELETED repo-wide exits 1. Cascade chain: schema.prisma:124,344 (project→assessment→evidence onDelete: Cascade), evidence_blobs FK ON DELETE CASCADE. D-105 (no tenant audit trail) is Open, targeted Phase 1d.

**Impact.** An owner or admin can destroy a completed assessment's entire frozen evidence set (and its blobs) in one unlogged request — the exact 'evidence quietly disappears after review' scenario O-24, the FOR UPDATE work, and the no-UPDATE grant were all built to prevent. The row-level controls are stronger than the container-level ones by orders of magnitude, and the spec's visibility claim has no implementing mechanism.

**Direction (not an implementation).** At minimum log project deletion with the ids/counts of completed assessments and evidence destroyed; consider refusing (or requiring a distinct confirmation/action for) project deletion while it contains completed assessments, and register the §5.1 promise-vs-implementation gap.

**Verification: CONFIRMED.** Every factual leg checks out: spec §5.1's escape-hatch sentence exists verbatim; no assessment DELETE route exists anywhere (assessment:delete appears only in policy.ts, matching D-181); the actual removal path is projects/[id] DELETE — owner/admin, bare tx.project.delete with no completion check — in a file that never imports logSecurityEvent; the SecurityEvent union contains no PROJECT_DELETED or ASSESSMENT_DELETED; and the cascade chain project→assessment→evidence→blob is fully ON DELETE Cascade in the schema. I could not rescue it via other layers: proxy.ts logs only token/rate-limit events, and while D-105 (Open, Phase 1d) generically covers the missing tenant audit trail — which the auditor already cited — no register row records the missing completion check or the §5.1 promise-vs-implementation divergence. The inversion is real: one evidence row's deletion is logged at warn while an unlogged single request destroys a completed assessment's entire frozen evidence set. High is right — privileged-actor auditability gap, not a tenancy/security break, so not Critical.

*Verifier evidence:* docs/superpowers/specs/2026-08-06-phase1c-evidence-and-pinning-design.md:326 ('Removing evidence afterwards requires deleting the assessment, which is visible'); app/api/v1/orgs/[slug]/projects/[id]/route.ts:130-145 (no completion check, no logSecurityEvent import); lib/security-logger.ts SecurityEvent union (EVIDENCE_DELETED present, no PROJECT_DELETED/ASSESSMENT_DELETED; repo grep for those strings in app/lib/__tests__ returns nothing); prisma/schema.prisma:124,344,403 (cascade chain); repo-wide list of 'export async function DELETE' (no assessment route); docs/DEFERRED_REGISTER.md D-181 (orphaned assessment:delete grant) and D-105 (Open, Phase 1d); proxy.ts:136,173 (only token/rate-limit logging)

### EV-3 [Medium] The credibility-tier model is effectively absent: a two-value derived enum that no UI displays and whose upgraded state no UI can reach
*prisma/schema.prisma:50* — sweep confidence: confirmed

**Claim.** VISION_AND_PLAN.md promises an assessment-level four-tier ladder (self-attested → evidenced → peer-reviewed → independently-verified) and lists 'evidence attachment + credibility tiers' in Phase 1. What exists: a per-RemediationItem EvidenceLevel with exactly two values, derived on read from evidence count. No assessment-level tier exists anywhere; no UI component reads evidenceLevel; and since no UI attaches evidence to remediation items (uploads are hard-coded to questionId), artifact_uploaded is reachable only via direct API calls. Question-attached evidence — the only UI-reachable attach — feeds no tier, score, or report field.

**Evidence.** docs/VISION_AND_PLAN.md:30 'Each assessment has a credibility tier: self-attested → evidenced → peer-reviewed → independently-verified' and :134 'evidence attachment + credibility tiers' under Phase 1. grep -rn -i 'credib' across prisma/lib/app/components: zero hits. grep evidenceLevel in app/components *.tsx excluding api: zero hits. grep remediationItemId in components/app tsx: only a comment (AssessmentPageClient.tsx:32); handleEvidenceUpload sets only questionId (AssessmentPageClient.tsx: formData.set('questionId', qId)). schema.prisma:50-53 enum EvidenceLevel { self_attestation artifact_uploaded }.

**Impact.** The 'structural answer to box-ticking' the vision names as mechanism #1 is, after the evidence phase shipped, an invisible field: a team can upload evidence everywhere and nothing they or an external reader sees changes tier. The gap between 'evidence attach exists' and 'credibility tiers exist' is the product's own core differentiator, and it is not tracked as a register row under that framing (verification tiers appear only as a Phase 4 line item).

**Direction (not an implementation).** Either surface the derived level in the UI/report and add the assessment-level tier as designed, or explicitly re-scope the Phase 1 'credibility tiers' promise in the vision doc/register so the gap is a decision rather than a silent shortfall.

### EV-4 [Medium] Spec §4.3's HTML-report per-finding evidence list was dropped between spec and plan with no register row
*app/(authenticated)/orgs/[slug]/assessment/[id]/report/page.tsx:166* — sweep confidence: confirmed

**Claim.** The design spec's report-surfaces table promises the HTML report shows a 'Per-finding evidence list, downloadable'. The PDF manifest half was built (O-16); the HTML half was never a plan task and is not implemented — the report page renders no uploaded evidence (its 'evidence'-named variables are the legacy findings naming). No DEFERRED_REGISTER row records the drop, violating the project's own §6 rule that every conscious not-do gets a same-commit row.

**Evidence.** docs/superpowers/specs/2026-08-06-phase1c-evidence-and-pinning-design.md:304-306 table: 'HTML report | Per-finding evidence list, downloadable'. Plan file list (docs/superpowers/plans/2026-08-06-phase1c-evidence-and-pinning.md:39-46) contains only the useFindingsData rename for report components. grep -i evidence in app/(authenticated)/orgs/[slug]/assessment/[id]/report/page.tsx: only gapEvidence/attentionEvidence/strengthEvidence findings variables. grep register for 'per-finding'/'4.3'/'downloadable': no row.

**Impact.** A reviewer reading the completed HTML report cannot see or download the evidence backing it — they must know to go back to the assessment page. More importantly for process health: an auditor comparing spec to implementation finds an unexplained divergence on the product's reviewing surface, exactly the laundered-omission shape AGENTS.md §6 warns about.

**Direction (not an implementation).** Open a register row (or implement the list); decide deliberately whether the HTML report should match the PDF manifest.

### EV-5 [Medium] No storage quota at any level: one authenticated user can durably grow the database ~144 GB/day within the rate limit
*lib/rate-limit.ts:69* — sweep confidence: confirmed

**Claim.** The only bounds on evidence storage are 10 MiB per file and 10 uploads/min/user; there is no per-org, per-assessment, or global byte quota, and the dedup key only stops identical bytes on the identical claim. D-152 explicitly covers only transient request-buffering memory, not durable growth; 'quota' appears nowhere in the register.

**Evidence.** lib/rate-limit.ts:69 'POST:/api/v1/orgs/*/assessments/*/evidence': { window: 60 * 1000, max: 10, keyBy: 'userId' }; lib/evidence/inspect.ts:10 MAX_BYTES = 10 MiB → 10 × 10 MiB/min ≈ 144 GB/day/user. grep -c -i 'quota' docs/DEFERRED_REGISTER.md → 0. D-152's row text scopes itself to 'memory pressure from buffering an oversized body before rejection'.

**Impact.** On the intended VPS deployment (hosting D-018 pending) the bytes live inside Postgres, so unbounded growth fills the database volume, degrades every pg_dump (spec §5.5 flags backup sensitivity but not size), and can take the whole platform down — reachable by any member of any org with evidence:create, or simply by an enthusiastic legitimate team. The in-memory rate-limit store also resets on every restart, weakening even the per-minute bound.

**Direction (not an implementation).** Add a per-org (and/or per-assessment) stored-bytes quota checked inside the upload transaction, and register the durable-growth risk distinctly from D-152.

### EV-6 [Low] Client displays MAX_UPLOAD_BYTES but never checks file.size before uploading
*components/evidence/EvidenceAttach.tsx:169* — sweep confidence: confirmed

**Claim.** EvidenceAttach shows 'Max size 10.0 MB' and exports MAX_UPLOAD_BYTES with a coupling test pinning it to the server's MAX_BYTES, yet handleFileChange forwards any picked file without a size check — an oversized file is fully uploaded by the browser before the server's Content-Length 413 comes back.

**Evidence.** components/evidence/EvidenceAttach.tsx:169-176 handleFileChange has no size check; grep 'file.size' in the file exits 1; the constant is used only in the visible copy (line 318) and the coupling test (evidence-attach.test.tsx:100-102).

**Impact.** On the low-bandwidth campus connections this product explicitly targets, a user picking a 200 MB dataset waits through the whole upload to learn it was never acceptable — the one client-side check the component already has the constant in scope for.

**Direction (not an implementation).** Reject file.size > MAX_UPLOAD_BYTES in handleFileChange with the same message the server would give.

### EV-7 [Low] createEvidence hashes up to 10 MiB inside the withOrg transaction, contradicting the codebase's own stated rule
*lib/data/evidence.ts:31* — sweep confidence: confirmed

**Claim.** The download route and framework.ts both document moving CPU work (hashing, disk reads) outside withOrg because it holds one of only 10 pooled connections; the upload path computes sha256 over the full buffer as the first statement inside the withOrg callback via createEvidence.

**Evidence.** lib/data/evidence.ts:31 'const sha256 = createHash(...).update(input.content)...' called from the upload route inside withOrg (route.ts:151,241-254); contrast evidence/[evidenceId]/route.ts:126-129 'let the transaction close before hashing -- ... holding one of only 10 pooled connections for a CPU-bound operation ... is an avoidable hold' and lib/data/evidence.ts:133-137's own no-sync-work-in-withOrg reasoning.

**Impact.** Milliseconds per upload, so negligible today — but it is the same inconsistency class the project's own C4 lens exists to catch: a rule stated in two modules and silently not applied in a third. The hash could be computed alongside inspect(), outside the transaction.

**Direction (not an implementation).** Hash next to inspect() before entering withOrg and pass the digest in, matching the codebase's stated discipline.

**Not examined by this auditor:**
- Running the vitest integration suites or e2e specs live — They require and mutate a database; audit is read-only and the claims reported rest on code/test-source reading with the project's own documented live probes as corroboration
- Full bodies of evidence-attach.test.tsx (471 lines) and the middle sections of evidence-upload/download integration tests — Read test names, fixtures and the assertions relevant to findings; exhaustive line-by-line reading traded for register cross-checking
- lib/pdf/ReportPdf.tsx manifest rendering and sanitizeManifestText — Belongs to the reports/PDF audit dimension; only its wiring from the evidence table was checked
- e2e/role-matrix.spec.ts EVIDENCE_CONTROLS presence-mode assertions — E2E/authz coverage is another auditor's dimension; the component's presence-vs-disabled claim was verified in source instead
- lib/security-logger.ts internals and toResponse error-class mapping — Cross-cutting infrastructure outside this dimension; only their call patterns from evidence routes were assessed
- Behaviour of Next.js req.formData() under chunked encoding (the D-152 scenario) verified live — Would require running the server; the register row itself documents the live confirmation

## framework-versioning

The pinning core is genuinely well built: a hash-of-bytes registry populated by migration, a DB-enforced write-once pin, SELECT-only grants proven live, four fail-closed drift guards pinned by a grep-based enumeration test, and the registered hash independently recomputes to the checked-out content. But the design is one-sided: every enforcement is a refusal, and the refusals never reach the user — the assessment page silently drops answers on drift 409s and the completion flow bounces through a redirect loop. Publishing a new version is not designed as an operation (no tooling, no runbook, no admin surface), and any first upgrade will permanently strand all in-progress assessments platform-wide because pinned content is not retained anywhere. Most gaps are honestly recorded in the register (D-147/D-167/D-175), but the client-silence finding shows D-167's premise ("the 409 explains why") is false in practice.

**Sound (what is genuinely good):**
- Hash integrity verified end-to-end: independently recomputing computeBundleHash's algorithm over the checked-out data/*.json yields exactly the migration's registered hash 7c343b7d… (command run in this audit).
- No-fallback resolution discipline is consistent: resolvePublishedVersion throws rather than defaulting (lib/data/framework.ts:106-112), creation refuses to pin drifted content (assessments/route.ts:84-85), and all four O-14 guard sites are mechanically enumerated by trigger-enumeration.test.ts:221-280 grepping the exact guard idiom.
- Write-once pin is database-enforced (trg_assessments_framework_version_write_once, migration 20260807102031:63-77) and non-vacuously tested — the test deliberately targets a second real FK row so only the trigger can reject (framework-registry.test.ts:78-152).
- Least privilege is proven two ways: catalog introspection (SELECT only) plus live role-boundary tests where appClient's INSERT/UPDATE/DELETE each fail with permission denied (framework-registry.test.ts:181-236).
- BUNDLE_FILES completeness is generated-not-trusted: a disk enumeration diff runs on every test run (framework-hash.test.ts:55-64), with a documented ruling on why runtime auto-generation was rejected.
- ADR-0003 is an unusually honest record — it names its own negative consequences (no concept of 'current', content stays in files, no in-place correction) and cites the register rows tracking each.
- Drift banner copy is scoped per surface ('cached-only' vs 'live-findings') with a required parameter so a new surface cannot inherit a false claim (lib/report/provenance.ts:130-184), and the scope literals are pinned by trigger-enumeration.test.ts:322-325.

### FV-1 [High] Drift 409s on autosave and completion are never surfaced — silent permanent loss of in-flight answers
*app/(authenticated)/orgs/[slug]/assessment/[id]/AssessmentPageClient.tsx:327* — sweep confidence: confirmed

**Claim.** The server's fail-closed drift guards (PATCH → 'drifted' 409, POST /complete → 'drifted' 409) are invisible to the user: the assessment page's autosave never checks res.ok and swallows everything, and the completion handler ignores the response and navigates to the report page, which redirects any non-completed assessment straight back — a loop with no message. The GET even returns framework.matches to this exact page and the client never reads it.

**Evidence.** AssessmentPageClient.tsx:321-330 — `await fetch(apiBase, {method:'PATCH',…})` with `catch { // Auto-save failures are silent — user can retry }` and no res.ok check (a 409 resolves, so not even the catch fires); lines 599-612 — `// Continue to report even if API call fails` then `router.push(...report)`; report/page.tsx:60-63 redirects non-completed back. `grep -n "framework\|matches\|drift" AssessmentPageClient.tsx` exits 1 (zero hits). Contrast: evidence mutations DO check res.ok (AssessmentPageClient.tsx:511,538), so only the two answer-writing paths are silent.

**Impact.** Under any drift (content edited without a registry row, or a future version upgrade) a user keeps answering for a whole session while every save is rejected; all of it is lost with no indication, and 'Complete' bounces them in a redirect loop. D-167 records the no-remedy half but is premised on 'the 409 explains WHY' — the explanation never reaches a user. Also broader: ANY autosave failure (expired session, network) is equally silent.

**Direction (not an implementation).** Read the drift flag the GET already delivers (framework.matches) to gate the page with a banner, and make autosave/complete check res.ok and surface the server's already-written 409 messages. Not live-verified in a browser (read-only audit), but the code path is unambiguous.

**Verification: CONFIRMED.** Every element re-verified directly: the autosave PATCH never checks res.ok and its empty catch cannot even fire on a 409 (fetch resolves on 4xx); the completion handler ignores both responses and navigates to the report page, which redirects any non-completed assessment straight back with no message; the GET delivers framework.matches to this client and my grep for framework/matches/drift in the file exits 1; evidence mutations DO check res.ok, proving the answer-writing paths are uniquely silent. Kill attempts failed: no e2e test covers drift UX (the sole 'drift' hit in e2e/assessment-flow.spec.ts:202 is an unrelated comment), the only drift UI is the completed-report banner, no register row records the client silence, and D-167's premise 'the 409 explains WHY' is demonstrably false at the client. High is warranted because the same code silently swallows ALL save failures (network, expired session), which is reachable today in a data-entry product — silent loss of user answers is concrete user impact.

*Verifier evidence:* AssessmentPageClient.tsx:318-331 (PATCH, no res.ok, empty catch), :592-613 (complete handler, bare catch, unconditional router.push), :511/:538 (evidence paths check res.ok); report/page.tsx:60-63 (redirect back); app/api/v1/orgs/[slug]/assessments/[id]/route.ts:62-65 (GET returns framework.matches), :101-116 (drifted 409 with message); grep -n 'framework\|matches\|drift' AssessmentPageClient.tsx → exit 1; grep drift e2e/assessment-flow.spec.ts → only a DOM-polling comment at :202; DEFERRED_REGISTER.md D-167 ('the 409 explains WHY').

### FV-2 [High] Any framework version upgrade permanently strands every in-progress assessment, platform-wide
*lib/data/assessments.ts:85* — sweep confidence: confirmed

**Claim.** When content changes and a new version is published, every in-progress assessment's pinned contentHash no longer equals RUNNING_BUNDLE_HASH, so PATCH, complete, and evidence upload all return 409 forever. The write-once trigger forecloses re-pinning, and the registry stores only a hash — the pinned content itself is retained nowhere at runtime, so the system cannot serve or score against the old version. Upgrade delivers refusal, not continuity.

**Evidence.** lib/data/assessments.ts:85 `if (!resolution.matches) return { kind: 'drifted' }` (and :162 for complete); migration 20260807102031:63-77 write-once trigger; framework_versions columns are id/semver/contentHash/publishedAt/status only (migration :8-17) — no content. D-167: 'the only paths back to answerable are entirely OPERATIONAL'. D-138 defers content-as-rows to Plan 2a.

**Impact.** The first real content update in this product's life will freeze all in-flight work in every org with (per FV-1) zero user-visible explanation. The choice of refusal-over-corruption is deliberate and defensible for pre-upgrade defects, but no upgrade has been rehearsed, and the design has no story — even a documented manual one — for migrating in-flight assessments forward or letting them finish against their pinned version.

**Direction (not an implementation).** Before the first content change ships: either complete-against-pinned (needs pinned content retained, i.e. Plan 2a) or a documented operational migration path for in-progress assessments, plus FV-1's user-facing surfacing.

**Verification: CONFIRMED.** The stranding mechanism is airtight on my own reads: drift is defined as pinned contentHash === RUNNING_BUNDLE_HASH (module-load hash of deployed content, framework.ts:119,171-173), so publishing changed content makes every in-progress assessment's PATCH (assessments.ts:85), complete (:162), and evidence upload (evidence/route.ts:209) return drifted 409 forever; the DB trigger forecloses re-pinning; the registry stores only a hash (no content column in schema.prisma:194-204 or the migration, and my grep found no snapshot/retention mechanism anywhere), so the system cannot serve or score the pinned version. D-167 itself confirms recovery is purely operational (revert content or abandon the assessment) — the register documents the gap without mitigating it, and the auditor already weighed that. High rather than Critical is right: refusal-over-corruption is deliberate and register-tracked, the state is unreachable until D-018 hosting closes, and completed assessments keep their cached reportData intact.

*Verifier evidence:* lib/data/framework.ts:119 (RUNNING_BUNDLE_HASH at module load), :171-173 (toResolution match rule); lib/data/assessments.ts:85 and :162 ({ kind: 'drifted' }); app/api/v1/orgs/[slug]/assessments/[id]/evidence/route.ts:209; prisma/migrations/20260807102031_framework_registry_and_pin/migration.sql:8-17 (columns, no content) and :59-77 (write-once trigger); prisma/schema.prisma:194-204; grep for contentJson/bundleContent/snapshot → no retention mechanism; DEFERRED_REGISTER.md D-167 ('the only paths back to answerable are entirely OPERATIONAL').

### FV-3 [High] Publishing a new framework version is an undesigned, untooled, undocumented operation
*docs/runbooks/deployment.md* — sweep confidence: confirmed

**Claim.** The only way content enters the registry is a hand-written migration containing a hand-computed hash (seed.ts plays no role — zero framework references; the migration header says registry rows belong in migrations). There is no admin surface (makrai_app is SELECT-only by design), no script to compute the bundle hash, and no runbook: docs/runbooks/{deployment,troubleshooting,backup-restore}.md contain zero mentions of 'framework'. The required pairing — bump meta.version in TWO files, compute hash, write migration, deploy atomically — is enforced by nothing and recorded nowhere an operator would look.

**Evidence.** `grep -n -i framework docs/runbooks/*.md` → no output; package.json scripts (lines 11-31) contain no hash/publish tooling; `grep -n framework prisma/seed.ts` → no output; ADR-0003:47-48 'populated by migration, not by application code'; register D-147 (open, RISK): 'every future meta.version bump must remember to ship a paired migration… nothing forces that pairing'.

**Impact.** The upgrade knowledge lives only in code comments, an ADR, and a register row. An operator publishing v3.1.0 must reverse-engineer the procedure from lib/framework/bundleHash.ts and a prior migration; a wrong hash bricks assessment creation platform-wide (409 on every POST) — loudly, at least, but with recovery requiring another migration. D-147 records the risk honestly, but the runbook gap is an additional, unrecorded deficiency: the runbooks directory exists and covers deployment yet omits the one operation unique to this product.

**Direction (not an implementation).** A `scripts/publish-framework-version` generator (compute hash, emit migration skeleton, assert both meta.versions agree) plus a runbook page would convert D-147's prose risk into mechanism — the project's own stated doctrine (§0.4).

**Verification: CONFIRMED.** All cited absences reproduce under my own commands: zero 'framework' mentions in any runbook (grep exit 1, though deployment/troubleshooting/backup-restore runbooks exist), zero in prisma/seed.ts, no publish/hash tooling in scripts/ (only pen-test.mjs and provision-app-db-role.sh) or package.json scripts, and bundleHash.ts is a bare library with no CLI entry point. ADR-0003 confirms the registry is populated only by hand-written migration and that a bad published hash requires another migration to fix. My kill attempt — searching all of docs/ for any operator-followable publish procedure — found only the ADR (decisions, not steps), the register, and a superseded design doc. High severity stands: D-147 (Open, RISK) itself was amended to say any byte-level content change (even a formatter run) now bricks assessment creation platform-wide via the creation-time guard (assessments/route.ts:84-85), 'raising its priority', and the runbook omission is additionally unrecorded in the register.

*Verifier evidence:* grep -in framework docs/runbooks/*.md → exit 1; grep -in framework prisma/seed.ts → exit 1; ls scripts/ → pen-test.mjs, provision-app-db-role.sh only; package.json:11-31 (no hash/publish script); lib/framework/bundleHash.ts (library only, no CLI); docs/adr/0003:46-48 ('populated by migration, not by application code') and ~:151 ('needs a new migration to correct it'); app/api/v1/orgs/[slug]/assessments/route.ts:84-85 (creation drift guard); DEFERRED_REGISTER.md:196 D-147 (Open, 'product-wide creation outage triggerable by a formatter').

### FV-4 [Medium] The pin is metadata-only: a completed report's largest sections are rebuilt from today's content, not the pinned version
*components/report/useFindingsData.ts:4* — sweep confidence: confirmed

**Claim.** 'Truly pinned' holds for scores and the provenance line only. The HTML report rebuilds gaps/attentions/strengths/not-assessed and per-principle question lists from static imports of today's questionBank.json and assessmentAreas.json on every view, keyed only on report/engineState — never the pin. Since old content is not retained (FV-2), a report viewed after an upgrade shows old scores beside findings computed from new content.

**Evidence.** components/report/useFindingsData.ts:4-5 static imports; lib/report/provenance.ts:104-113 documents exactly this ('rebuilds… inside a useMemo keyed only on report/engineState, never on the pin'); register D-175 records it as RISK; D-175/provenance.ts:159-163 record the snapshot-at-completion alternative as deliberately deferred to Plan 2a.

**Impact.** An ISO 42001 auditor reading a drifted report gets accurate scores, an honest banner, and findings that may name questions the assessed team never saw. Disclosed honestly in the banner copy (good), but it narrows the product's core provenance promise to numbers-plus-hash, and the gap will become user-visible at the first content change.

**Direction (not an implementation).** D-175's own alternative (snapshot findings inputs into reportData at completion) is the fix; confirm Plan 2a actually carries it rather than only content-as-rows.

### FV-5 [Medium] Version identity belongs to one file's field, while half the hashed bundle is versionless
*lib/framework/bundleHash.ts:18* — sweep confidence: confirmed

**Claim.** The 'framework version' is data/assessmentAreas.json's meta.version (questionBank.json test-asserted to agree), but projectConfig.json and scoringConfig.json — both hashed into the bundle — carry no meta at all. A scoring-weight-only change alters the hash and therefore drifts the platform, yet the semantically honest response (bump the version) requires editing two OTHER files whose content did not change. The version is not a property of the bundle it names.

**Evidence.** framework-current-version.test.ts:67-70 (verified live in-comment: projectConfig/scoringConfig have no meta field, 'false false'); bundleHash.ts:18-23 hashes all four; lib/data/framework.ts:71-77 reads only assessmentAreas.meta.version. The agreement guard runs only under vitest and 'this repository has no CI' (framework-current-version.test.ts:110-113, D-146).

**Impact.** Every content-adjacent edit — even reformatting (bytes-hashed by design) or a scoring tweak — forces the full version-publication ceremony of FV-3, and the two-file version agreement plus registry pairing is guarded only by tests no CI runs. The friction invites exactly the edit-without-bump mistake the drift guards then punish platform-wide.

**Direction (not an implementation).** When Plan 2a designs content-as-rows, give the bundle (not one member file) the version identity; until then a single meta location or a generated manifest would remove the two-file agreement obligation.

### FV-6 [Medium] Standards crosswalk has no structural trace, and the AU Continental AI Strategy — a locked anchor standard — appears exactly once in all content
*data/assessmentAreas.json:860* — sweep confidence: confirmed

**Claim.** The vision's crosswalk (areas/controls mapped to ISO 42001 + AU strategy + UNESCO EIA, named at VISION_AND_PLAN.md:56,117,146) exists nowhere in schema or structured content. What exists is prose: free-text 'citation' strings inside scoringConfig.json items and resource links in assessmentAreas.json. Across all four content files, the AU Continental AI Strategy appears once (one resource link) while UNESCO appears dozens of times and uncited standards (EU AI Act, NIST AI RMF) appear repeatedly in citations.

**Evidence.** `grep -in "african\|continental" data/*.json` → exactly one hit (assessmentAreas.json:860-861); scoringConfig.json:90,110,132,142,152 cite EU AI Act/NIST/ISO/UNESCO as prose strings; `grep -i crosswalk prisma/schema.prisma` → no hits; vision line 117 says the crosswalk 'become[s] versioned records'.

**Impact.** Phase 4 owns the crosswalk, so absence of implementation is scheduled, not a defect — but there is no design preparation either (the FrameworkVersion registry hashes opaque files and could carry a crosswalk only as another content file), and the content's standards weighting contradicts the locked decision: a product claiming alignment 'to the AU Continental AI Strategy' currently grounds that claim in a single hyperlink. Prose citations are also unversioned free text a crosswalk cannot be machine-derived from.

**Direction (not an implementation).** At minimum, record the AU-strategy content asymmetry as its own register row so Plan 2a's content-model design treats crosswalk-as-structured-data (and AU coverage) as an input, not a Phase 4 surprise.

### FV-7 [Low] Institution-level customization (Phase 3) is unrepresentable in the current shape — deliberately, but with one durable constraint worth noting
*lib/data/framework.ts:119* — sweep confidence: confirmed

**Claim.** The architecture is a deployment-global singleton: one content bundle per process (RUNNING_BUNDLE_HASH is a module-load const, lib/data/framework.ts:119), semver globally UNIQUE, 'current' defined as exact string match between a deployed file and a registry row. Per-org framework extension cannot be expressed. This is a known, ruled deferral (D-137/D-138 push the content model to Plan 2a precisely to avoid foreclosing the domain axis), so it is not a trap — but the registry's globally-unique semver, the status CHECK constraint, and every resolver's org-blind lookup will all need migration, and the ADR does not name Phase 3 customization among the pressures Plan 2a must design for.

**Evidence.** migration 20260807102031:10 `"semver" TEXT NOT NULL UNIQUE`; lib/data/framework.ts:102-104 `findFirst({ where: { semver, status: 'published' } })` — no org dimension; ADR-0003:134-147 names the 'no current' and content-in-files consequences but not per-org extension; VISION_AND_PLAN.md Phase 3: 'framework customization + governance (institutions extend, contribute back)'.

**Impact.** Low today: Plan 2a precedes Phase 3 and the assessment-side pin (FK + write-once, ON UPDATE CASCADE) survives any registry restructuring cleanly. The risk is only that Plan 2a designs content-as-rows against the domain axis alone and rediscovers the org axis at Phase 3.

**Direction (not an implementation).** Add Phase 3 customization to the named inputs of Plan 2a's content-model design (a one-line edit to D-137/D-138's scope notes).

### FV-8 [Low] Drift is detected only lazily at request time; nothing checks deployment health proactively
*lib/data/framework.ts:155* — sweep confidence: confirmed

**Claim.** The only runtime comparison of deployed bundle to registry happens inside user-triggered requests (creation, PATCH, complete, evidence, report GET). A deploy whose content silently drifted (the exact operator mistake D-147 predicts) manifests as scattered 409s to end users rather than a failed health check or startup assertion, and the one test that would catch it pre-deploy runs under no CI (D-146).

**Evidence.** All resolveFramework/resolveCurrentFramework callers are request handlers (grep across app/ lib/ in this audit); no startup or health-check site compares computeBundleHash() to the published row for readCurrentContentVersion(); framework-current-version.test.ts:108-113 records the no-CI limit in its own comment.

**Impact.** The first person to learn a deployment is drifted is a user hitting a 409 (which, per FV-1, they mostly cannot even see) — not an operator. Time-to-detection for a bricked platform is unbounded.

**Direction (not an implementation).** A /healthz-style check (or a startup log line) asserting resolveCurrentFramework().matches would surface the drifted state at deploy time, cheaply.

### FV-9 [Low] Test helper name claims content drift but mutates the registry instead
*__tests__/helpers/db.ts:96* — sweep confidence: confirmed

**Claim.** withDriftedFrameworkContent produces a mismatch by overwriting the registry row's contentHash with 'f'.repeat(64) via the superuser client — the framework CONTENT is never drifted. Equivalent for exercising the comparison (both sides of one equality), but the name asserts the direction the production failure would actually take, and the direction where module-load hash caching (RUNNING_BUNDLE_HASH computed once) is untestable is exactly the one the suite therefore never exercises.

**Evidence.** __tests__/helpers/db.ts:96-113 — `update({ where: { id: SEEDED_FRAMEWORK_VERSION_ID }, data: { contentHash: 'f'.repeat(64) } })`; lib/data/framework.ts:119 computes RUNNING_BUNDLE_HASH once at module load, which is why the content side cannot be mutated under test.

**Impact.** Minor: the comparison is symmetric so coverage is real, but a reader of test names would believe content-side drift (edit file, restart, observe 409) has been exercised when it has not — including the module-load-caching behaviour itself.

**Direction (not an implementation).** Rename to withMismatchedRegistryHash, or add one test that calls computeBundleHash(tempDirWithEditedCopy) to exercise the content side directly.

**Not examined by this auditor:**
- Live browser verification of FV-1 (typing answers under a forced drift and observing silent loss) — Read-only audit — forcing drift requires mutating the registry or content; the code path (no res.ok check, empty catch) is unambiguous from source
- __tests__/integration/report-provenance.test.ts and lib/pdf/ReportPdf.tsx in full — Capacity; the provenance module's own comments plus trigger-enumeration.test.ts's literal-pinning of both surfaces cover the load-bearing claims I relied on
- Playwright e2e suite's coverage of drift/pinning flows — Capacity; would sharpen FV-1's severity (an e2e test asserting drift UX would contradict it) but no such test surfaced in the integration-layer greps
- The .next/standalone tracing behaviour and D-149 .env-leak claims in bundleHash.ts's comments — Requires running builds; adjacent to this dimension (build hygiene, not pinning) and already register-tracked
- docs/superpowers/specs/2026-08-06-phase1c-evidence-and-pinning-design.md (the design spec itself) — Capacity; its load-bearing decisions are restated in ADR-0003 and the register rows I did read
- engine files (AssessmentEngine.js/QuickAssessment.js) static-import scoring paths beyond what callers' comments state — Capacity; the claim that scoring uses deployed content is corroborated independently by three separate call-site comments and useFindingsData's imports

## gates-runner

Six of seven gates are green: node matches .nvmrc, tsc --noEmit is clean (even non-incremental), the full vitest suite passes 1579/1579 in ~52s with zero warnings, next build succeeds with its own TS pass, and playwright collects 49 tests in 9 files. One gate was RED as found: npm run lint failed with 1 error caused solely by untracked residue app/__effective_config_probe.ts — a probe file that __tests__/lint/effective-config.test.ts writes and deletes in a finally block, left behind by a previously interrupted run. Running the mandated npm test overwrote and then deleted that residue, so the lint gate self-healed mid-audit as a side effect; the tracked codebase itself lints clean (eslint exits 0 with the probe ignored). The final tree is empty-clean — cleaner than at session start, a working-tree mutation caused by the test suite's own cleanup, not by the auditor.

**Sound (what is genuinely good):**
- Test suite health: 53/53 files, 1579/1579 tests, 0 skipped, reproducible across two consecutive runs (51.46s and 51.83s), and a full-log grep for warn/deprecat/skip/stderr found zero lines.
- Typecheck is genuinely clean: exit 0 both incrementally (2.4s) and with --incremental false (5.1s), so the green is not a stale tsbuildinfo artifact.
- Build is clean: Next.js 16.2.9 Turbopack, compiled 6.8s, its own TypeScript pass finished in 5.5s, 21/21 static pages generated, exit 0; postbuild strips .env* from the standalone output (a deliberate secrets-hygiene step).
- The lint meta-test that produced the residue is well-intentioned design: __tests__/lint/effective-config.test.ts pins the RESOLVED eslint config per file and verifies end-to-end that a real violation is actually flagged — only its probe mechanism is fragile, not its intent.
- Node version discipline holds: v22.22.3 against .nvmrc '22'.
- Playwright collection is healthy (exit 0, 49 tests in 9 files) without touching the dev database.

### QG-1 [Medium] npm run lint gate RED as found: untracked probe residue fails no-restricted-imports
*app/__effective_config_probe.ts:1* — sweep confidence: confirmed

**Claim.** At audit start `npm run lint` failed with exactly 1 error: app/__effective_config_probe.ts 1:10 "'auth' import from '@/lib/auth' is restricted... Use requireIdentity() from lib/auth/identity.ts. See ADR-0002" (no-restricted-imports). The file was untracked residue (listed as `??` in git status at session start), byte-identical to what __tests__/lint/effective-config.test.ts:128 writes. The tracked codebase is clean: `npx eslint . --ignore-pattern 'app/__effective_config_probe.ts'` exits 0.

**Evidence.** Command `npm run lint` output: "app/__effective_config_probe.ts 1:10 error 'auth' import from '@/lib/auth' is restricted ... no-restricted-imports — ✖ 1 problem (1 error, 0 warnings)". Isolation: `npx eslint . --ignore-pattern 'app/__effective_config_probe.ts'` → EXIT:0. File content read before deletion matched effective-config.test.ts:128 exactly: "import { auth } from '@/lib/auth';\nexport const x = auth;\n".

**Impact.** Any operator or CI running `npm run lint` or `npm run verify` (lint && test && build, package.json:29) on the tree as it stood got a red gate on code that is not part of the codebase. Per this project's own C4 rule, untracked residue is itself a finding — the residue also proves a prior vitest run was interrupted mid-test without anyone noticing or recording it. NOTE: the gate is green NOW only because running `npm test` during this audit overwrote and then unlinked the residue (effective-config.test.ts:138) — a side effect, not a fix; the audit did not edit anything.

**Direction (not an implementation).** Treat the residue class, not the instance (it self-deleted): see QG-2 for the mechanism fix; additionally, consider a lint ignore or pre-lint guard for the probe path so leftover residue can never redden the gate.

**Verification: OVERSTATED (severity corrected to Medium).** The factual core survives every kill attempt: the probe mechanism exists exactly as cited (fixed path in app/, deliberate lint violation, cleanup only in a finally block), and I reproduced the counterfactual myself — eslint on that exact probe content fails with the identical error message, rule, and position the auditor quoted, while the tracked tree lints clean (exit 0) and no ignore entry protects the path. But the impact is inflated: the claim that 'any operator or CI' got a red gate is half wrong, because CI does a fresh actions/checkout@v4 on an ephemeral runner and can never see untracked local residue, there are no git hooks running lint locally, and the condition was transient — confined to one local working tree and self-healed by the mandated npm test run before the audit ended. The persisting defect (the fragile probe mechanism) is the auditor's own separate QG-2, rated Medium; the vanished instance should not outrank its surviving root cause. A one-machine, self-healing false red with no CI, merge-gate, or user exposure and no tracked-code defect is Medium, not High.

*Verifier evidence:* __tests__/lint/effective-config.test.ts:127-138 (probePath 'app/__effective_config_probe.ts', writeFileSync of the exact quoted content at :128, unlinkSync in finally at :138); command `printf "import { auth } from '@/lib/auth';\nexport const x = auth;\n" | npx eslint --stdin --stdin-filename app/__effective_config_probe.ts` -> exit 1, "1:10 error 'auth' import from '@/lib/auth' is restricted ... Use requireIdentity() from lib/auth/identity.ts. See ADR-0002 no-restricted-imports" (byte-identical to the auditor's quote); `npm run lint` -> exit 0 now; `git status --porcelain --untracked-files=all` -> empty, probe absent; package.json:29 verify = "npm run lint && npm run test && npm run build"; .github/workflows/ci.yml:36,106-108 (runs-on ubuntu-latest, actions/checkout@v4 = fresh checkout, so residue unreachable by CI); no .husky, no core.hooksPath, no active .git/hooks; repo-wide grep for '__effective_config_probe' matches only the test file (no ignore entry, no register row).

### QG-2 [Medium] Lint meta-test writes a deliberate violation into app/ at a fixed path, cleanup only via finally-unlink
*__tests__/lint/effective-config.test.ts:127* — sweep confidence: confirmed

**Claim.** effective-config.test.ts's end-to-end check creates app/__effective_config_probe.ts (a file designed to fail lint) inside the production source tree, spawns `npx eslint` on it, and deletes it in a finally block. Any hard interruption (SIGKILL, OOM, harness timeout during the eslint child process) leaves the repo failing `npm run lint` — which is precisely the state this audit found, so the failure mode is demonstrated, not hypothetical. The fixed single path also races under concurrent vitest runs, and the file sits inside next dev's watch scope.

**Evidence.** __tests__/lint/effective-config.test.ts:127-138: "const probePath = 'app/__effective_config_probe.ts'; writeFileSync(probePath, ...); try { ... execFileSync('npx', ['eslint', probePath], ...) ... } finally { unlinkSync(probePath); }" — and the pre-existing untracked residue at session start (git status snapshot: `?? app/__effective_config_probe.ts`) proves an interrupted run already escaped the finally.

**Impact.** Running the test suite mutates the repo working tree (this audit's mandated `npm test` deleted a pre-existing untracked file); an interrupted run poisons the lint gate for every later session until someone manually diagnoses and deletes the probe; two concurrent test runs can each other's probe delete mid-lint, producing flaky results.

**Direction (not an implementation).** Lint the probe content without touching disk — eslint's --stdin with --stdin-filename app/__effective_config_probe.ts exercises the identical resolved config; alternatively use a process-unique path outside app/ plus an eslint ignore entry for the probe pattern as a second line of defence.

### QG-3 [Low] Stray audit Postgres container running alongside the project database
** — sweep confidence: confirmed

**Claim.** A container named audit-rls-pg has been up 21 hours next to the project's docker-postgres-1 — apparently another auditor's leftover infrastructure, undeclared residue in the shared environment (not the repo).

**Evidence.** Command `docker ps --format '{{.Names}} {{.Status}}'` output: "audit-rls-pg Up 21 hours" and "docker-postgres-1 Up 8 hours (healthy)".

**Impact.** Consumes resources and could confuse future sessions about which Postgres is the project database; if it maps a conflicting port it could intercept connections intended for the real dev DB (port mapping not examined — outside this dimension).

**Direction (not an implementation).** The controller should identify which auditor owns audit-rls-pg and have it torn down or declared.

**Not examined by this auditor:**
- Actually running the Playwright e2e suite (49 tests) — Explicitly forbidden by the audit brief — it mutates the dev database; collection-only was mandated and performed
- npm run test:security (scripts/pen-test.mjs) — Not in the mandated gate sequence; likely requires a running app server and may mutate state
- Whether next build's TypeScript pass covers __tests__/** or only app code — Redundant for today's verdict since standalone `tsc --noEmit --incremental false` covered the full tsconfig scope and was clean; the coverage-scope question remains unverified
- Port mapping / purpose of the stray audit-rls-pg container — Outside this dimension; reported as an observation (QG-3) for the controller to route
- Content-level quality of the ESLint flat config, test assertions, or build output beyond gate pass/fail — Belongs to other auditors' dimensions; this dimension is gate truth only

## process-register

The process is substantially real, not performative: closures in Phases 1c–1d-i carry commit hashes, CI run URLs, red-before-green proofs, and a branch-protection gate verified by attempting the push it must refuse; the 2026-08-12 triage is genuinely strong self-audit. But the register (210 rows, 143 open, 523KB) is straining its medium and its sweeps: every reconciliation filters by one target label, so rows outside that root keep being missed — three "Phase 1" rows have sat Open through four sweeps even though a closed row (D-052) claims they were closed; the register's single biggest gate (D-018 hosting, which 26 open rows wait on) is stale against the repo's own actively-maintained Hetzner-VPS runbooks; and a human ruling ("add jsdom") is recorded in one column of a row whose other columns still say the decision was never taken. Roughly half of recent commits are process bookkeeping — a high but mostly-paying cost, with the register's manual-sweep model being the part that is now demonstrably failing at scale.

**Sound (what is genuinely good):**
- Register stats parse cleanly: 210 rows D-001..D-210, no duplicate or missing IDs, every row exactly 8 cells (10 pipe-fields) — the register-integrity test's shape guarantees hold.
- Late-phase closures are exemplary evidence discipline: D-146 cites commit hashes plus a live CI run URL and applies the D-191 property-vs-mechanism check to its own closure; D-203 verified branch protection by pushing a probe commit and observing 'GH006 ... 2 of 2 required status checks are expected'; D-184 bisected the branch to prove the row's own 'pre-existing' claim false, then proved its regression test non-vacuous by reverting the fix.
- The 2026-08-12 triage (docs/planning/2026-08-12-phase1d-backlog-triage.md) is real self-audit: v1 was BLOCKed by adversarial review with 3 verified criticals, v2 changed search root rather than patching, embedded a mechanical completeness check (comm -23 of row IDs), and honestly records the controller destroying the d185 probe.
- Reconciliation commits verify against code, not reports: 6412559 closes D-101 by citing lib/auth/context.ts:52 and re-triggers 14 rows on events, each with a stated check.
- register-integrity.test.ts proved its assertions non-vacuous by running them against a deliberately corrupted copy of the register before committing (file header, lines 31-35), and it caught the D-101 pipe-break 'immediately' per commit 6412559.
- PR/merge discipline is now genuinely enforced: since D-193/D-203 (2026-08-10/12) all merges to main go through PRs with two required checks (lint,typecheck,test,build + e2e) — confirmed on PR #6's statusCheckRollup and by gh pr list showing PRs #1-#5 merged.
- AGENTS.md encodes measured history rather than aspiration (0-for-7 self-review vs 7-for-7 independent; the D-063 orchestration substitution), and its amendment discipline (every rule must name its checkpoint) is followed in practice — cafacd7, 6fc18a1, 2e779c0 each install amendments with recorded rulings.
- Honest-limit discipline is consistent: closures state what was NOT verified (D-146 'this proves FIRING, not GATING'; D-195 'this change does NOT address the adversarial axis').

### PH-2 [High] D-021/D-024/D-026 display Open while closed row D-052 asserts they were 'all closed above' — missed by four successive sweeps
*docs/DEFERRED_REGISTER.md:98* — sweep confidence: confirmed

**Claim.** D-052's closure narrative (2026-08-05) states 'D-021, D-024, D-026 (target Phase 1, code-verified live ... all closed above)', but all three rows still read 'Open (needs live verification)' with no reconciliation annotation of any kind — and they have now survived the Plan 1b, 1c and 1d-i phase-exit reconciliations plus the 2026-08-12 triage, because every sweep scoped itself by a target label ('Phase 1d', 'Phase 1b') that these 'Phase 1' rows do not carry.

**Evidence.** docs/DEFERRED_REGISTER.md:98 (D-052, Closed-done): 'D-021, D-024, D-026 (target Phase 1, code-verified live — ... — all closed above)'; docs/DEFERRED_REGISTER.md:67,70,72 — D-021/D-024/D-026 all end '| Phase 1 | Open (needs live verification) |' with no amendment text; triage doc line 1: 'Triage of the 48 open rows labelled "Phase 1d"' (search root excludes target='Phase 1')

**Impact.** The register contradicts itself: a closed row's evidence cites closures that do not exist. Either three trivially-closable rows (all flagged STALE ON ENTRY in 2026-08-02) have accumulated 15 days of false 'outstanding' signal, or D-052's closure overclaimed — both are register-trust failures. The integrity test cannot see this class (the rows contain no 'Closed-' text), and it is a live instance of the same one-search-root failure AGENTS.md §3 documents.

**Direction (not an implementation).** Reconcile the three rows now (each needs one live browser check), and give C6's register review a mechanical, label-independent query — e.g. an integrity-test assertion that no Closed row's text names another row as 'closed' while that row displays Open.

**Verification: CONFIRMED.** Every leg of the claim verified against the file and git history, and my refutation attempts failed: no later amendment to any of the three rows exists (git log -S on each row's unique prefix returns only creation commit b831e0c, 2026-08-02); no sweep ever covered target='Phase 1' (triage doc line 1: 'Triage of the 48 open rows labelled "Phase 1d"'); and the close-then-revert hypothesis is dead — git show c2f56ca touches none of the three rows, so 'all closed above' was false the moment it was written. I additionally found the contradiction is intra-commit: c2f56ca (2026-08-05, the Plan 1b exit reconciliation) both wrote D-052's false closure claim and named D-021/024/026 as 'genuine stale Target cases' in D-133's amendment — the sweep saw the rows, mischaracterized them as closed, and left them Open, after which the 1c exit, the 1d-i reconciliations (6412559 et al.) and the 2026-08-12 triage all missed the contradiction. High stands: the register is the project's system of record and a C6 gate input (D-052's own text: 'The register is a decision input, so unverified rows are actively misleading'); a Closed row citing closures that do not exist is a concrete operator-impact integrity failure, the class is invisible to register-integrity.test.ts (the rows contain no Closed text), and the demonstrated four-sweep survival shows a systematic blind spot rather than a typo.

*Verifier evidence:* docs/DEFERRED_REGISTER.md:98 (D-052, status 'Closed-done', text 'D-021, D-024, D-026 (target Phase 1, code-verified live — app/(public)/terms/privacy exist, the report legend renders all four correct ranges, suppressHydrationWarning is present — all closed above)'); lines 67/70/72 all end '| Phase 1 | Open (needs live verification) |' with no amendment; git log -S 'D-021 | B2' (likewise D-024/D-026) → only b831e0c 2026-08-02; git log -S 'all closed above' → c2f56ca 2026-08-05 'Plan 1b phase-exit reconciliation'; git show c2f56ca | grep '^[+-]| D-02[146] ' → empty; docs/DEFERRED_REGISTER.md:181 (D-133: 'genuine "stale Target" cases, e.g. D-021/024/026', added by the same c2f56ca per git log -S 'stale Target'); docs/planning/2026-08-12-phase1d-backlog-triage.md line 1 (label-scoped search root)

### PH-1 [Medium] D-018 'Hosting: parked, undecided' is stale against the repo's own maintained VPS runbooks — and 26 open rows are gated on it
*docs/DEFERRED_REGISTER.md:64* — sweep confidence: probable

**Claim.** The register's largest trigger cascade waits on a hosting decision the repository itself treats as made: docs/runbooks/deployment.md documents a specific production target (Hetzner CX32, rai.air.ug) and was actively hardened 5 days ago under D-076, yet D-018 remains 'PARKED ... Raised by the user, or first deploy need | Open', and 26 open rows key their pick-up trigger on 'when hosting is decided (D-018)' — including security controls (D-076 fail-closed app password, D-199 trusted-proxy allowlist, D-125, D-142 backups) and D-208's recorded commitment to reconsider the irreversible slug-squatting harm (D-201) at exactly that moment.

**Evidence.** docs/DEFERRED_REGISTER.md:64 '| D-018 | Hosting / deployment model | PARKED | ... | Raised by the user, or first deploy need | — | Open |'; docs/runbooks/deployment.md:15 'Server | Hetzner CX32 (4 vCPU, 8 GB RAM, 80 GB disk)'; commit 5337039 'fix(docs): D-076 — the deployment runbook omitted APP_DATABASE_URL entirely' (2026-08-12); script count over open rows: trigger mentions D-018/hosting/deploy in 26 rows (D-018, D-038, D-040, D-046, D-051, D-065, D-076, D-079, D-091, D-107, D-124, D-125, D-139, D-140, D-142, D-152, D-158, D-167, D-171, D-180, D-190, D-194, D-199, D-200, D-202, D-208)

**Impact.** If a VPS is procured (asserted by the audit controller; in-repo evidence is the maintained runbooks), ~26 deferred security/ops obligations believe they are still waiting — the exact 'moment that passed unnoticed' failure the 2026-08-12 triage diagnosed, but at the register's single highest-fan-out node. D-208's reconsideration of the only irreversible harm in the backlog is among the triggers that would fire.

**Direction (not an implementation).** Resolve D-018 explicitly (decide or record the de-facto decision), then run a dedicated reconciliation over the 26 D-018-gated rows the way the 2026-08-12 sweep handled the Phase-1d label — the register itself is the tool for this; it just needs the trigger acknowledged.

**Verification: OVERSTATED (severity corrected to Medium).** The verified in-repo content is a structural fragility, not a demonstrated staleness: D-018 is PARKED/Open and 26-28 open rows (I reproduced the count by parsing trigger cells; includes security rows D-076/D-199/D-142 and D-208's irreversible-harm reconsideration) gate on it, while the maintained deployment runbook names Hetzner CX32/rai.air.ug and commit 5337039 (2026-08-12) calls it 'this project's own deployment procedure'. But the finding's High impact rests on VPS procurement, which exists only as the audit controller's out-of-repo assertion (the auditor themselves marked the finding 'probable' for this reason), and the framing 'a decision the repository itself treats as made' is contradicted by context the auditor missed: VISION_AND_PLAN.md:160 currently states 'Hosting/deployment model — deferred; not a design input until raised', all Hetzner references are legacy-era artifacts (runbooks created ed56e04 2026-06-29, predating D-018's 2026-07-19 opening; AGENTS.md §7.4 demotes prior artifacts to references-not-mandates), and D-076's 2026-08-05 annotation shows reconciliations actively re-checking that 'D-018 ... is still Open/unparked'. Absent in-repo procurement evidence (I searched planning docs, the collaboration proposal, and git history — none), the register is arguably behaving as designed; what stands is a real single-point-of-failure gate whose firing condition ('raised by the user') leaves no in-repo trace, plus the runbook/register tension — Medium now, flipping to High/CONFIRMED the moment the human partner confirms procurement or a de-facto decision.

*Verifier evidence:* docs/DEFERRED_REGISTER.md:64 (D-018 '| PARKED | ... | Raised by the user, or first deploy need | — | Open |'); awk parse of trigger cells: 28 open rows matching D-018/hosting/deploy, superset of the auditor's 26 (D-076 trigger 'When hosting is decided (D-018)...', D-199 trigger '...D-124 and D-125 as one piece of work', D-208 trigger 'Whichever comes first: D-018 (hosting) being decided...' read verbatim); docs/runbooks/deployment.md:3,11,15,17 (rai.air.ug, Hetzner CX32); git log -- docs/runbooks/: ed56e04 2026-06-29 creation, 5337039 2026-08-12 D-076 fix whose full message says 'an operator following this project's own deployment procedure'; docs/VISION_AND_PLAN.md:160 'Hosting/deployment model — deferred; not a design input until raised'; grep for Hetzner/rai.air.ug repo-wide: only runbooks + 2026-06-30 legacy plan/spec; grep for VPS/procure in docs/planning + VISION_AND_PLAN: no output

### PH-3 [Medium] Ruled 'ADD IT' on 2026-08-12, jsdom/@testing-library still absent — and the D-169 row's trigger and status columns still describe the decision as untaken
*docs/DEFERRED_REGISTER.md:218* — sweep confidence: confirmed

**Claim.** The human partner's ruling to add jsdom + @testing-library/react was recorded only inside D-169's 'Why' column; the row's Pick-up-trigger column still reads 'A human partner decision ... explicitly NOT proposed or decided here', its status is still Open with a 2026-08-09 annotation, and package.json devDependencies contains neither package five days later. The work is nominally 1d-ii's first task, but 1d-ii has not started and the collaboration-model proposal now proposes reshaping that phase — so an executed ruling exists nowhere except one cell of one row.

**Evidence.** docs/DEFERRED_REGISTER.md:218 (D-169): '**DECIDED 2026-08-12: ADD IT. Human partner ruled to add jsdom plus `@testing-library/react` as dev dependencies.**' while the same row's trigger cell reads 'A human partner decision on whether to add jsdom ... explicitly NOT proposed or decided here'; package.json devDependencies (read 2026-08-17): @playwright/test, @types/*, eslint, eslint-config-next, prisma, tsx, typescript, vitest — no jsdom, no @testing-library/*

**Impact.** A decision-blocked row whose block was lifted still presents as blocked to any label- or column-scoped query — the same self-contradiction shape (one column current, others stale) that made D-144/D-146 display Open while closed. If 1d-ii is reshaped per the proposal, nothing except memory carries the ruling into the new plan.

**Direction (not an implementation).** When a ruling changes a row's state, update trigger/target/status in the same edit (a candidate integrity-test rule: a row containing 'DECIDED' whose trigger cell still says 'NOT ... decided' fails). Execute the two-line dependency addition or bind it to the replanned phase explicitly.

### PH-4 [Medium] Register vocabulary drift in both directions — 2 undeclared kinds in 26 rows, 3 declared statuses never used, header vs integrity-test disagreement — known since 2026-08-12, unfixed
*docs/DEFERRED_REGISTER.md:39* — sweep confidence: confirmed

**Claim.** The Kind column uses PROCESS FAILURE and DECISION (26 rows total; 8+6 of them open) while the legend declares only DEFERRAL/PARKED/RISK/BUG; the header's status vocabulary declares Scheduled, In progress and Closed-dropped, none of which appears in any of 210 rows, while rows use Closed-superseded (2) and REOPENED, which the header does not declare; register-integrity.test.ts's KNOWN_STATUSES matches neither list and has no KNOWN_KINDS check at all. The triage recorded all of this on 2026-08-12 (§5 'Register vocabulary defects') and nothing has changed since.

**Evidence.** docs/DEFERRED_REGISTER.md:30-39 (legend: 4 kinds; statuses 'Open · Scheduled · In progress · Closed-done · Closed-dropped · Closed-changed'); parse output: status counts {Open:143, Closed-done:63(+variants), Closed-superseded:2, Closed-changed:1, REOPENED-reclosed:1} — zero Scheduled/In progress/Closed-dropped; open kinds include 'PROCESS FAILURE':8, 'DECISION':6; __tests__/lint/register-integrity.test.ts:49-55 KNOWN_STATUSES = [Open, Closed-done, Closed-superseded, Closed-changed, REOPENED]; docs/planning/2026-08-12-phase1d-backlog-triage.md:233-236

**Impact.** Any mechanical query by status or kind (which is how every sweep and the C6 gate work) runs against a vocabulary that is one-third fiction; a 'Scheduled' status that actually distinguished trigger-fired rows from waiting rows would have made PH-2 and PH-3 visible mechanically instead of narratively.

**Direction (not an implementation).** Reconcile header, usage and test in one commit (drop or adopt the unused statuses deliberately; declare the two extra kinds; add KNOWN_KINDS). Consider actually using 'Scheduled' to mark trigger-fired rows awaiting a phase — the distinction the register currently cannot express.

### PH-5 [Medium] The register's medium is fighting its function: 523KB, single-line rows up to 7KB, three pipe corruptions, narratives migrating between columns
*docs/DEFERRED_REGISTER.md:45* — sweep confidence: confirmed

**Claim.** The register has outgrown a markdown table: 210 rows average ~2.5KB each on a single line (D-146 is 7,029 chars), amendment history is appended inline per column, three scripted appends have broken rows by embedding pipes (D-204 'third instance'), 84 of 203 rows once carried closure narrative in the status column (defeating the phase-exit gate), and the fix has been an ever-growing integrity test plus a rule ('describe the code, do not paste it') rather than a format that permits quoting code.

**Evidence.** wc: 379 lines / 523KB; extract output: D-146 row = 7029 chars, D-195 = 7181 chars; commit 6412559: 'D-204 amended, third instance: this reconciliation broke D-101 into 12 fields by quoting source containing a logical-or ... Three breaks, one cause'; register-integrity.test.ts:17-23 (84 of 203 rows with status fields up to 3,798 chars; D-144/D-146 displayed Open while closed)

**Impact.** Every consumer — phase-exit gates, triage sweeps, this audit — must write a parser, and each hand-rolled parser has already produced one false phase-exit pass. Row-append conflicts between concurrent agents nearly lost IDs (the test's own gap-check comment). Maintenance cost grows with every amendment because history is inline rather than referenced.

**Direction (not an implementation).** Keep the append-only/never-delete principles but move the medium: one file per row (or YAML/JSON records) with status/kind/target as structured fields and amendments as dated entries — the integrity test becomes trivial and quoting code becomes safe. The project's own doctrine (mechanism beats prose, generate-don't-hand-write) points the same way.

### PH-6 [Medium] Every register sweep to date has been scoped by a single target label, and the misses are now systematic
*docs/DEFERRED_REGISTER.md:46* — sweep confidence: confirmed

**Claim.** The C6 rule is 'no phase exits with an open row targeted at that phase' — so each reconciliation queries one label ('Phase 1b', 'Phase 1c', 'Phase 1d'), and rows outside that label are structurally invisible: D-021/024/026 (target 'Phase 1') missed four times (PH-2); D-179 explicitly noted by the triage as invisible to its own search root; the 2026-08-12 triage itself documented this failure mode (§5: 'This document's own search root ... structurally cannot see it') and the dual-target rule it said was needed 'before the re-target sweep' has not been created — 43 open rows still carry the retired 'Phase 1d' label and 10 more carry 'Phase 1b+', a phase that exited on 2026-08-05.

**Evidence.** Computed open-row target distribution: Phase 2:53, Phase 1d:43, Phase 1b+:10, standing:8, Phase 2a:7, Phase 3:6, 1d-ii:6, Pilot:4, Phase 1:4, Phase 4:2 — i.e. 57/143 open rows (40%) target phases that already exited; docs/planning/2026-08-12-phase1d-backlog-triage.md:225-232 ('Six rows carry dual targets ... A rule is needed before the re-target sweep'); AGENTS.md §1 C6 ('No phase exits with an open row targeted at that phase')

**Impact.** The register's 'Open' count is not evidence of 'outstanding' (the triage's own words), and each new phase inherits the ambiguity. The label-scoped sweep is the same one-search-root defect AGENTS.md §3 spends a page warning about, applied to the register itself.

**Direction (not an implementation).** Make the C6 register review label-independent: sweep by trigger-fired-ness (the triage's Grouping 3 root) rather than by target label, and write the dual-target disambiguation rule before the next re-target pass, as the triage already prescribed.

### PH-7 [Medium] The mandatory what-if-oracle-at-forks rule has not fired at the project's largest fork to date (the collaboration-model restructure)
*docs/planning/2026-08-14-collaboration-model-proposal.md:151* — sweep confidence: confirmed

**Claim.** AGENTS.md §2 makes what-if-oracle 'mandatory at these forks, not situational' for data-model/tenancy/identity choices. The collaboration-model proposal is exactly such a fork (role enum migration, per-project grants, locking) and its own §3.4 records 'AGENTS.md §2 makes what-if-oracle MANDATORY at forks of exactly this kind ... It has not been run.' The rule's trigger still depends on the agent recognising the fork mid-flight — the recall dependency §0 was rewritten to eliminate — and here recognition arrived only at write-up time.

**Evidence.** docs/planning/2026-08-14-collaboration-model-proposal.md:151-153 ('AGENTS.md §2 makes `what-if-oracle` MANDATORY at forks of exactly this kind (tenancy, identity, data model). It has not been run.'); AGENTS.md §2 row 'You reach a choice that would be expensive to reverse — data model, tenancy, scoring, identity | what-if-oracle. This is mandatory at these forks, not situational.'

**Impact.** The proposal is honest about the gap and defers design until it runs, so no damage yet — but it demonstrates the §2 trigger table's residual weakness: triggers bound to 'you notice you are at a fork' fire late or not at all, and the biggest decisions are precisely where the fork is easiest to mistake for a conversation.

**Direction (not an implementation).** Run the oracle before any design work on the collaboration model (the proposal already says so — hold it to that), and consider binding the oracle to a mechanical moment (e.g. 'a proposal document is created under docs/planning/') rather than to fork-recognition.

### PH-8 [Medium] The checkpoint system's self-verification instruments are partly non-functional: C4's lens rule failed three times in one phase before amendment, and the C6 skill-audit is recorded as unreliable
*AGENTS.md:1* — sweep confidence: confirmed

**Claim.** D-197 records the C4 code-review/simplify lens obligation failing three times in one phase, by three different agents, for three different reasons — because the rule as written was unsatisfiable in the project's own workflow (review-and-fix skills vs SDD's no-controller-fixes vs read-only reviewers); it was amended 2026-08-12 (cafacd7) and the amended form is untested by a full phase. D-205 (open) records that the C6 mechanical skill re-audit 'will run the same instrument and get the same unreliable answer' because skill invocations leave no reliable trace to grep.

**Evidence.** AGENTS.md §1 C4 ('Amended 2026-08-12 ... D-197 recorded it failing three times in one phase by three agents for three different reasons. ... All three cannot [hold].'); commit cafacd7 'process(agents): C4 — the lenses are the obligation, not the tools; close D-197, open D-205'; docs/DEFERRED_REGISTER.md:254 (D-205, open, target 'Phase 1d-ii C6 exit': 'the same instrument ... the same unreliable answer. The honest fix is probably not a better grep: an invocation leaves a tra[ce]...')

**Impact.** Two of the six checkpoints (C4's quality lenses, C6's skill audit) currently rest on either an untested amendment or an admittedly unreliable measurement — the process knows this about itself (both are recorded), but until D-205 closes, 'we followed the process' claims at the next phase exit cannot be mechanically distinguished from 'we remember following it'.

**Direction (not an implementation).** Treat D-205 as a blocking item for the next phase exit (it is already targeted there); the fix direction its own row names — invocations that leave an artifact by construction — matches the project's mechanism-beats-prose doctrine.

### PH-11 [Medium] AGENTS.md's cost is high for a one-human team — roughly half of recent commits are process bookkeeping — but the machinery has a demonstrable catch record; the disproportionate part is the register's manual-sweep burden
*AGENTS.md:1* — sweep confidence: confirmed

**Claim.** Of the last 60 commits, ~31 are register/process/plan bookkeeping (26 docs/process/plan/design/quarantine + ~5 fix(register)/fix(docs)) vs ~28 code-bearing — a near 1:1 overhead ratio for one human plus agents. The checkpoint system earns much of it: rules bound to mechanical events demonstrably fire (same-commit register rows in d56694f/ff7f611/2adf381; C6 reviews found the Plan 1b fail-opens; read/write pairing found D-143 and D-181; what-if-oracle found D-195; adversarial review blocked triage v1 with 3 real criticals). What does not scale is the register's human-driven reconciliation loop: 143 open rows, each sweep a multi-commit manual effort (3114fb7 '38 rows resolved', 6412559 '16 overdue rows'), and the sweeps keep missing rows (PH-2, PH-6). The rules' own doctrine — convert rules to mechanism (§0.4) — has been applied to row shape (register-integrity test) but not to trigger-fired detection, which is where the failures now concentrate.

**Evidence.** git log --format='%s' -60 | grep -cE '^(docs|process|plan|design)\(|^docs:|^quarantine' → 26; grep -cE '^(feat|fix|test|ci|refactor)\(' → 28 (of which 934ade1, c199fd7, d0e81dd, 109d1bf, 5337039 are register/docs fixes); catch record: triage §1 (3 criticals), D-195 row ('Found by a what-if-oracle Deep Oracle run'), D-181 ('Found by the C6 read/write-pairing sweep'), D-143 ('Coordinator confirmed this as their own plan defect')

**Impact.** The process is working, not performing — but its marginal cost is shifting from writing rules to servicing the register, and the servicing is the part with the worst recent defect record. Without mechanising trigger-fired detection, each future phase exit pays more and trusts less.

**Direction (not an implementation).** Spend the next process investment on the register, not on AGENTS.md: structured rows (PH-5), a trigger-taxonomy field (event/row-chained/phase/decision), and a generated 'triggers likely fired' report at C6 — replacing label-scoped manual sweeps.

### PH-9 [Low] Closure-evidence rule 3 is unevenly honoured: 2 of 10 sampled closed rows carry no commit citation and no live-verification statement
*docs/DEFERRED_REGISTER.md:87* — sweep confidence: confirmed

**Claim.** Register rule 3 requires every closure to cite the commit and state what was verified live. Sampling 10 closed rows: D-041 and D-074 close with a bare 'Closed-done' — no closure narrative, no commit, no verification statement (both early, Phase 1a/1b-era closures). The other eight range from adequate (D-052, D-063 — commands and greps but no commit hashes) to exemplary (D-090, D-146, D-184, D-195, D-203, D-068 — hashes, run URLs, red/green and live-probe proofs).

**Evidence.** docs/DEFERRED_REGISTER.md:87 (D-041 ends '| Plan 1a Task 6 (data layer) | Phase 1 | Closed-done |' with no closure text); docs/DEFERRED_REGISTER.md:120 (D-074 ends '| Phase 1b | Closed-done |' — trigger cell describes a future self-detecting condition, but no evidence the allowlist actually reached zero is recorded); contrast docs/DEFERRED_REGISTER.md:195 (D-146: commits 80288d8/2b71e82, live run URL, log-level verification)

**Impact.** Small in count but it means 'Closed-done' is not a uniform evidentiary claim across the register's history; anyone auditing early rows must re-derive what the closure meant. The integrity test checks status vocabulary, not closure evidence.

**Direction (not an implementation).** A one-time back-fill pass over pre-1c closures is cheap (there are ~25); optionally an integrity-test heuristic that a Closed-done row must contain 'commit', a hash, or 'verified'.

### PH-10 [Low] No generated role-action matrix document exists in docs/, and no in-repo record of a 'generate the RBAC matrix doc' approval could be found
*docs/DEFERRED_REGISTER.md:1* — sweep confidence: unconfirmed

**Claim.** The audit brief's premise that RBAC-matrix doc generation was approved could not be grounded in the repo: no register row, plan, or spec records such an approval, and docs/ contains no generated role-action matrix artifact — the matrix exists only as generated tests (the 726-cell permission-matrix suite) and prose descriptions in specs. If the approval was real, it lives only in conversation — which is itself D-133's recorded failure class ('decisions that existed only in conversation').

**Evidence.** grep for 'role-action matrix|matrix doc|authorization matrix|generate.*matrix' over docs/DEFERRED_REGISTER.md returned no approval row; grep over docs/superpowers/plans/*.md and specs/*.md returns only spec §3.4 'RBAC matrix' (design) and 'RBAC matrix as fixture — tests are generated' (2026-08-02-phase1-foundation-design.md:331); ls docs/ shows no matrix artifact; commit 8d1539a 'D-136 and D-137 — the two decisions that existed only in conversation' establishes the class

**Impact.** Either an approved deliverable has no register row and no artifact (a §6 violation of exactly the kind the register exists to prevent), or the premise is mistaken — both are worth the controller resolving with the human partner, since a human-readable matrix is a natural institutional-assurance artifact for this product.

**Direction (not an implementation).** Ask the human partner; if the ruling exists, open a register row for it now (D-133's own remedy).

### PH-12 [Low] Open-row composition: the register is functioning as memory, not sediment — but ~20 rows are actionable now and three process rows recur at every phase exit without closing
*docs/DEFERRED_REGISTER.md:181* — sweep confidence: confirmed

**Claim.** Of 143 open rows, the large majority are legitimately event-gated (26 hosting-gated, 19 pilot/first-real-users, ~11 'whoever next touches file X' opportunistic, 7 Phase-2a design cluster, plus Phase 2/3 feature deferrals) with concrete, well-formed triggers — genuine memory. Actionable-now is roughly 20 rows (14%): the 1d-ii set (D-185, D-198, D-145, D-170, D-209, D-130, D-104), decided-but-unexecuted D-169, the PH-2 trio, D-023/D-025/D-028 (reclassified usability/report-fidelity failures), D-210 (blocked on two named human answers), and the phase-exit process rows. But D-132, D-133 and D-205 are triggered 'at the next phase exit' and have now watched at least two phase exits pass (1c merged 2026-08-09, 1d-i merged 2026-08-12) without closing — recurring-trigger rows have no mechanism forcing a disposition when their moment arrives, so they roll forward indefinitely.

**Evidence.** Computed clusters from trigger text: hosting/deploy 26, pilot 19 (D-003, D-014, D-023, D-025, D-042, D-054, D-104, D-105, D-107, D-124, D-130, D-141, D-167, D-173, D-177, D-183, D-189, D-201, D-208); D-133 trigger 'Before the next phase branch (phase1c-* or equivalent) is merged' (docs/DEFERRED_REGISTER.md:181) — phase1c merged 8c5c32b and phase1d-i merged 51ba67d since; D-132 trigger '...or at the start of the next phase's C6 review' — the 1d-i C6 ran 2026-08-10/12; triage §2.9 acknowledges all three as 'fires at next phase exit'

**Impact.** The clustering (hosting, pilot, AssessmentPageClient data-loss, declared-but-never-wired ×7 per D-209, schema-vs-DB ×3, pre-auth abuse ×5, Phase-2a framework model ×7) is exactly the replan input the triage produced and remains valid. The recurring-trigger rows are the only class quietly rotting: their trigger fires every exit and each exit defers them without the register recording a fresh disposition.

**Direction (not an implementation).** At the next phase exit, force an explicit per-row disposition for D-132/D-133/D-205 (do, drop-with-reasons, or re-trigger on a non-recurring event); D-133's own mechanism (bind register drift to controller completion) is the fix for the class.

### PH-13 [Low] Untracked probe file present at session start (app/__effective_config_probe.ts) has vanished from the working tree — consistent with the project's recorded probe-destruction pattern
*app/__effective_config_probe.ts:1* — sweep confidence: probable

**Claim.** The session-start git status recorded '?? app/__effective_config_probe.ts' (an untracked probe in app/, i.e. C4 'untracked residue is a finding'); a fresh 'git status --porcelain --untracked-files=all' during this audit returns empty, so the file was deleted untracked and uncommitted by someone between the snapshot and now. The project has twice recorded exactly this failure shape: the destroyed d185-probe (triage §1 C2, 'The controller destroyed it ... the loss is permanent') and D-207 (preserving a derivation before its gitignored workspace was deleted).

**Evidence.** System-context gitStatus snapshot: '?? app/__effective_config_probe.ts'; command run in this audit: 'git status --porcelain --untracked-files=all' → empty output; docs/planning/2026-08-12-phase1d-backlog-triage.md:30-37 (the d185-probe destruction)

**Impact.** If the probe held evidence (its name suggests a companion to __tests__/lint/effective-config.test.ts), it is gone without a register row — the third instance of probe artifacts living and dying outside git in a project whose rules require 'everything written is committed or declared' (§4).

**Direction (not an implementation).** D-207's own open trigger names the fix: a mechanical guard for probe artifacts (commit them under a probes/ directory or record their findings in a row before deletion).

**Not examined by this auditor:**
- Full content of the five plan documents in docs/superpowers/plans/ (42-98KB each) and the specs directory — Volume; spot-checked only where register rows cited them. Plan-vs-execution fidelity is presumably another auditor's dimension.
- Whether the UserPromptSubmit hook AGENTS.md C1 claims is 'harness-enforced' actually exists in .claude/settings — and whether it fires — Ran out of budget; AGENTS.md asserts it, and D-063's history shows the hook alone was insufficient anyway, but its current existence is unverified.
- The remaining ~50 closed rows' closure evidence beyond the 10-row sample — Sampling was the assigned method; the sample plus incidental reads (~16 total) supports the PH-9 pattern but early-phase closures were not exhaustively graded.
- Per-row verification that each of the 26 hosting-gated rows is genuinely unblocked by the specific procured VPS (vs needing further decisions) — Requires the procurement details (provider confirmed? domain? topology), which are not in the repo; PH-1 flags the cascade, not each row's readiness.
- docs/VISION_AND_PLAN.md and the ADRs' currency against the register — Out of this dimension's core scope; touched only via rows that cite them.
- SDD ledger / .superpowers workspaces — Gitignored and per D-207/triage partially destroyed; D-205 records that skill-invocation auditing from surviving artifacts is unreliable, which is itself reported as PH-8.
- Merged PRs' review/approval contents (only check names and merge status were read) — required_pull_request_reviews is null by recorded ruling (D-193, sole-contributor reasoning), so approval-content audit would be vacuous.

## product-vision-fit

The multi-tenant spine, evidence attachment, and framework-version pinning are real and well-built, and the first-run path (register → org → project → assessment) is smooth with honest empty states. But of the five vision shifts, none is fully delivered: credibility tiers, artifact generation, API/CLI, and benchmarking are absent (mostly per-plan and register-tracked), and the remediation loop is a facade — full read/complete/evidence UI over a table no production code ever writes, deferred on a register claim that is factually false. The product a week-one team meets is essentially the old free SPA plus accounts, teams, and evidence upload, headlined by the exact single percentage the vision calls indefensible, with three concrete abandonment risks: silent loss of assessment answers on flaky networks, lockout with no password recovery, and a privacy policy that promises consent-withdrawal and deletion controls that do not exist anywhere in the UI.

**Sound (what is genuinely good):**
- First-run experience is genuinely good: registration bootstraps a complete tenant atomically (app/api/auth/register/route.ts:8-16, bootstrapOrgWithOwner creates User+Org+owner Membership+consent in one transaction), '/' dispatches zero/one/many-org cases cleanly (app/page.tsx), the dashboard empty state routes directly to first value, and the project form requires only a name with optional details collapsed and Africa-contextual placeholders ('Makerere University', 'Uganda', 'Rural communities in East Africa' — NewProjectForm.tsx:166-212).
- Assessment/report/explore content is real and research-grounded, not boilerplate: explore/about (377 lines) explains the 3-stage lifecycle with UNESCO-sourced principles (projectConfig.json: principlesSource = UNESCO Recommendation); framework data files total ~144KB of genuine content.
- Evidence attachment and framework versioning shipped with real teeth: Evidence/EvidenceBlob under RLS (schema.prisma:340-408), report provenance line + drift banner disclosing framework mismatch honestly (ReportSummary.tsx:86-97), and the drift-banner copy was deliberately narrowed to assert only what is provable (ReportSummary.tsx:41-53).
- Legal pages are honestly labeled drafts ('Draft — pending institutional review... will replace this text before public launch') rather than fake boilerplate; the account-deletion API is carefully engineered (TOCTOU-guarded last-owner protection, app/api/users/me/route.ts).
- Sampled a11y fundamentals are above typical: labeled inputs everywhere, radiogroups with aria-labelledby (QuestionBlock.tsx:95-135), role=alert/status on messages, :focus-visible and prefers-reduced-motion in globals.css (528-546), aria-labeled score ring in the report (ReportSummary.tsx:100), mobile drawer with Escape/overlay dismissal.
- The DEFERRED_REGISTER is an unusually honest instrument — most vision gaps (D-001 tiers, D-020 maturity rubric, D-105 audit trail, D-177 invitations) are consciously tracked with triggers rather than silently dropped.

### PT-01 [High] Privacy policy promises consent-withdrawal, deletion, and export controls that do not exist in the product
*app/(public)/privacy/page.tsx:44* — sweep confidence: confirmed

**Claim.** The privacy page tells users 'You can withdraw this consent at any time from your account settings' and 'You can export your data or delete your account from your account settings' — but no account-settings surface exists anywhere, no code path anywhere writes researchConsent after registration (withdrawal is unimplementable, not just un-surfaced), and the export/deletion APIs have zero UI callers. Even voluntary password change is unreachable (only the forced must-change-password proxy redirect leads to /change-password).

**Evidence.** app/(public)/privacy/page.tsx:44-54 ('withdraw this consent at any time from your account settings'; 'export your data or delete your account from your account settings'). Grep for researchConsent writes: only lib/data/preauth.ts registration paths (157-236). Grep 'users/me' across all .tsx: only change-password/page.tsx:21 calls any /api/users/me endpoint. Sidebar.tsx navItems (38-48) contain no account/settings/profile link. app/api/users/me/route.ts exposes only DELETE.

**Impact.** Consent is being collected right now (register page requires the ToS/privacy checkbox) against promises the product cannot honor. For a platform whose vision anchors on Malabo/consent-governance and which scores others on accountability (PO-03), an unhonorable consent promise is self-refuting, and a data-protection complaint (Uganda DPPA-style access/withdrawal rights) could not be serviced through the product.

**Direction (not an implementation).** Build a minimal account page (withdraw research consent writing a new ConsentRecord, export button, delete button, change password link), or rewrite the privacy draft to promise only what exists (e.g. 'contact your administrator'). The withdrawal mechanism needs an API that does not exist yet — note the register has no row tracking this gap.

**Verification: CONFIRMED.** Every load-bearing claim checks out: the live privacy text promises consent withdrawal, export, and deletion 'from your account settings', yet no account-settings surface exists (Sidebar nav has no account link; the only settings pages are platform-admin and org-members), no code path anywhere updates researchConsent or ConsentRecord after registration (writers are registration-only in lib/data/preauth.ts and the invitation register route; the only other ConsentRecord op is deleteMany during account deletion), and the export/delete APIs have zero UI callers — the sole users/me fetch in any .tsx is change-password calling /api/users/me/password, and nothing links to /change-password except the forced proxy redirect. I tried to kill it via the draft banner (real mitigator, but mandatory consent records are minted against this text today via preauth.ts ConsentRecord.createMany), via hidden settings surfaces (none), and via register coverage (D-008 tracks a Phase-3 org-level consent-model redesign, not the withdrawal promise being made now). Minor auditor inaccuracy — the users/me API surface also includes password/sessions/export routes, not only DELETE — but that does not weaken the finding since none has a UI caller. High stands: an RAI-governance product collecting mandatory consent against unhonorable promises is a concrete gap.

*Verifier evidence:* app/(public)/privacy/page.tsx:44-53; components/layout/Sidebar.tsx:38-48; grep researchConsent writers -> only lib/data/preauth.ts:164-236 + invitations/[token]/register/route.ts:70 + seed; grep consentRecord writes -> preauth.ts:168,234 create, identity.ts:378 deleteMany only; grep 'users/me' in .tsx -> only change-password/page.tsx:21; find app/api/users -> route.ts (DELETE), password (POST), sessions (DELETE), export (GET); grep change-password links -> none in UI

### PT-02 [High] The remediation loop is a facade: nothing in production ever creates a RemediationItem, and the register row deferring the creation endpoint rests on a false claim
*docs/DEFERRED_REGISTER.md:163* — sweep confidence: confirmed

**Claim.** Vision shift 5 ('closed remediation loop') appears the most built — GET/PATCH routes, completion tracking with completedBy/notes, evidence-to-remediation linkage, derived evidenceLevel, project-page gap/attention badges — but no production code path writes remediation_items at all, so every surface operates over rows that can never exist for a real user. D-117 deferred the creation POST on the stated ground that 'the engine that generates remediation items (lib/engine/AssessmentEngine.js) writes them a different way' — the engine contains zero occurrences of 'remediation'.

**Evidence.** Grep for remediationItem.create/createMany and 'INSERT INTO remediation' across lib/, app/, prisma/ (excluding tests): only the route comment at app/api/v1/orgs/[slug]/assessments/[id]/remediation/route.ts:11 describing the removed POST. prisma/seed.ts: no remediation. grep -n 'remediation' lib/engine/AssessmentEngine.js: empty output. DEFERRED_REGISTER.md D-117 (line 163): 'the engine that generates remediation items (lib/engine/AssessmentEngine.js) writes them a different way, not through this endpoint'. Project page renders the counts only when items exist (projects/[id]/page.tsx:255-345), so the feature silently never appears.

**Impact.** A team that completes an assessment and sees gaps in the report has no tracked remediation items to work through, complete, or attach evidence to — the loop that defines shift 5 cannot start. Substantial engineering (D-164 counts five RemediationItem-to-client paths) sits on an unwritable table, and the register entry that would have flagged this passes audit because its justification sounds verified while being wrong — the exact 'laundered deferral' failure D-068/§6 warns about.

**Direction (not an implementation).** Correct D-117's justification and open a row for the actual gap (no writer exists); decide whether remediation-item generation belongs at assessment completion (from report gap/attention tiers) and build the writer before any further reading-side investment.

**Verification: CONFIRMED.** Independently re-verified that nothing in production ever creates a remediation_items row: the only remediationItem operations outside tests are findMany/findUnique/update in the GET/PATCH route, the project-page read, and evidence linkage; raw-SQL greps, prisma/seed.ts (0 matches), and migrations (which only backfill orgId on hypothetical legacy rows) all come up empty, and the route's own header comment records the POST being dropped as dead surface. All four lib/engine files contain zero occurrences of 'remediation', so D-117's stated justification — 'the engine that generates remediation items (lib/engine/AssessmentEngine.js) writes them a different way' — is factually false, exactly the laundered-deferral class §6/D-068 warns about. I hunted for another register row recording the real no-writer gap and found none: D-070 (closed) covers pre-tenancy type errors, D-164 covers a fifth read path and explicitly says 'not a live defect'. The project page conditions its gap/attention badges on rows that can never exist, so the entire built surface of vision shift 5 is unreachable for real users. High stands.

*Verifier evidence:* grep 'remediationItem.(create|createMany|upsert)' app/lib/prisma/components excl. tests -> only the comment at app/api/v1/orgs/[slug]/assessments/[id]/remediation/route.ts:11 (route ops at :36 findMany, :75 findUnique, :89 update); grep -c remediation lib/engine/* -> 0 in all four files; docs/DEFERRED_REGISTER.md:163 (D-117 text); prisma/seed.ts 0 matches; migrations only ALTER/UPDATE-backfill; projects/[id]/page.tsx:255-262; VISION_AND_PLAN.md five-shifts list, shift 5

### PT-03 [High] Assessment auto-save fails silently — answers can be lost wholesale on flaky networks with zero indication
*app/(authenticated)/orgs/[slug]/assessment/[id]/AssessmentPageClient.tsx:317* — sweep confidence: confirmed

**Claim.** The debounced auto-save swallows every failure: the catch block is empty ('Auto-save failures are silent — user can retry' — but the user is never told anything failed, so cannot know to retry), res.ok is never checked so HTTP 401/403/500 responses are invisible even without a network error, and there is no save-status indicator, no retry queue, and no local persistence fallback. The beforeunload guard fires on having responses at all, not on unsaved changes.

**Evidence.** AssessmentPageClient.tsx:317-331 — 'await fetch(apiBase, { method: PATCH ... })' with no res.ok check, catch {} with comment 'Auto-save failures are silent — user can retry'; grep for 'saving/saved' status UI in the 890-line client: none. QuestionBlock.tsx:15 comment acknowledges a 403 path 'silently'. The predecessor SPA persisted to localStorage (VISION_AND_PLAN.md:14).

**Impact.** The stated adopters work on flaky links and shared lab machines (the register's own Ψ finding set session maxAge for shared machines). A user can answer 22 questions across an hour, have their session expire or wifi drop, and lose everything silently — the single most likely week-one abandonment event, and a durability regression from the free static SPA this product replaces.

**Direction (not an implementation).** Check res.ok, surface a saved/unsaved/save-failed indicator, retry with backoff, and keep an unsynced local draft (the SPA's localStorage pattern) as a buffer; tie beforeunload to actual unsaved state.

**Verification: CONFIRMED.** The code claims are all accurate as read directly: autoSave's fetch has no res.ok check and an empty catch with the 'failures are silent' comment; both completion handlers (handleGenerateReport, handleContinueToNext) also swallow failures and navigate to the report regardless ('Continue to report even if API call fails'); there is no saving/saved status UI and no localStorage anywhere in the 890-line client; the beforeunload guard keys on having responses at all, not unsaved state; and the predecessor SPA's localStorage durability is confirmed at VISION_AND_PLAN.md:13. The context the auditor missed — D-130 (Open RISK documenting this exact no-res.ok silent failure plus a live-reproduced autosave/completion race), D-145, D-198, D-104, and D-208 — corroborates rather than kills the finding: the human partner's own D-208 ruling schedules 'the assessment-client data-loss phase' (Phase 1d-ii) next precisely because these six rows 'destroy work in progress' and 'harm ordinary users during normal operation'. Register tracking changes the process picture, not the user-facing severity: a session-expiry 401 today silently discards every subsequent answer with zero indication. High stands.

*Verifier evidence:* app/(authenticated)/orgs/[slug]/assessment/[id]/AssessmentPageClient.tsx:317-331 (empty catch, no res.ok), 599-612 and 621-629 (completion swallows), 341-351 (beforeunload on hasResponses); grep -i 'saving|saved|localStorage' in file -> no status UI, no localStorage; docs/DEFERRED_REGISTER.md rows D-130 (line 178, Open) and D-208 (line 257); docs/VISION_AND_PLAN.md:13

### PT-04 [Medium] No self-service password reset, while login lockout exists — a locked-out solo org owner has no recovery path
*app/(public)/forgot-password/page.tsx:12* — sweep confidence: confirmed

**Claim.** /forgot-password is an honest placeholder telling users to 'contact your platform administrator' — but a self-registered org owner (the primary first-run path) has no idea who that is and the page names no contact. The schema implements failedLoginAttempts/lockedUntil, so lockout-with-no-recovery is a reachable state. The 'no email infrastructure' excuse no longer holds: Resend is integrated and used for invitations.

**Evidence.** app/(public)/forgot-password/page.tsx:12-15 ('Self-service password reset isn't available yet. To regain access, contact your platform administrator'). prisma/schema.prisma:85-86 (failedLoginAttempts, lockedUntil). lib/email/send.ts:1-56 (working Resend transport, used by the invite route). No register row found scheduling reset now that email exists.

**Impact.** For a distributed multi-institution product, a forgotten password on the org owner's account strands the entire team's tenant with no in-product recourse and no named human to email. Week-one abandonment risk number two.

**Direction (not an implementation).** Password-reset email is now a small delta on the existing Resend transport + token pattern already proven by invitations; at minimum, put an operator contact address on the placeholder page.

**Verification: OVERSTATED (severity corrected to Medium).** The core gap is real — no self-service reset, the placeholder names no contact, and Resend is a proven transport — but two evidence elements inflate it. First, 'No register row found scheduling reset now that email exists' is false: D-048 ('Password recovery is a non-functional stub', BUG, Open) was re-targeted to Phase 2 on 2026-08-05 with justification that explicitly incorporates the now-proven email path and rules the placeholder 'a legitimate interim UX' — this is a consciously tracked pre-launch deferral, not an unflagged blind spot. Second, the lockout mechanism cannot strand anyone: lib/auth.ts locks for exactly 15 minutes after 5 failures and clears counters on the next successful login, so 'lockout-with-no-recovery' self-heals by design and only a genuinely forgotten password (the already-tracked D-048 gap) strands a solo owner. One aggravator the auditor missed cuts the other way: the page promises the administrator 'can reset your password from the admin panel', but no admin password-reset capability exists anywhere (app/api/admin holds only a role route; the admin users page has zero password references) — the copy promises a nonexistent path and should be fixed. Net: a real, tracked Medium product gap in a not-yet-hosted product (D-018 open per D-208), not a High stranding hazard.

*Verifier evidence:* app/(public)/forgot-password/page.tsx:12-15; lib/auth.ts:64-101 (15-min lock at :81-82 'new Date(Date.now() + 15 * 60 * 1000)', reset at :98-101); docs/DEFERRED_REGISTER.md line 94 (D-048 Open, re-targeted 2026-08-05, email path proven via commit 603f6e1 live send); lib/email/send.ts:25-60; find app/api/admin -> only users/[id]/role/route.ts; grep -i 'reset|password' in app/(authenticated)/admin/users -> no matches

### PT-05 [Medium] Vision shift scorecard: none of the five shifts is fully real — the product today is the SPA plus accounts, tenancy, and evidence upload
*docs/VISION_AND_PLAN.md:30* — sweep confidence: confirmed

**Claim.** Scored against what is built: (1) evidence-linked claims PARTIAL — per-question/per-item evidence upload is real, but credibility tiers (the 'structural answer to box-ticking') are absent from schema and UI, and the reviewer role is grant-identical to viewer; (2) artifacts ABSENT — no model card, datasheet, or risk register generation despite §3.1 declaring these THE adoption driver for the primary adopter; (3) workflow integration ABSENT — no API-key auth, no CLI, /api/v1 is session-cookie-only; (4) longitudinal PARTIAL — within-org compare (trend/radar/heatmap) is real, cross-institutional benchmark absent (no BenchmarkAggregate model, zero code mentions); (5) remediation FACADE (PT-02). Most of this is per-plan sequencing and register-tracked (D-001, D-020), so it is honest distance, not deception — but it means the current product offers a week-one team little beyond the free SPA.

**Evidence.** grep -rni 'credib' app/ components/ lib/: zero hits. grep 'benchmark|percentile' app/ components/ lib/: zero hits. grep 'model card|datasheet|risk register|crosswalk|42001' app/ lib/: only comments and one about-page bullet. lib/authz/policy.ts:50-51: reviewer and viewer rows identical. prisma/schema.prisma: no BenchmarkAggregate/credibilityTier. compare/page.tsx renders TrendChart/RadarChart/GapHeatmap over completed assessments (real). VISION_AND_PLAN.md:30-34 defines the five shifts; :43 names artifact generation the primary adoption driver.

**Impact.** The 'RAI governance infrastructure, not a questionnaire' framing is currently aspiration: the differentiating value for the declared primary adopter (workload-reducing artifacts) does not exist, so retention past the first assessment rests on features that are not built. Week-one abandonment risk number three: after the score and report, there is no reason to return.

**Direction (not an implementation).** When sequencing Phase 2, lead with the smallest artifact (model card draft from existing ProjectMetadata + responses) rather than more platform depth; the data to generate one is already collected.

### PT-06 [Medium] The single percentage the vision condemns is still the headline everywhere in the UI
*components/dashboard/ScoreGauge.tsx:57* — sweep confidence: confirmed

**Claim.** §4.1 calls the overall percentage 'an opaque absolute... no defensible basis for collapsing 21 areas into one percentage' and mandates maturity levels with 'the single number as a rollup, not the headline.' The built product headlines the bare number in every surface: ScoreGauge renders only the digits, project cards show 'X% Score', dashboard activity shows 'Score', the report ring leads with 'X%'. The maturity rubric (D-020) is parked to Phase 2, and the vision's own parking lot said it would be 'designed with the domain content in Phase 1' — it was not.

**Evidence.** ScoreGauge.tsx:57 (bare {clamped}); projects/[id]/page.tsx:323-331 ('{assessment.overallScore}%' + 'Score'); dashboard/page.tsx:126-129 (score-value + 'Score'); ReportSummary.tsx:101 ('{overallScore}%'). VISION_AND_PLAN.md:68 ('the single number as a rollup, not the headline'); :162 (parking lot: 'to be designed... in Phase 1'). DEFERRED_REGISTER.md:66 D-020 Open, target Phase 2.

**Impact.** Real institutions are being invited to trust and act on exactly the number the product's own framework (IP-04, metric-selection impossibility) calls indefensible — the tool committing the failure it diagnoses, in the phase where first pilots happen.

**Direction (not an implementation).** Cheap interim before D-020: lead every score surface with the level label (already computed — levelLabels/overallLevel exist) and demote the percentage to secondary text.

### PT-07 [Medium] Privacy draft misstates who can actually see assessment data, and names no jurisdiction, controller, retention, or African data-protection regime
*app/(public)/privacy/page.tsx:37* — sweep confidence: confirmed

**Claim.** The privacy text says assessment data 'is visible to you and to platform administrators of your institution.' In reality (a) all members of the org see all projects and assessments — the dashboard is deliberately team-wide with no per-user filter — and (b) 'platform administrators' (UserRole.admin) are platform-level, cross-institution operators, not institution staff. Neither the privacy page nor terms names a data controller, retention period, jurisdiction, or any regime (Uganda DPPA 2019, Malabo) — despite the Malabo Convention being a named vision anchor mapped 'cleanly onto the framework's privacy/consent area (PP-06)'.

**Evidence.** app/(public)/privacy/page.tsx:37-39 ('visible to you and to platform administrators of your institution'). dashboard/page.tsx:8-15 ('Team-wide, not my-projects: every project and every recent completed assessment IN THE ORG'). prisma/schema.prisma:9-12 (UserRole admin is platform-scoped). VISION_AND_PLAN.md:53 (Malabo named as anchor). grep 'DPPA|Malabo' in app/: zero hits.

**Impact.** Users grant mandatory consent under a description that understates visibility (colleagues see everything) and mislabels operator access; the draft banner mitigates but consent records citing this text are being created today (and D-178 already shows their version field is a constant).

**Direction (not an implementation).** Correct the visibility sentence now (it is one paragraph), and give the 'binding policy before public launch' promise a register row with a trigger, naming the DPPA/Malabo review the vision already committed to.

### PT-08 [Medium] Localization was never considered: no i18n provision, and no register row, while the register itself names Francophone institutions as target adopters
*docs/VISION_AND_PLAN.md:1* — sweep confidence: confirmed

**Claim.** There is zero i18n provision — hardcoded lang='en', 'en-US' date formatting, all strings inline in JSX, no i18n library or locale routing — and, more telling, zero mention of language/localization anywhere in VISION_AND_PLAN.md and no DEFERRED_REGISTER row. This is not a deferral; it is a blind spot: D-112's own text names 'Francophone institutions across the DRC, Senegal, Côte d'Ivoire and Cameroon' as within the primary adopter class, and the AU Continental AI Strategy anchor spans 55 member states.

**Evidence.** app/layout.tsx:32 (lang='en'); dashboard/page.tsx:117 (toLocaleDateString('en-US')); package.json: no i18n dependency; grep -i 'i18n|francophone|multilingual|localiz' VISION_AND_PLAN.md: 0 hits; DEFERRED_REGISTER grep for i18n/language rows: none; DEFERRED_REGISTER.md:158 (D-112 names Francophone institutions as adopters).

**Impact.** A francophone university team cannot use the product in their working language, and because the question was never parked, nothing will trigger reconsideration; retrofitting i18n after more UI ships gets steadily more expensive — the same reach class the project polices elsewhere.

**Direction (not an implementation).** At minimum open a register row with a trigger (e.g. 'first non-anglophone pilot'); if cross-institutional Phase 3 is serious, string externalization should predate the Phase 2 UI build-out.

### PT-09 [Medium] Low-bandwidth/offline/mobile resilience appears nowhere in the vision or plan — a requirement the SPA baseline implicitly met was dropped without a decision
*docs/VISION_AND_PLAN.md:1* — sweep confidence: confirmed

**Claim.** The vision doc contains zero occurrences of offline, bandwidth, connectivity, or mobile; there is no service worker, no local draft persistence, and ~144KB of framework JSON is statically imported into client bundles. The predecessor SPA ran entirely client-side (progress in localStorage) and so tolerated dropped links; the platform made every interaction server-dependent without recording that this trades away resilience the actual adopters need — the project knows the context (shared-lab-machine session finding) but never asked the connectivity question.

**Evidence.** grep -i 'offline|bandwidth|connectivity|mobile' docs/VISION_AND_PLAN.md: 0 hits; du data/*.json: 80K questionBank + 48K areas + 12K scoring statically imported by the client assessment/report pages; no service-worker/PWA files in app/; VISION_AND_PLAN.md:14 (SPA: 'progress lives in localStorage').

**Impact.** Compounds PT-03: on intermittent campus networks the product is strictly less usable than the free tool it replaces; responsive layout exists (mobile drawer, flex/grid) but network resilience does not, and no register row will ever surface the question.

**Direction (not an implementation).** Record the dropped requirement as a register row; the PT-03 fix (local draft buffer + retry) is the highest-value slice of it.

### PT-10 [Medium] A11y posture: dead skip-link CSS never rendered, unlabeled score gauges, and hardcoded light-theme colors in charts that bypass the dark-theme token system
*components/dashboard/ScoreGauge.tsx:53* — sweep confidence: probable

**Claim.** Fundamentals in sampled components are good (PT sound list), but: (1) .skip-link styles exist in globals.css while no component renders a skip link — keyboard users tab the full sidebar on every page, and the CSS is presence-without-behaviour; (2) ScoreGauge shows a bare number with no accessible name (a screen reader hears '87' with no context; contrast the report ring which does it right); (3) ScoreGauge/TrendChart/RadarChart/GapHeatmap hardcode light-theme hex values inline (label #1A1F36, grids/borders #E5E7EB) inside an otherwise token-driven dark-theme system — the gauge label is dark-navy-on-dark-card in dark mode. D-049 concedes the accessibility posture as a whole was inherited from the SPA and never audited.

**Evidence.** globals.css:552-564 (.skip-link rules); grep 'skip-link|Skip to' across all .tsx: zero renders. ScoreGauge.tsx:43-58 (no aria-label; inline color:'#1A1F36'); globals.css:1000 (.score-gauge has no color override, and inline style would beat it anyway); GapHeatmap.tsx:101-161, TrendChart.tsx:51-65, RadarChart.tsx:96-119 (hardcoded hex). DEFERRED_REGISTER.md:95 (D-049: accessibility posture 'never subjected to the ADOPT/ADAPT/RE-DERIVE/RETIRE gate'). Dark-mode illegibility inferred from code, not visually rendered.

**Impact.** An RAI tool that scores others on inclusion while shipping unlabeled data visualizations and an unreachable-by-keyboard main content area undercuts its own credibility; the dark-mode gauge is the B4/B6 Phase-0 dark-theme class recurring in new components.

**Direction (not an implementation).** Render the skip link the CSS already styles; give ScoreGauge role='img' + aria-label like the report ring; replace hardcoded chart hexes with the existing CSS custom properties.

### PT-13 [Medium] No email verification at registration — any address can be claimed, undermining consent records and invitation trust
*app/api/auth/register/route.ts:17* — sweep confidence: confirmed

**Claim.** Registration creates an account and org for any unverified email address; there is no emailVerified field, no verification token flow, and no verification email — while consent records (an 'ISO-42001-relevant compliance record', per the codebase's own comment) are minted against that unverified identity. Email infrastructure exists (Resend, used for invitations), so this is unbuilt, not unbuildable.

**Evidence.** prisma/schema.prisma User model (71-99): no emailVerified field; app/api/auth/register/route.ts: no verification step, immediate bootstrapOrgWithOwner; grep 'emailVerified|verify.*email' schema + lib/auth: no hits; lib/email/send.ts exists.

**Impact.** Consent and research-consent records attach to identities never proven to control the email; someone can register as a colleague's address. Reported for the identity/security auditor's dimension.

**Direction (not an implementation).** Route to the identity/auth audit dimension; a verification email is a small delta on the existing invitation-token + Resend pattern.

### PT-11 [Low] README is stock create-next-app boilerplate with zero product identity or operator documentation
*README.md:1* — sweep confidence: confirmed

**Claim.** The repo's front door says nothing about what the product is, and none of the real setup (Postgres provisioning scripts, RLS roles, docker compose, seed, env requirements) is documented there — despite package.json carrying bespoke db:provision/docker scripts an adopter or operator would need, and despite the product's own framework diagnosing documentation deficit (PO-07) in others.

**Evidence.** README.md:1-36 is verbatim create-next-app output ('This is a Next.js project bootstrapped with create-next-app... Deploy on Vercel'); package.json scripts db:provision, docker:up, test:security exist undocumented.

**Impact.** For cross-institutional adoption or a second operator, onboarding knowledge lives only in AGENTS.md/docs internals written for the build process, not for users or deployers.

**Direction (not an implementation).** A one-page README naming the product, the stack, and the local-run sequence (provision → migrate → seed → dev) would discharge this.

### PT-12 [Low] VISION_AND_PLAN.md's Phase 1 scope has drifted from the register's re-targeting without amendment
*docs/VISION_AND_PLAN.md:134* — sweep confidence: confirmed

**Claim.** The 'persistent source of truth' still lists 'evidence attachment + credibility tiers' as Phase 1 scope (line 134), while D-001 re-targeted credibility tiers to Phase 2 on 2026-08-05 with justification. The doc is amended selectively (§4.3 carries a 2026-08-02 amendment) so the phase criteria have silently diverged from the register — a reader of the vision alone believes Phase 1 delivers tiers.

**Evidence.** VISION_AND_PLAN.md:134 ('evidence attachment + credibility tiers') and :3 (Last updated 2026-07-19, §4.3 amended 2026-08-02); DEFERRED_REGISTER.md:47 (D-001 'Open — re-targeted 2026-08-05... Aligned to D-002's existing target (Phase 2)').

**Impact.** The two authoritative documents disagree about what Phase 1 means; anyone evaluating phase completion from the vision doc would mark it failed, or worse, assume tiers exist.

**Direction (not an implementation).** Amend the Phase 1 bullet with the same dated-amendment convention §4.3 already uses, pointing at D-001.

**Not examined by this auditor:**
- Live browser run of the app (register → assess → report driven end-to-end), including visual confirmation of dark-mode chart contrast and the actual first-run feel — Audit is read-only; starting the dev server, seeding a DB, and driving flows risks writing state; PT-10's dark-mode claim is therefore marked probable
- Bundle-size measurement (next build output) — Build writes to the repo (.next); relied on dependency and static-import signals instead
- PDF report content depth (D-028) and lib/pdf/ReportPdf.tsx — Would need a rendered PDF to judge; already register-tracked as open
- DEFERRED_REGISTER.md end-to-end (379 lines, some rows >2KB) — Read via targeted greps and full reads of ~15 relevant rows; other rows outside product-truth scope left to their dimensions
- explore/framework and explore/controls page bodies in detail; admin pages; MembersManager and invitation-accept flows in full — Sampled for existence, a11y basics, and content-reality signals only; deep review belongs to UI/authz dimensions
- Assessment engine scoring correctness and framework content accuracy (21 areas/28 controls vs cited sources) — Another auditor's dimension; product-truth only verified what the UI headlines and what the content claims to be sourced from
- Terms of Service legal adequacy (liability, governing law) — Requires legal judgment beyond code audit; noted only the factual mismatches and missing-regime observations

## reports-pdf-export

The provenance core is genuinely strong: one shared formatter and one shared drift-banner copy source feed both surfaces, the PDF route refuses non-completed assessments and renders only cached reportData (the D-191 defect is closed and pinned by non-vacuous tests), and the users/me export is double-scoped and leak-tested. The real problems are at the edges: every mitigation-control link on the report page points at a route that does not exist (/controls instead of /explore/controls); the PDF header renders assessor/project names unsanitized while the same file's own sanitizer exists precisely for that class; the auditor-facing evidence manifest silently truncates at 1000 rows via a browsing-endpoint cap whose register row does not know the PDF consumes it; and the exported PDF omits the report's entire findings content, so "faithful render" holds only for the thin subset it shows. The personal-data export's completeness claim is conditional on current active memberships in ways its own doc comments elsewhere argue against.

**Sound (what is genuinely good):**
- Provenance single-sourcing is exemplary: formatProvenanceLine and driftBannerText live in one dependency-free module (lib/report/provenance.ts) consumed by both surfaces, with exact-copy and right-variant tests (report-provenance.test.tsx:180-197, 241-255) so the copy cannot drift or be misassigned per surface.
- The D-191 lesson is genuinely closed in current state: the PDF route 409s any non-completed assessment (pdf/route.ts:108,171-180), renders only cached reportData (never generateReportData), and throws loudly rather than regenerating if reportData is null (pdf/route.ts:210-214); the guarding tests prove the refused fixtures COULD have rendered (report-provenance.test.ts:428-440), so the gate is non-vacuous.
- Evidence manifest is metadata-only by construction (listEvidenceForAssessment never includes the blob) AND by runtime proof: the no-bytes test feeds rows carrying a content field and asserts it never renders (report-provenance.test.tsx:292-296).
- PDF content-stream injection was analyzed against the actual renderer source (hex-encoded glyph show operators), not assumed from React behavior (ReportPdf.tsx:107-127), and the Content-Disposition filename is sanitized against header injection (pdf/route.ts:252).
- users/me export is double-scoped (active memberships via orgContextsForUser AND where:{uploadedById}) with integration tests for both cross-user and ex-org leakage (export-evidence.test.ts:137,158); identityDb's assertNoTenantRelation blocks tenant-data inclusion structurally.
- The fetch-then-render split keeps the withOrg transaction short instead of holding a pooled connection through the CPU-bound render (pdf/route.ts:69-74), and the not-completed gate was placed inside the transaction before the expensive reads (pdf/route.ts:95-108).

### R-01 [High] Every mitigation-control link on the report page targets a nonexistent route (/controls)
*components/report/AreaCard.tsx:137* — sweep confidence: confirmed

**Claim.** AreaCard's ControlsList links each suggested control to `/controls#${cId}`, but the controls explorer lives at /explore/controls; no /controls page or redirect exists, so every control link in every gap and attention card on the report page is a dead link.

**Evidence.** components/report/AreaCard.tsx:137 `<Link href={`/controls#${cId}`}` — vs `find app -type d -name controls` returning only app/(authenticated)/explore/controls; app/(authenticated)/explore/framework/page.tsx:117 links `/explore/controls#${cId}` correctly; next.config.ts contains no redirects()/rewrites() (read whole file); repo-wide grep for '/controls' shows AreaCard.tsx:137 is the only remaining wrong-path referrer.

**Impact.** The report's core actionable output — 'here are the controls to close this gap' — 404s for every user who clicks it. This is exactly the 'URL moves' SPA-port class AGENTS.md §3 documents (8 pages missed under the imports-prisma lens).

**Direction (not an implementation).** Point the link at /explore/controls#${cId}, matching framework/page.tsx; consider a link-target existence check in tests since this class already recurred.

**Verification: CONFIRMED.** The wrong href exists exactly as claimed and no mechanism anywhere in the repo rescues it: no /controls page (only app/(authenticated)/explore/controls, which serves /explore/controls since route groups add no URL segment), no redirects()/rewrites() in next.config.ts (read whole file — only headers()), nothing in proxy.ts, no middleware.ts, no catch-all beyond api/auth/[...nextauth]. The links render in practice, not just theoretically: report/page.tsx mounts AreaCard with controlsMap at four sites, ControlsList fires for gap and attention tiers, and 22 areas in data/assessmentAreas.json carry non-empty controls arrays. I tried to kill it via redirects, proxy rewrites, an alternate page, a register row accepting it, and test coverage — all empty; the correct pattern (/explore/controls#${cId}) already exists at explore/framework/page.tsx:117 and the target page's hash-scroll handler works, confirming the link is simply wrong. High is the right severity: every mitigation link on the report's core actionable output 404s, the target content lost (notebooks, resources, templates, linked areas) is substantive, and no running test or register row covers it — but it is not Critical since no tenancy/security/data-integrity property breaks and the control name/description remain visible inline on the card.

*Verifier evidence:* components/report/AreaCard.tsx:137 (`<Link href={`/controls#${cId}`}`); `find app -type d -name controls` -> only app/(authenticated)/explore/controls; next.config.ts:1-64 (no redirects/rewrites); `grep -n controls proxy.ts` -> empty; report/page.tsx:305,338,369,401 + useFindingsData.ts:130-131 + python count of assessmentAreas.json -> 22 areas with non-empty controls; explore/framework/page.tsx:117 and explore/controls/page.tsx:33-36 (correct path + hash handler); grep of __tests__/ and e2e/ for the href -> nothing; grep -i controls docs/DEFERRED_REGISTER.md -> no row for this link

### R-02 [Medium] PDF header renders assessorName and projectName without sanitizeManifestText, though both can legally contain CR/LF
*lib/pdf/ReportPdf.tsx:146* — sweep confidence: confirmed

**Claim.** sanitizeManifestText exists to stop stored names/filenames with embedded newlines from breaking PDF layout, and is applied to manifest filename and uploaderName — but the header subtitle renders projectName and assessorName raw, and lib/validate.ts's sanitizeInput deliberately preserves \t, \n, \r (its strip class is [\x00-\x08\x0B\x0C\x0E-\x1F\x7F]), so a registered User.name (≤100 chars) or Project.name (≤200 chars) containing newlines reaches @react-pdf/textkit unsanitized.

**Evidence.** lib/pdf/ReportPdf.tsx:146 `<Text style={styles.subtitle}>{projectName} {'·'} {assessorName} …` (no sanitize call) vs lines 226-228 where filename/uploaderName are wrapped; lib/validate.ts:68-72 regex excludes \x09/\x0A/\x0D; ReportPdf.tsx:67-74's own doc comment names User.name as an at-risk source 'via the same uploader-name lookup every OTHER name on this PDF already goes through'.

**Impact.** A name with up to ~50 embedded newlines multiplies the header's visual lines, pushing content and potentially paginating the header block — the exact layout-boundedness property the sanitizer was written to protect (not injection; that is separately ruled out). Same User.name is sanitized in one place on the document and raw in another.

**Direction (not an implementation).** Apply sanitizeManifestText (or a header-scoped variant) to projectName and assessorName at the same rendering boundary.

### R-03 [Medium] Auditor-facing evidence manifest silently truncates at 1000 rows, and the register row tracking the cap does not list the PDF as a consumer
*app/api/v1/orgs/[slug]/reports/[id]/pdf/route.ts:124* — sweep confidence: confirmed

**Claim.** The PDF route builds its evidence manifest via listEvidenceForAssessment, which is hard-capped at EVIDENCE_LIST_LIMIT=1000 as an explicitly browsing-endpoint stopgap; a >1000-row assessment gets a manifest missing its oldest rows with no disclosure in the document — while the codebase's own reasoning for the sibling export function says a silently truncated export 'would itself be the exact false statement about what the system holds'. D-155 (the cap's register row, reconciled 2026-08-12) still names only two consumers and omits the PDF route.

**Evidence.** app/api/v1/orgs/[slug]/reports/[id]/pdf/route.ts:124 `listEvidenceForAssessment(id, tx)`; lib/data/evidence.ts:74,87 cap; lib/data/evidence.ts:103-108 (the no-cap-for-exports argument); docs/DEFERRED_REGISTER.md:204 D-155: '`GET .../evidence` (this route) and Task 10's attach UI are the only two consumers today' — the PDF route is a third.

**Impact.** An assessment exceeding the cap produces a PDF whose 'Evidence' section is an incomplete statement handed to an auditor with no truncation marker; and the deferral row that should trigger the fix undercounts the affected surfaces, so its pick-up condition can fire without anyone treating the manifest as affected.

**Direction (not an implementation).** Either lift the cap for the manifest (the export-completeness argument in the same file applies verbatim), or render an explicit 'N of M items shown' disclosure; update D-155's consumer list either way.

### R-04 [Medium] The exported PDF omits the report's entire findings content — gaps, attentions, strengths, mitigations, cross-stage influences
*lib/pdf/ReportPdf.tsx:139* — sweep confidence: confirmed

**Claim.** The PDF renders only overallScore, stage count, maturity label, per-principle percentages, and the evidence manifest; the HTML report's largest and most decision-relevant sections (area cards with per-question findings, suggested mitigations/controls, influence analysis, not-assessed areas) do not appear in the exported document at all. This is a structural consequence of the cached-only design (findings are never snapshotted, D-175) rather than a recorded decision about the PDF's scope — no register row names the omission itself.

**Evidence.** lib/pdf/ReportPdf.tsx:139 destructures only `{ overallScore, completedStages, principleScores }`; the component renders no findings/areas/controls sections (read whole file, 239 lines) vs report/page.tsx:289-416 rendering strengths/attentions/gaps/notAssessed AreaCards and InfluenceCards; docs/DEFERRED_REGISTER.md:224 (D-175) records findings-not-frozen and :232 (D-183) records no-draft-export, but neither records 'the completed-report PDF carries no findings'.

**Impact.** The artifact a team circulates or archives — the one the provenance line makes audit-grade — contains none of the report's actual findings; two readers of 'the report' (page vs PDF) see materially different documents. The audit question 'does the PDF faithfully render what the page shows' is answered: same data source for what it shows, but a strict small subset.

**Direction (not an implementation).** Record the omission as its own register row tied to D-175/Plan 2a (findings become PDF-includable exactly when they are snapshotted at completion), so the PDF's thinness is a decision, not an accident.

### R-05 [Medium] Maturity thresholds and labels exist as three independent copies (PDF inline ternary, getLevel, page legend)
*lib/pdf/ReportPdf.tsx:179* — sweep confidence: confirmed

**Claim.** The 75/50/25 maturity thresholds and their labels are implemented independently in ReportPdf's inline ternary (with hardcoded label strings duplicating data/constants levelLabels), in useFindingsData's getLevel, and in the report page's hardcoded legend ranges — three mechanisms for one fact, the exact drift shape this codebase's own design decision #6 (cited throughout lib/report/provenance.ts) exists to forbid.

**Evidence.** lib/pdf/ReportPdf.tsx:179 `overallScore >= 75 ? 'Strong' : overallScore >= 50 ? 'Developing' : overallScore >= 25 ? 'Needs Work' : 'Critical'`; components/report/useFindingsData.ts:74-79 getLevel returning keys mapped through data/constants.ts:22-27 levelLabels; app/(authenticated)/orgs/[slug]/assessment/[id]/report/page.tsx:219 hardcoded `'75–100%' … '0–24%'` legend text.

**Impact.** A threshold or label change made in constants silently diverges the PDF (and the legend) from the HTML scorecards — the two report surfaces would then assign different maturity words to the same score, in a document whose whole provenance apparatus exists to prevent exactly silent divergence.

**Direction (not an implementation).** Have the PDF call getLevel + levelLabels (or extract both into a shared dependency-free module like provenance.ts), and derive the legend ranges from the same thresholds.

### R-06 [Medium] users/me export omits memberships and is silently incomplete for evidence in departed orgs, despite claiming completeness
*app/api/users/me/export/route.ts:88* — sweep confidence: confirmed

**Claim.** The export returns user scalars, consentRecords, and evidence metadata — but not memberships (which orgs, what role: personal data about the user, never discussed in O-17's spec line), not sentInvitations, and not account-state fields (failedLoginAttempts, lockedUntil, lastActiveOrgId). Evidence is further scoped to orgs where the caller currently holds an ACTIVE membership with evidence:read, so upload records in any org they left are silently absent — while the route's own doc calls the export 'a true, complete statement of WHAT the caller uploaded' and lib/data/evidence.ts refuses a row cap on exactly the grounds that a silently incomplete export is a false statement.

**Evidence.** app/api/users/me/export/route.ts:62-95 (full selection: user scalars + consentRecords + evidence only) vs prisma/schema.prisma:89-96 (User relations incl. memberships, sentInvitations); route.ts:45-47 'a true, complete statement of WHAT the caller uploaded'; lib/auth/context.ts:139-144 orgContextsForUser filters to active memberships with can(role,'evidence:read'); __tests__/integration/export-evidence.test.ts:158 pins the ex-org exclusion as intended; docs/superpowers/specs/2026-08-03-phase1b-wire-the-spine-design.md:486 O-17 rules only on assessments, silent on memberships.

**Impact.** As a data-subject export it is materially incomplete: a user cannot learn their own org affiliations/roles from it, and their upload history in departed orgs vanishes without disclosure — the same silent-incompleteness shape the codebase argues against elsewhere. The ex-org exclusion is a defensible security trade-off, but the export makes an unconditional completeness claim it cannot support.

**Direction (not an implementation).** Add memberships (org name/slug, role, dates) from the identity connection; either include departed-org evidence facts or state the active-membership scoping in the export payload itself; decide explicitly whether lockout/security fields belong.

### R-07 [Medium] Drift and completion failures are swallowed silently on the path into the report page, producing a feedback-free redirect loop
*app/(authenticated)/orgs/[slug]/assessment/[id]/AssessmentPageClient.tsx:608* — sweep confidence: confirmed

**Claim.** handleGenerateReport never checks res.ok on the PATCH or the POST /complete and its catch comment says 'Continue to report even if API call fails'; the complete route's carefully-distinct drift 409 (and any other refusal) is therefore never shown to the user — they are navigated to the report page, which redirects any non-completed assessment straight back, a silent loop. AssessmentPageClient contains no drift/matches handling at all. D-130 records the race and the missing res.ok checks, but predates the drift gate, whose deterministic dead-loop consequence it does not name.

**Evidence.** app/(authenticated)/orgs/[slug]/assessment/[id]/AssessmentPageClient.tsx:599-612 (silent catch + unconditional router.push to report); grep for 'drift|matches' in that file returns nothing; app/api/v1/orgs/[slug]/assessments/[id]/complete/route.ts:39-53 (409 drifted); report/page.tsx:60-63 (redirect back when not completed); docs/DEFERRED_REGISTER.md D-130 row title 'a lost race fails SILENTLY (no res.ok check on either)'.

**Impact.** Under content drift — the one condition the whole provenance apparatus exists to disclose — the primary UI gives the user zero indication: answers stop saving (silent autoSave catch), completion silently fails, and 'View Report Now' bounces. Server-side messages were made distinct explicitly for diagnosability, and no client surface ever renders them.

**Direction (not an implementation).** When D-130 is picked up (Phase 1d-ii per D-109's note), extend it to surface the drift 409's message in the completion modal rather than only fixing the race.

### R-08 [Low] Quick-mode completed assessments: PDF exports a misleading '0/3 Stages Assessed' document the HTML page refuses to show
*lib/data/assessments.ts:176* — sweep confidence: confirmed

**Claim.** completeAssessment still writes quick-mode reportData with completedStages: [] and no principleScores/stageScores; the PDF route's gates (status completed + reportData non-null) both pass, so it renders a document showing '0/3 Stages Assessed' with an empty principle section, while the HTML page shows 'No Assessment Data Found' for the same row. Only reachable for legacy rows since creation now rejects mode !== 'full'.

**Evidence.** lib/data/assessments.ts:165-186 (quick branch writes `completedStages: []`, no principleScores); lib/pdf/ReportPdf.tsx:174 `{completedStages.length}/3`; report/page.tsx:149 `report.completedStages.length === 0` → empty state; app/api/v1/orgs/[slug]/assessments/route.ts:51-52 `mode must be "full"`.

**Impact.** If any quick-mode completed row exists (legacy or future re-enable), the two surfaces disagree about whether a report exists at all, and the exported document under a full provenance line reads as a zero-stage assessment.

**Direction (not an implementation).** Either gate the PDF route on completedStages.length > 0 (matching the page), or give quick reportData a real PDF shape; decide alongside D-131's QuickAssessment disposition.

### R-09 [Low] PDF footer/header lack react-pdf's `fixed` prop, so multi-page documents lose them on continuation pages
*lib/pdf/ReportPdf.tsx:235* — sweep confidence: probable

**Claim.** The footer is absolutely positioned but not marked `fixed`, and the header is ordinary flow content; when the manifest or principle list wraps past one A4 page (react-pdf Pages wrap by default), continuation pages carry neither header (provenance line) nor footer.

**Evidence.** lib/pdf/ReportPdf.tsx:34 footer style `position: 'absolute', bottom: 30…` and :235 `<Text style={styles.footer}>` with no `fixed` prop; :143 `<Page size="A4" style={styles.page}>` with no wrap suppression; a 1000-row manifest (R-03's cap) guarantees many pages.

**Impact.** On any multi-page export, pages 2..n have no provenance line and no generator footer — the provenance disclosure is exactly the thing that should be on every page of an audit artifact.

**Direction (not an implementation).** Add `fixed` to the footer (and consider a slim repeated header with the provenance line).

### R-10 [Low] PDF derives stage display names by string-munging ('Pre Processing') instead of the shared stageLabels ('Pre-processing')
*lib/pdf/ReportPdf.tsx:192* — sweep confidence: confirmed

**Claim.** ReportPdf title-cases stage ids via regex, producing 'Pre Processing'/'In Processing', while the HTML page uses data/constants stageLabels ('Pre-processing', 'In-processing') — a second small two-mechanisms-for-one-fact instance in the same file as R-05.

**Evidence.** lib/pdf/ReportPdf.tsx:192 `stage.replace(/-/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())` vs data/constants.ts:10-14 stageLabels used by report/page.tsx:268.

**Impact.** Cosmetic divergence between the two report surfaces; a renamed or added stage label would only ever be right on one of them.

**Direction (not an implementation).** Import stageLabels (it is plain data, safe for the PDF module) or pass labels in from the route.

### R-11 [Low] CPU-bound PDF rendering is governed only by the generic 60/min/user in-memory rate limit
*app/api/v1/orgs/[slug]/reports/[id]/pdf/route.ts:235* — sweep confidence: probable

**Claim.** renderToBuffer executes react-pdf layout in-process per request; the route matches only RATE_LIMITS 'default' (60/min per userId, in-memory, known multi-instance-weak), with no PDF-specific budget — 60 renders/min/user of up-to-1000-row manifests is a lot of event-loop work an authenticated member can demand.

**Evidence.** app/api/v1/orgs/[slug]/reports/[id]/pdf/route.ts:235 renderToBuffer in the handler; lib/rate-limit.ts:70 `'default': { window: 60*1000, max: 60, keyBy: 'userId' }` with no reports/pdf-specific key (read the RATE_LIMITS map); route's own comment (:69-74) acknowledges render cost by keeping the DB transaction out of it.

**Impact.** A single hostile or scripted member can keep an app instance busy with renders within the allowed budget; the in-memory limiter's multi-instance weakness is already registered elsewhere, but no entry considers this endpoint's asymmetric cost.

**Direction (not an implementation).** Add a tighter RATE_LIMITS key for GET reports/*/pdf (renders per user per window), sized after measuring a worst-case manifest render.

### R-12 [Low] The only live end-to-end proof of report page + PDF download is disabled (test.fixme)
*e2e/assessment-flow.spec.ts:48* — sweep confidence: confirmed

**Claim.** e2e/assessment-flow.spec.ts's 'create, answer, complete, view report, download PDF' test — the sole browser-level verification that the report renders and the PDF actually downloads — is marked test.fixme and does not run; the flake is root-caused and registered (D-185), but the practical effect is that this dimension currently has zero running live verification, with everything resting on node-environment element-tree walks and route-handler tests.

**Evidence.** e2e/assessment-flow.spec.ts:48 `test.fixme('create, answer, complete, view report, download PDF', …)`; docs/DEFERRED_REGISTER.md:234 (D-185, root cause found 2026-08-10, still open); no other e2e spec exercises the report page or PDF (grep across e2e/).

**Impact.** Regressions that only manifest in a real browser or real @react-pdf render (e.g. R-01's dead links, R-09's pagination) have no automated live check; the project's own C5 rule makes live verification the definition of done.

**Direction (not an implementation).** Re-enable under D-185's root-cause fix, or split the report/PDF tail into its own smaller spec that does not depend on the flaky 24-question answering run.

### R-13 [Low] Provenance hash covers content files only; findings copy and engine logic can change without drift disclosure
*lib/framework/bundleHash.ts:18* — sweep confidence: confirmed

**Claim.** BUNDLE_FILES deliberately excludes data/constants.ts (ratingLabels feed every likert finding's 'reason' string) and all engine code; a change to either alters what the report page displays or how findings are worded with matches still true and no banner. The content-file exclusion is documented as deliberate; the residual is that 'assessed against content <hash>' does not cover everything the findings surface derives from.

**Evidence.** lib/framework/bundleHash.ts:14-23 ('data/constants.ts is deliberately EXCLUDED: it is code (rating labels), not framework content') and the four-file BUNDLE_FILES list; components/report/useFindingsData.ts:6-7 imports ratingLabels and engine functions used to rebuild findings.

**Impact.** Low in practice (labels/engine ship with the app and change via deploy), but an auditor comparing two views of one pinned assessment can see differently-worded findings with no drift signal — adjacent to, and not covered by, D-175.

**Direction (not an implementation).** None urgent; note it wherever D-175/Plan 2a decides the snapshot boundary, so 'what the pin covers' is settled deliberately.

**Not examined by this auditor:**
- Live browser verification of the report page and an actual rendered PDF (multi-page behavior, footer placement, drift banner appearance) — Read-only audit; did not start the dev server or run Playwright. The repo's own live test for this path is test.fixme'd (R-12), so no recorded run substitutes.
- Measured renderToBuffer CPU/memory cost for large manifests (R-11's operational impact) — Would require executing code against the repo; kept R-11 at 'probable' instead.
- components/report/ControlResourcesList.tsx and ReferencesList.tsx internals — Verified they are consumed only by the explore pages, not by the report data flow; deep review belongs to the explore/content dimension.
- AssessmentEngine.js scoring correctness (calculatePrincipleScores, modifiers) and questionBank/scoringConfig content validity — Separate audit dimension; I verified only what the report surfaces read from it (generateReportData shape, rounding at line 733).
- ReportPage.css / visual styling correctness — No rendering performed; CSS-only defects are invisible to static reading at reasonable cost.
- DELETE /api/users/me erasure flow beyond what the export/PDF comments claim about scrubbing — Identity-lifecycle dimension; I read scrubUserOnDeactivation's doc and D-174 only far enough to verify the manifest's 'Deleted user'/'Unknown' claims are accurate.
- RLS policies and withOrg internals backing the tenant reads these routes make — Tenancy is another auditor's dimension; I verified only that these routes use the sanctioned paths (withOrg, listEvidence*, identityDb) per ADR-0001 and add no ad hoc orgId filters.

## tenancy-rls

The RLS mesh itself is genuinely strong and was verified live: all 9 orgId-bearing tables plus organizations are ENABLE+FORCE with byte-identical fail-closed policies, the app role is NOSUPERUSER/NOBYPASSRLS with a runtime identity assertion, the GUC is transaction-scoped and parameterised, and the test suite attacks policy predicates rather than mere existence. The weaknesses are one layer up: a confirmed schema-drift landmine (the next `prisma migrate dev` proposes DROP of the evidence dedup constraint), no concurrency control on the assessment write paths despite doc comments claiming a single transaction fixed the race (Assessment.version is an attempt counter, not the optimistic lock its position suggests), one parent-child FK edge (evidence.remediationItemId) that breaks the project's own composite same-org standard, and leftover blanket grants that let the app role hard-DELETE the current organization. The deletion/audit story is under-designed for a governance product: org deletion is a column with no writer, project delete cascades away "immutable" completed assessments and their evidence, and privilege changes leave no persistent audit trail.

**Sound (what is genuinely good):**
- RLS coverage verified live against makrai_test: all 9 orgId tables + organizations show relrowsecurity=t, relforcerowsecurity=t; policies are FOR ALL with USING and WITH CHECK both present, NULLIF fail-closed, no ::uuid cast (catalog query output in this audit).
- withOrg design is pool-safe: set_config(...,true) is transaction-scoped and parameterised inside one interactive transaction (lib/data/tenant.ts:218); spike probe F verified no GUC residue on a reused pooled connection; `options: ''` on every Pool plus requireDatabaseUrl's rejection of in-URL `options` closes the PGOPTIONS pre-set-GUC vector (lib/data/connection.ts:52-64).
- assertRestrictedIdentity checks rolsuper/rolbypassrls on the live connection once per process, closing the 'URL present but points at owner' fail-open (lib/data/tenant.ts:144-162); requireDatabaseUrl rejects partial URLs that would fall back to PG* (connection.ts:39-51).
- Defense-in-depth DDL guards: event trigger auto-enables RLS+FORCE on new orgId tables for all three table-creating tags with catalog/OID column lookup (20260803074244:125-153); a second event trigger refuses views without security_invoker=true (20260803140500:37-61); default privileges for makrai_app were revoked (20260803140500:27-28, confirmed live via pg_default_acl test).
- Test quality is exceptional for this dimension: tenant-schema.test.ts asserts the policy predicate text, cmd=ALL, roles={public}, pins the table population as a hand-updated tripwire, special-cases organizations, and pins the event trigger's enabled state and tags — each hardening traceable to a real bypass that was reproduced live first.
- Composite same-org FKs applied consistently on project_metadata, assessments, remediation_items, evidence→assessments, and evidence_blobs→evidence, with the redundant UNIQUE(orgId,id) targets documented; T4 tests prove cross-tenant references are refused.
- Membership paths got concurrency right: SELECT ... FOR UPDATE before the last-owner count in removeMember (lib/data/members.ts:130) and in DELETE /api/users/me (app/api/users/me/route.ts:97), with the READ COMMITTED race explicitly reasoned.
- identityDb's construction-not-interception allowlist (v5 after five documented bypass generations), the deliberate absence of delete/deleteMany because a User delete cascades into tenant tables on the BYPASSRLS connection, and least-privilege grants on evidence tables (SELECT/INSERT/DELETE only, no UPDATE) are all well-reasoned and pinned by tests.
- The port migration's expand→backfill→constrain ordering, child orgId derived from parent rather than a flat constant, and the write-once frameworkVersionId trigger are all sound migration engineering.

### TEN-02 [High] No concurrency control on assessment write paths; doc comments claim a single transaction fixed a race it does not fix
*lib/data/assessments.ts:87* — sweep confidence: confirmed

**Claim.** respondToAssessment and completeAssessment do read-check-write inside one READ COMMITTED transaction with no FOR UPDATE, no status-guarded UPDATE, no isolationLevel, and no optimistic lock — so a concurrent autosave PATCH and complete can still interleave. Assessment.version is an attempt counter set once at creation, not an optimistic-lock token, despite occupying the position one would.

**Evidence.** lib/data/assessments.ts:65-92 (findUnique status check then `tx.assessment.update({ where: { id }, data: { engineState } })` with no status predicate) and 143-208 (findUnique, compute reportData from the read engineState, then `update({ where: { id } })`); doc comment at lines 30-36 claims 'Fixed by reading and writing inside ONE withOrg callback'. withOrg passes no isolationLevel (lib/data/tenant.ts:209). `grep -rn "FOR UPDATE" lib/` hits only members.ts:130. Assessment.version usage: only `version: existingCount + 1` at creation (app/api/v1/orgs/[slug]/assessments/route.ts:100); lib/data/framework.ts:42 confirms 'an attempt counter'.

**Impact.** Two real interleavings on a multi-user team platform: (1) autosave commits newer engineState between complete's read and write → completed assessment whose cached reportData/overallScore was computed from stale answers, then frozen forever by the O-24 immutability rule — the exact defect the comment says was fixed; (2) respond reads status=in_progress, complete commits, respond's update then mutates engineState on a completed assessment. Also plain lost-updates between two concurrent autosaves (whole-JSONB last-write-wins). Windows are milliseconds wide but autosave makes them frequent.

**Direction (not an implementation).** Lock the row (SELECT ... FOR UPDATE, as members.ts already does) or make the UPDATEs conditional (updateMany with status:'in_progress' in the where, checking count), and correct the doc comments that overclaim atomicity; consider making version a real optimistic-lock token for engineState writes.

**Verification: CONFIRMED.** Every element of the claim checks out and my refutation attempts failed: respondToAssessment does an unconditional `update({ where: { id } })` after a findUnique status check (no status predicate, no FOR UPDATE); completeAssessment reads engineState then updates by id only; withOrg passes no isolationLevel and the DB runs default READ COMMITTED (the project's own comment at members.ts:128 says so; no override exists in lib/, migrations, or docker config); the only trigger on assessments guards frameworkVersionId write-once, not status/engineState; FOR UPDATE exists on three other paths but not these; Assessment.version is written once at creation and never read as a precondition. The doc comment's 'Fixed by reading and writing inside ONE withOrg callback' genuinely overclaims — under READ COMMITTED the single transaction narrows but does not close the interleaving. The project's own register corroborates at High: D-104 and D-130 are both OPEN, D-104's corrected text confirms version 'is never incremented anywhere and never used as an update precondition', and D-130 records the race firing reproducibly in e2e runs with a silent user-facing failure — concrete impact, and a stale-scored completion is then frozen permanently by O-24 immutability. Known-and-registered does not reduce the defect. High stands (not Critical: no tenancy/security breach, requires a concurrency window).

*Verifier evidence:* lib/data/assessments.ts:66-87 (findUnique status check → update where {id} only), :143-205 (read engineState → compute → update where {id}), :26-36 ('Fixed by reading and writing inside ONE withOrg callback'); lib/data/tenant.ts:209 ($transaction, no options); grep 'FOR UPDATE' across lib/+app → only members.ts:130, app/api/users/me/route.ts:97, app/api/v1/orgs/[slug]/evidence/[evidenceId]/route.ts:276; prisma/migrations/20260807102031:72-73 (trigger guards frameworkVersionId only); app/api/v1/orgs/[slug]/assessments/route.ts:100 (version: existingCount + 1); docs/DEFERRED_REGISTER.md:150 (D-104) and :178 (D-130), both Open.

### TEN-01 [Medium] schema.prisma drift: next `prisma migrate dev` proposes dropping the evidence dedup constraint
*prisma/schema.prisma:372* — sweep confidence: confirmed

**Claim.** The `evidence_dedup_key` UNIQUE NULLS NOT DISTINCT constraint (the O-23 idempotency guarantee) exists only in migration SQL and is not represented in schema.prisma, so Prisma computes it as drift to be removed.

**Evidence.** Ran `DATABASE_URL=postgresql://makrai:...@localhost:5432/makrai_test npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` against the fully-migrated test DB (all 14 migrations applied, verified via _prisma_migrations). Output: `-- DropIndex\nDROP INDEX "evidence_dedup_key"`. Constraint created in prisma/migrations/20260808140048_evidence_tables/migration.sql:80-81; no matching @@unique in prisma/schema.prisma (models Evidence lines 340-378).

**Impact.** The very next `prisma migrate dev` for any schema change will include DROP of the constraint that backs upload idempotency and duplicate-evidence prevention; a developer accepting the generated migration silently destroys it, and createEvidence's check-then-act guard (TEN-10) then has no backstop. By the project's own AGENTS.md standard this is 'a latent defect with a timestamp on it'.

**Direction (not an implementation).** Either express the constraint in schema.prisma if the Prisma version supports it, or add a generated test pinning `prisma migrate diff` emptiness / the constraint's presence in pg_constraint (the project already has the T1 pattern for exactly this), plus a comment in schema.prisma warning that migrate dev will propose the drop.

**Verification: OVERSTATED (severity corrected to Medium).** The drift is real — I reproduced the auditor's diff myself and got exactly `DROP INDEX "evidence_dedup_key"`, and schema.prisma's Evidence model has no matching @@unique. But the stated impact is inflated: (1) the named vector cannot currently fire — `prisma migrate dev` is broken on this branch (P3006/P3018 shadow-DB replay failure on the unguarded REVOKE at 20260803062144:31, register row D-109 Open), so the branch's documented practice is hand-authored migrations via `migrate diff`; (2) the drop would not be silent — __tests__/integration/evidence-schema.test.ts:155-161 asserts a duplicate insert rejects with /evidence_dedup_key/, that file is inside vitest's `__tests__/**` include, and CI runs `prisma migrate deploy` (ci.yml:155) then the suite (ci.yml:179), so a migration containing the DROP fails CI loudly with the constraint name; (3) the exact risk is already registered as D-163 (Open) with D-109's re-target note explicitly coupling the two fixes ('fix both in one commit'). A pinning test of the shape the auditor recommends effectively already exists behaviorally. Real latent trap, Medium not High.

*Verifier evidence:* Ran `DATABASE_URL=postgresql://makrai:...@localhost:5432/makrai_test npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` → output only `DROP INDEX "evidence_dedup_key"`. Also: prisma/migrations/20260808140048_evidence_tables/migration.sql:80-81; prisma/schema.prisma:372 (@@unique([orgId,id]) only); __tests__/integration/evidence-schema.test.ts:155-161; vitest.config.ts:7 include pattern; .github/workflows/ci.yml:155,179; prisma/migrations/20260803062144_add_restricted_app_role/migration.sql:31; docs/DEFERRED_REGISTER.md rows D-109, D-163 (both Open).

### TEN-03 [Medium] evidence.remediationItemId is the one parent-child edge without the composite same-org FK, contradicting the project's own standard
*prisma/migrations/20260808140048_evidence_tables/migration.sql:61* — sweep confidence: confirmed

**Claim.** evidence.remediationItemId references remediation_items(id) as a plain single-column FK, so the database permits an evidence row in org A to reference a remediation item in org B — the exact class the same migration's deviation-1 comment calls 'a structural hole in O-1's own isolation guarantee' and closes for evidence_blobs with a composite FK.

**Evidence.** prisma/migrations/20260808140048_evidence_tables/migration.sql:61-62: `"remediationItemId" TEXT REFERENCES "remediation_items"("id") ON DELETE CASCADE ON UPDATE CASCADE` — contrast lines 70-72 (composite evidence→assessments) and 98-100 (composite blobs→evidence). FK validation runs with the referenced table's rights (the migration header for framework_versions cites the 2026-08-06 spike: 'RI checks run with the referenced table's rights'), so RLS does not constrain the referenced row. The only guard is app-level: the upload route resolves the item inside withOrg and checks target.assessmentId === id (app/api/v1/orgs/[slug]/assessments/[id]/evidence/route.ts:225-234); createEvidence itself (lib/data/evidence.ts:30-66) performs no such check for future callers.

**Impact.** If any future caller of createEvidence skips the route's check, a cross-org link is representable; the ON DELETE CASCADE then lets org B's remediation-item deletion cascade-delete org A's evidence row and blob (RI-triggered deletes bypass RLS), a cross-tenant destructive side effect. Today it is unreachable through the one existing route, but every sibling edge was made unrepresentable rather than merely unlikely — this one was not, and no comment records the inconsistency as deliberate.

**Direction (not an implementation).** Give remediation_items a UNIQUE(orgId,id) target and make the FK composite on (orgId, remediationItemId), matching every other child edge; or document explicitly why this edge is exempt.

### TEN-04 [Medium] makrai_app retains unused UPDATE/DELETE grants from the 2026-08-03 blanket grant, including DELETE on organizations
*prisma/migrations/20260803062144_add_restricted_app_role/migration.sql:20* — sweep confidence: confirmed

**Claim.** The blanket `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES` (20260803062144:20) was narrowed for users/consent_records/_prisma_migrations and for future tables, but existing tenant tables kept full CRUD; the app role holds UPDATE and DELETE on organizations (and UPDATE/DELETE on invitations) with zero application callers, and RLS USING permits the current-org row.

**Evidence.** Live query as makrai: grants to makrai_app show `organizations => DELETE,INSERT,SELECT,UPDATE`, `invitations => DELETE,INSERT,SELECT,UPDATE`. `grep -rn "organization\.(update|delete...)" lib/ app/` finds only tx.organization.create in lib/data/preauth.ts (owner connection); invitation.updateMany occurs only in preauth.ts:322 (owner connection). No revoke/rename route exists.

**Impact.** Any withOrg callback bug (or the D-088 raw-SQL footgun the project itself documents) can execute `DELETE FROM organizations WHERE id = <current org>` and cascade-destroy the entire tenant — projects, assessments, evidence, memberships — through the restricted role. The project applied exact least privilege to evidence ('granting only what the design uses is the whole point', 20260808140048:129-134) but never revisited the pre-existing blanket grants against actual usage.

**Direction (not an implementation).** Revoke UPDATE/DELETE on organizations (and audit invitations/project_metadata grants against real call sites) in a follow-up migration; add a T1-style test pinning the expected grant matrix so future grants are conscious.

### TEN-05 [Medium] Org deletion story is a column with no writer: deletedAt is never set, no deletion path exists, and slug uniqueness ignores soft-deletion
*prisma/schema.prisma:284* — sweep confidence: confirmed

**Claim.** organizations.deletedAt is read (preauth filters, requireOrgContext) but nothing in the codebase ever writes it, and no route soft- or hard-deletes an organization; meanwhile organizations_slug_key is a plain unique index, so a soft-deleted org would reserve its slug forever, and users.lastActiveOrgId (no FK, by design D-069) would dangle with no cleanup.

**Evidence.** `grep -rn "deletedAt: new Date|data: { deletedAt" lib/ app/` returns nothing; readers exist at lib/data/preauth.ts:84,92. Unique index: 20260802171529:53 `CREATE UNIQUE INDEX "organizations_slug_key"` with no partial WHERE deletedAt IS NULL. No org DELETE route under app/api.

**Impact.** The platform's tenant lifecycle has an entrance (bootstrapOrgWithOwner, createOrgForUser) but no exit: a university team that disbands cannot be offboarded, its data retained/erased per policy, or its slug reclaimed. When deletion is eventually implemented, the slug-uniqueness and lastActiveOrgId interactions are traps waiting; nothing in DEFERRED_REGISTER.md rows I read names the org-offboarding design as parked.

**Direction (not an implementation).** Design the org lifecycle deliberately (soft-delete semantics, retention window, slug reclamation via partial unique index, purge job) and register it as a deferred row with a trigger if it is intentionally later.

### TEN-06 [Medium] No persistent audit trail: privilege and lifecycle mutations leave no in-database record, and three mutable tables lack updatedAt
*prisma/schema.prisma:293* — sweep confidence: confirmed

**Claim.** Membership (role grants via updateMany, removals), Invitation (status transitions), and RemediationItem (completion toggling) carry no updatedAt and no history; the only audit mechanism, logSecurityEvent, writes JSON to console and is lost on container restart. The schema has no audit/event table at all.

**Evidence.** prisma/schema.prisma:293-306 (Membership: createdAt only), 308-324 (Invitation: createdAt/acceptedAt only), 222-242 (RemediationItem: createdAt/completedAt only). lib/security-logger.ts:59-69: console.error/warn/log only. Role grant: membership.updateMany at app/api/v1/orgs/[slug]/members/[userId]/route.ts:26-29 — no timestamp column is touched because none exists.

**Impact.** For an RAI-governance product whose own framework diagnoses documentation deficits (AGENTS.md §6 cites PO-03/PO-07), 'who made X an owner and when', 'when was this invitation revoked', and 'when did this remediation item last change' are unanswerable from the data. Prisma's @updatedAt is also app-side only, so even existing updatedAt columns are not maintained for raw-SQL writes.

**Direction (not an implementation).** Add updatedAt to the three tables; design a minimal append-only audit table (actor, action, target, orgId, timestamp) for privilege changes at least, or persist logSecurityEvent output somewhere durable.

### TEN-07 [Medium] Project hard-delete cascades away 'immutable' completed assessments and their evidence
*app/api/v1/orgs/[slug]/projects/[id]/route.ts:137* — sweep confidence: confirmed

**Claim.** O-24 makes a completed assessment immutable on every write path, but DELETE /projects/[id] hard-deletes the project and the CASCADE chain (assessments → remediation_items → evidence → evidence_blobs) silently destroys the completed records and uploaded evidence the immutability rule exists to preserve.

**Evidence.** app/api/v1/orgs/[slug]/projects/[id]/route.ts:137 `tx.project.delete({ where: { id } })`; cascade chain: 20260803034110:94 (assessments_orgId_projectId_fkey ON DELETE CASCADE), :97 (remediation_items CASCADE), 20260808140048:70-72 (evidence CASCADE), :98-100 (blobs CASCADE). completeAssessment's idempotency comment: 'a completed assessment keeps its original score/report' (lib/data/assessments.ts:147).

**Impact.** A single authorized project:delete erases the governance record — assessment scores, evidence bytes, remediation history — with no archival, soft-delete, tombstone, or audit entry. The immutability promise is write-path-deep only; nothing in the schema or register records this tension as a considered trade-off.

**Direction (not an implementation).** Decide deliberately: soft-delete projects, block deletion while completed assessments exist (RESTRICT), or export/tombstone on delete — and record the decision in an ADR or register row.

### TEN-08 [Medium] Transaction timeout/maxWait remain unpinned (D-065 open) while evidence upload now writes 10MB blobs inside the interactive withOrg transaction
*lib/data/tenant.ts:209* — sweep confidence: confirmed

**Claim.** withOrg inherits Prisma's default interactive-transaction limits (5s timeout, 2s maxWait); the evidence feature added a 10MB bytea INSERT inside that transaction after D-065 was written, materially raising the exposure the open row describes, and the row was never updated to reflect it.

**Evidence.** lib/data/tenant.ts:209 `appClient.$transaction(async (tx) => ...)` with no options; `grep -n "maxWait|timeout|isolationLevel" lib/data/*.ts` — no hits. lib/evidence/inspect.ts:10 `MAX_BYTES = 10 * 1024 * 1024`; createEvidence writes the blob via the caller's withOrg tx (lib/data/evidence.ts:57-63). docs/DEFERRED_REGISTER.md D-065: Open, 'timeout and maxWait defaults become load-bearing under this design and are currently unpinned'.

**Impact.** On a hosted DB with constrained app↔DB bandwidth, a near-limit upload can exceed the 5s default and abort with P2028 after the user waited — an availability failure whose cause (an inherited default) is invisible in code. Pool exhaustion under slow uploads also queues every other tenant request (maxWait 2s) since every request holds a connection for its duration.

**Direction (not an implementation).** Pin timeout/maxWait explicitly per ADR-0001's own note, or at minimum update D-065 to name the blob-write path so the risk row matches reality.

### TEN-09 [Low] Assessment.version attempt counter races: concurrent creates for one project get duplicate numbers
*app/api/v1/orgs/[slug]/assessments/route.ts:100* — sweep confidence: confirmed

**Claim.** version is computed as count(existing)+1 inside a READ COMMITTED transaction with no unique constraint on (projectId, version), so two concurrent creates both read N and both write N+1.

**Evidence.** app/api/v1/orgs/[slug]/assessments/route.ts:88,100: `const existingCount = await tx.assessment.count({ where: { projectId } }); ... version: existingCount + 1`. No @@unique([projectId, version]) in schema.prisma (Assessment model lines 152-178).

**Impact.** Duplicate attempt numbers in the UI/report provenance; harmless to isolation but makes 'attempt 3' ambiguous as a historical reference for an audit-oriented product.

**Direction (not an implementation).** Add a unique (orgId, projectId, version) index and retry on conflict, or derive the label at read time.

### TEN-10 [Low] createEvidence idempotency is check-then-act: a concurrent duplicate upload 500s instead of returning the existing row
*lib/data/evidence.ts:33* — sweep confidence: confirmed

**Claim.** The findFirst-then-create pattern promises 'a retry ... returns the row already created rather than raising a constraint error', but two concurrent identical uploads both pass findFirst and the loser hits evidence_dedup_key P2002, which nothing catches.

**Evidence.** lib/data/evidence.ts:33-41 (findFirst, `if (existing) return existing`, then create). Route's 'conflict' outcome is the completed-assessment branch only (evidence/route.ts:187); `grep -n P2002` in the route: no hits; lib/http/toResponse.ts handles only NotFoundError/ForbiddenError, so P2002 falls through to 500.

**Impact.** A double-clicked or retried-in-flight upload intermittently returns 500 where the design intends idempotent 200/201; the O-23 comment overstates what the code guarantees (sequential retry works, concurrent does not).

**Direction (not an implementation).** Catch P2002 in createEvidence and re-fetch the existing row (the constraint makes this safe), turning the unique index into the idempotency mechanism it already is.

### TEN-11 [Low] Timestamp types are inconsistent: legacy tables use naive TIMESTAMP(3), new tables TIMESTAMPTZ(3)
*prisma/schema.prisma:198* — sweep confidence: confirmed

**Claim.** framework_versions and evidence deliberately use TIMESTAMPTZ(3) while every earlier table (users, projects, assessments, invitations.expiresAt, organizations.deletedAt) remains timestamp-without-time-zone; no comment records the split as a convention.

**Evidence.** 20260629133510_init:35-36 `TIMESTAMP(3)`; 20260807102031:12-14 and 20260808140048:69 `TIMESTAMPTZ(3)`; schema.prisma marks @db.Timestamptz(3) only on FrameworkVersion fields and Evidence.uploadedAt (lines 198-200, 368).

**Impact.** Correct today because Prisma normalizes to UTC, but any raw-SQL comparison (e.g. `expiresAt < now()`) or a DB server not on UTC introduces silent offset bugs; two conventions in one schema invite the wrong one being copied.

**Direction (not an implementation).** Document the convention (all-new-columns-timestamptz) or migrate the legacy columns; either way make it a stated rule.

### TEN-12 [Low] Port-migration backfill repairs divergent orgId for children but not for the root projects table
*prisma/migrations/20260803034110_port_tenant_tables_to_org_id/migration.sql:15* — sweep confidence: confirmed

**Claim.** The migration's own comment says deriving is unconditional 'so it also repairs any such pre-existing divergence', but the projects backfill is conditional (WHERE orgId IS NULL) — a pre-existing bogus non-NULL orgId from the init schema's nullable prep column would abort the migration at projects_orgId_fkey.

**Evidence.** prisma/migrations/20260803034110_port_tenant_tables_to_org_id/migration.sql:15 `UPDATE "projects" SET "orgId" = '...' WHERE "orgId" IS NULL;` vs the comment at lines 8-14 and the unconditional child updates at 16,19,22. projects.orgId existed nullable and FK-less since init (20260629133510:44).

**Impact.** Only bites a database that carried junk in the prep column — none known — but the migration's stated repair property does not hold for the one table where divergence cannot be derived away, and D-038 records that no production-data rehearsal has happened.

**Direction (not an implementation).** None needed retroactively for known DBs; note the asymmetry wherever D-038's production-migration rehearsal is picked up.

### TEN-13 [Low] evidence.sha256 lacks the format CHECK its sibling tokenHash has, though the dedup key depends on it
*prisma/migrations/20260808140048_evidence_tables/migration.sql:66* — sweep confidence: confirmed

**Claim.** invitations.tokenHash gets a `~ '^[0-9a-f]{64}$'` CHECK to make a non-digest value unrepresentable, but evidence.sha256 — equally load-bearing as a dedup-key component — has no such constraint.

**Evidence.** 20260803171630:17-19 (tokenHash CHECK) vs 20260808140048:66 (`"sha256" TEXT NOT NULL` with no CHECK) and :80-81 (dedup key includes sha256).

**Impact.** App code computes the hash today, but the table accepts any text; a future writer (import tool, migration backfill) could store non-hashes that silently defeat dedup comparisons. Inconsistent rigor between two structurally identical decisions.

**Direction (not an implementation).** Add the same hex-64 CHECK to evidence.sha256.

**Not examined by this auditor:**
- Live reproduction of the concurrency races (TEN-02, TEN-09, TEN-10) — Read-only audit; reproducing requires writing test harness code and mutating the shared test DB. Claims rest on directly-observed code plus documented Postgres READ COMMITTED semantics.
- Full bodies of preauth.ts (bootstrapOrgWithOwner, acceptInvitation, createOrgForUser) and the remaining ~200 lines of data-boundary.test.ts — Owner-connection authorization logic belongs primarily to the auth/boundary dimension; I verified the surface, pool config, and deletedAt filtering relevant to tenancy.
- Query-plan verification (EXPLAIN) of RLS-predicate index use at scale — No representative data volume exists in the test DB; index-shape analysis was done statically (orgId-leading composites align with the policy predicate) and found adequate.
- Behaviour behind an external pooler (PgBouncer modes) — No pooler in the environment; relied on ADR-0001's documented analysis (session/transaction OK, statement pooling incompatible), which is internally consistent.
- Whether prisma migrate dev would also disturb the CHECK constraints, event triggers, or policies — The live diff run surfaced only evidence_dedup_key, which is itself evidence Prisma ignores the policies/triggers/checks; not separately verified against a --create-only run since that writes a migration file (read-only rule).
- __tests__/integration/trigger-enumeration.test.ts, port-completeness, preauth-surface, helpers/db.ts, prisma/seed.ts — Adjacent dimensions (enforcement-wiring and test-infrastructure auditors); T1/T2/T4 and data-boundary were the tests my brief named.

## test-quality

This is an unusually self-aware test suite: non-vacuity is routinely proven by documented red-green reversion, anti-vacuity floor assertions guard generated checks, and the D-191 failure class is named in test comments. The historical D-191 defects I hunted for (oversize fixture on wrong branch, one-direction symmetric tests, shared 409 messages) are genuinely repaired. However, current instances of the same class survive: a 618-line engine suite asserts a test-local replica of classification logic whose production home (useFindingsData.ts) has zero coverage; the O-13 census excludes members-row controls by citing a test that does not assert them; the 726-cell permission matrix's central claim (catches wrong-action wiring) holds only up to grant-vector equivalence, and 9 write actions plus 6 read actions form two indistinguishable classes; and the core product journey (create→answer→complete→report→PDF) has its only assertive end-to-end test quarantined with test.fixme. Concurrency and full-state Postgres round-trip — the properties the server context added to the SPA-era engine — are tested nowhere.

**Sound (what is genuinely good):**
- Vacuity discipline is real and pervasive: isolation.test.ts pins the RLS policy PREDICATE text, the exact protected-table population, the DDL event trigger's enabled flag and all three command tags, and asserts the enumeration query cannot pass on an empty schema (isolation.test.ts:59-130, 202-211).
- policy.test.ts hand-writes the full role-by-action matrix independently of GRANTS ('A generated expectation that mirrors the implementation would assert nothing', policy.test.ts:7-8) and covers prototype-pollution/ToString-coercion denial cases most suites never think of.
- The historical D-191 oversize defect is properly repaired: evidence-inspect.test.ts builds pdfOverLimit with a VALID signature at MAX_BYTES+1 and asserts reason 'too large' specifically (lines 20-21, 59-64); evidence-upload.test.ts asserts the size gate's own 413+message, distinct from the parse branch (lines 304-339).
- e2e/security.spec.ts's rate-limit test is now two-sided (all 50 succeed AND #51 refused, with per-request remaining-counter assertions) and documents exactly what it does not prove (lines 142-191).
- trigger-enumeration.test.ts is a genuinely novel net (guards must have production CALLERS, pinned to exact sets so removals are conscious), with non-vacuity guards on its own greps (e.g. lines 88-97, 417-420).
- role-matrix.spec.ts's control-registry + owner-census design (lines 28-44, 368-406) is a strong answer to the enumerated-guards failure class, and uses expect.soft deliberately to avoid truncating evidence.
- effective-config.test.ts asserts the RESOLVED ESLint config per representative file rather than source text, including per-exemption-file pins — the right instrument for the flat-config replacement defect it guards.
- register-integrity.test.ts checks content (Open-but-Closed contradiction, contiguous IDs) not just shape — a direct repair of the D-191-class audit it documents.

### T-01 [High] Engine classification suite asserts a test-local replica; the production classifier (useFindingsData.ts) has zero coverage
*__tests__/engine/AdversarialClassification.test.js:33* — sweep confidence: confirmed

**Claim.** AdversarialClassification.test.js's classifyAreas() is a copy of classification logic written to match 'ReportPage.jsx lines 99-200' — a deleted SPA-era file. The logic now lives in components/report/useFindingsData.ts (a client hook, unrenderable without jsdom), which no test imports. All tier-classification assertions in the 618-line suite run against the replica, so a drift or regression in the production hook leaves the suite green.

**Evidence.** __tests__/engine/AdversarialClassification.test.js:25-33 ('Helpers: replicate the ReportPage evidence classification logic… using the same logic as ReportPage.jsx lines 99-200'); `find . -name "ReportPage*"` returns only components/report/ReportPage.css; production logic at components/report/useFindingsData.ts:128-150 (gapEvidence building); `grep -rln useFindingsData __tests__ e2e` matches only __tests__/unit/report-provenance.test.tsx, where it appears solely in comments (lines 88, 190).

**Impact.** The report's gap/attention/strength classification — the product's central output — is effectively untested: the suite proves the replica agrees with itself, exactly the 'assertion on a re-implementation of the thing under test' class, while appearing to provide deep adversarial coverage.

**Direction (not an implementation).** Extract the classification into a pure, hook-free module both useFindingsData and the tests import (the mutateThenConfirm extraction already established this pattern), or install jsdom/@testing-library per the approved ruling and test the hook directly.

**Verification: CONFIRMED.** Every load-bearing fact checks out first-hand: the 618-line suite's classifyAreas() is a test-local replica citing a deleted SPA file (ReportPage.jsx), all 16 tier-classification call sites assert against that replica, and the production classifier (useFindingsData.ts, a 'use client' hook) is imported by no test anywhere — its only test-file mentions are comments. I tried to kill it four ways and failed: no server-side duplicate of the classification exists (the PDF route renders only cached scores, so the hook is the sole production classifier), no e2e spec asserts gap/attention/strength report content (role-matrix's REPORT_CONTROLS is three navigation controls; evidence-lifecycle asserts only the provenance line), no lint test pins the hook's thresholds, and no register row records this gap — D-169 in fact corroborates it ('stateful... hook-bearing components have no unit-test coverage at all'). A regression in the product's central report output would ship green, while the suite advertises deep adversarial coverage; High stands.

*Verifier evidence:* __tests__/engine/AdversarialClassification.test.js:24-33 (replica + 'ReportPage.jsx lines 99-200' comment) and 16 classifyAreas call sites (grep); `find . -name 'ReportPage*'` → only components/report/ReportPage.css; components/report/useFindingsData.ts:145-241 (production tier logic, sole consumer app/(authenticated)/orgs/[slug]/assessment/[id]/report/page.tsx:14,115); `grep -rln useFindingsData __tests__ e2e` → only __tests__/unit/report-provenance.test.tsx (comments at :88,:190); `grep -rln 'gapEvidence|attentionEvidence|strengthEvidence' app lib components __tests__ e2e` → only the hook, the page, and the replica test; docs/DEFERRED_REGISTER.md D-169 (line 218), D-166/D-175 (line 215/224) — none records this gap.

### T-02 [High] The core product journey's only assertive end-to-end test is quarantined (test.fixme, D-185)
*e2e/assessment-flow.spec.ts:48* — sweep confidence: confirmed

**Claim.** e2e/assessment-flow.spec.ts — the only test that asserts create→answer→complete→view report→download PDF — is test.fixme'd, so it runs nowhere (local or CI). Full-mode completion is otherwise exercised only as unasserted setup (role-matrix.spec.ts beforeAll throws on non-ok but asserts nothing about output).

**Evidence.** e2e/assessment-flow.spec.ts:48 'test.fixme(\'create, answer, complete, view report, download PDF\''; .github/workflows/ci.yml:409-411 ('D-185's test.fixme() quarantine … REMAINS in place, so the assessment happy path…'); e2e/role-matrix.spec.ts:169-185 (complete via API, only ok() checked).

**Impact.** A regression anywhere in the full-mode answer→complete→report→PDF pipeline would pass CI. The quarantine is honestly recorded and log-visible, but the largest core promise currently has no assertive automated proof at any level; the flake cause was diagnosed as dev-machine load, which CI does not share, yet it is skipped in CI too (fixme, not skip-if-local).

**Direction (not an implementation).** Un-quarantine in CI (fixme → conditional skip on local, or rely on retries + --fail-on-flaky-tests which CI already has) or add an equivalent assertive integration-level test of the full-mode pipeline.

**Verification: OVERSTATED (severity corrected to High).** The core fact is real — test.fixme at e2e/assessment-flow.spec.ts:48 quarantines the only test asserting the full UI journey, and ci.yml:409-413 admits the gate does not cover it — but two supporting claims are false and one is stale, which inflates the stated impact. 'Full-mode completion is otherwise exercised only as unasserted setup' is false: evidence-lifecycle.spec.ts:149-174 (unquarantined, runs in CI) assertively completes a full-mode assessment and asserts the report page renders; 'no assertive automated proof at any level' is false: report-provenance.test.ts:327-441 drives the real PDF route and asserts a valid bounded application/pdf plus the 409-on-in-progress guard, and role-matrix.spec.ts:481-486 asserts report 200 per role with the Download-PDF control. The 'dev-machine load' cause is superseded — D-185's Task 7 investigation pinned a stale-GET answer-wiping product race at AssessmentPageClient.tsx:205, CI exposure is explicitly unmeasured, and the register forbids lifting the quarantine before the fix, so the finding's un-quarantine suggestion contradicts the recorded ruling. What survives — the UI-driven answer→complete→browser-download slice has zero assertive coverage anywhere, contains a known live unowned data-loss race, and sits in a 900-line component slated for imminent Phase 1d-ii modification — still carries concrete user impact, so the corrected severity remains High; only the claimed scope ('regression anywhere in the pipeline would pass CI', 'no proof at any level') narrows.

*Verifier evidence:* e2e/assessment-flow.spec.ts:48 (test.fixme, verified); .github/workflows/ci.yml:409-413; e2e/evidence-lifecycle.spec.ts:149-174 (asserted full-mode PATCH+complete, 409 on post-completion evidence delete, report provenance line visible); __tests__/integration/report-provenance.test.ts:327-441 (PDF route: 200, application/pdf, %PDF- magic, size bound, drift-size differential, 409 in-progress); e2e/role-matrix.spec.ts:481-486 (report 200 + REPORT_CONTROLS census incl. 'Download PDF'); docs/DEFERRED_REGISTER.md line 234 (D-185: root cause at AssessmentPageClient.tsx:205, CI exposure UNMEASURED, 'THE QUARANTINE... MUST NOT BE READ AS LIFTABLE BY THIS ROW').

### T-03 [Medium] Permission matrix's wrong-action detection claim holds only up to grant-vector equivalence; two large action classes are indistinguishable
*__tests__/integration/permission-matrix.test.ts:22* — sweep confidence: confirmed

**Claim.** The matrix header claims it catches 'a handler that consults a DIFFERENT action than the one ROUTE_ACTIONS declares'. Expected status is computed from can(role, declaredAction), so a handler consulting a different action with an identical grant vector produces identical cells. Today 9 write actions (project:create/update, assessment:create/update/respond/complete, remediation:update, evidence:create/delete) share {owner,admin,assessor}, and 6 actions (org/project/assessment/evidence/member:read, member:leave) are granted to all five roles. Only the three evidence:* actions have exact-string grep pins.

**Evidence.** lib/authz/policy.ts:27-52 (GRANTS vectors; reviewer and viewer rows also byte-identical at lines 50-51); __tests__/integration/permission-matrix.test.ts:22-28 (the claim), 564 (`const expected = !sameOrg ? 404 : can(user.role, action) ? successStatus : 403`); trigger-enumeration.test.ts:201-218 pins actions for evidence routes only.

**Impact.** A refactor that wires, e.g., the remediation PATCH to 'assessment:respond' or the assessments POST to 'project:create' passes all 726 cells, the SUCCESS_STATUS completeness check, and port-completeness — the exact substitution AGENTS.md records as a past brief defect ('a non-vacuity instruction naming two actions with identical grants') is a standing blind spot of the suite's flagship test.

**Direction (not an implementation).** Extend trigger-enumeration's exact-action grep pins to every ROUTE_ACTIONS entry (generated from the map itself), and correct the matrix's header comment to state the equivalence-class limit.

### T-04 [Medium] O-13 census excludes members-row controls on a false coverage claim; MembersManager gating untested at any level
*e2e/role-matrix.spec.ts:470* — sweep confidence: confirmed

**Claim.** role-matrix.spec.ts excludes Remove/Make-owner/Leave from the completeness census, asserting they are 'exercised by the invitation walk in e2e/two-orgs.spec.ts and are already client-gated by can() … — excluded from the census …, not untested.' The invitation walk asserts only the dashboard 'Start New Assessment' link and org reachability; it never opens the members screen or asserts any row control. With no jsdom, MembersManager's per-role visibility logic (including the mayRemove owner-demotion nuance requiring member:revoke_owner) has no test anywhere.

**Evidence.** e2e/role-matrix.spec.ts:470-473 (the claim) and :375 (census exclusion via el.closest('.admin-table')); e2e/two-orgs.spec.ts:145-172 (asserts h1, org links, Start-New-Assessment only); app/(authenticated)/orgs/[slug]/settings/members/MembersManager.tsx:112 (className="admin-table"), 120-142 (mayRemove/mayGrantOwner gating).

**Impact.** An obligation recorded as discharged by a test that does not test it — the exact D-191 shape. A regression showing Remove/Make-owner to viewers would pass every suite (server-side enforcement is still covered by the vitest matrix, so impact is UI-level 403-on-click, not privilege escalation).

**Direction (not an implementation).** Either add registry entries for the members-row controls (scoped .first() like the evidence controls) or correct the comment to name the gap honestly and open a register row.

### T-05 [Medium] No check that every EXPORTED HTTP method of a route is declared in ROUTE_ACTIONS
*__tests__/integration/port-completeness.test.ts:21* — sweep confidence: confirmed

**Claim.** port-completeness requires each route FILE to appear in ROUTE_ACTIONS with ≥1 method (or in NON_ACTION_ROUTES); the matrix's SUCCESS_STATUS check is two-directional against ROUTE_ACTIONS. Nothing enumerates a route module's actual exports, so an org-scoped route gaining a second exported method (e.g. DELETE added to assessments/[id]) without a declaration would be silently absent from all 726 cells and from every action pin.

**Evidence.** __tests__/integration/port-completeness.test.ts:14-26 (isDeclared: `actions && Object.keys(actions).length > 0`); permission-matrix.test.ts:344-350 checks SUCCESS_STATUS keys against ROUTE_ACTIONS only. Verified currently aligned by enumerating exports: every org-scoped route's exported methods match declarations (grep of 'export async function' across app/api/**/route.ts).

**Impact.** A latent hole in the mechanical net, of exactly the shape the project's own doctrine warns about ('a hand-written list that must be complete is a latent defect with a timestamp on it') — the completeness that exists today is maintained by discipline, not generation.

**Direction (not an implementation).** Add a generated check: parse each ROUTE_ACTIONS/org-scoped route file for exported GET/POST/PATCH/DELETE and require set-equality with its declared methods.

### T-06 [Medium] jsdom/@testing-library approved by ruling but not installed; component behaviour layer remains untestable
*package.json:46* — sweep confidence: confirmed

**Claim.** package.json contains no jsdom, @testing-library, or react-test-renderer. Consequently untestable and untested: useFindingsData (T-01), MembersManager gating (T-04), AssessmentPageClient's effects (D-184 is pinned only by an ESLint-rule proxy test; the mutateThenConfirm extraction covers one slice), StageSelector, and all conditional rendering. The element-tree-walking workaround (report-provenance.test.tsx) works only for hook-free components and only extracts text.

**Evidence.** `grep -n "jsdom\|testing-library\|react-test-renderer" package.json` → no matches; __tests__/lint/assessment-page-client.test.ts:12-20 ('This repo has no jsdom/@testing-library/react (D-169), so this hook-bearing component cannot be rendered… The only thing that can pin…is running the REAL rule'); __tests__/unit/mutate-then-confirm.test.ts:8-11 (extraction rationale citing D-169).

**Impact.** A whole layer of role-gated and stateful UI behaviour is provable only through the slower, flakier e2e path or not at all; three separate test files carry workarounds whose own comments name the missing dependency. The approved ruling has not been executed.

**Direction (not an implementation).** Install jsdom + @testing-library/react per the ruling; first consumers should be useFindingsData, MembersManager, and AssessmentPageClient's evidence effect (replacing the ESLint-proxy test's role as sole guard).

### T-07 [Medium] Engine tests remain SPA-era: no Postgres jsonb round-trip test, no concurrency coverage; assessment PATCH is untested last-write-wins
*lib/data/assessments.ts:1* — sweep confidence: confirmed

**Claim.** The engine .js suites test pure in-memory transitions (with dead localStorage.clear() residue). No test anywhere writes a full-mode engineState through Prisma jsonb, reads it back, and asserts generateReportData output equivalence. No test exercises concurrent assessment writes: respondToAssessment replaces the whole engineState JSON with no version/precondition, so two members autosaving concurrently silently clobber each other — the fixture deliberately carries 2 members per role, yet no test uses them concurrently (invitations.test.ts does test concurrent acceptance; assessments do not).

**Evidence.** __tests__/engine/AssessmentEngine.test.js:28-31 (localStorage.clear() under node env); lib/data/assessments.ts respondToAssessment: `tx.assessment.update({ where: { id }, data: { engineState } })` with no version check; `grep -rn Promise.all __tests__/integration/assessments.test.ts` → no matches; integration round-trips use only quick-mode `{q1:3}` shapes (assessments.test.ts:112-147); full-mode round-trip exists only as unasserted e2e setup (role-matrix.spec.ts:175-185).

**Impact.** The two properties the server context ADDED to the SPA engine — durability through jsonb and multi-user concurrency — are exactly the ones with no coverage; the lost-update behaviour itself is a plausible unconsidered design gap for a multi-user platform (reported here as the missing test; the design question belongs to another dimension).

**Direction (not an implementation).** Add a jsonb round-trip equivalence test (write full state, re-read, assert generateReportData identical) and a two-session interleaved-PATCH test that pins whatever concurrency semantics are intended (and forces the lost-update decision to be made consciously).

### T-08 [Medium] PATCH engineState validation: 400 branch untested, and shallow validation admits garbage that would 500 at completion
*app/api/v1/orgs/[slug]/assessments/[id]/route.ts:13* — sweep confidence: probable

**Claim.** No test asserts the PATCH 400 'A valid engineState is required' branch. The validation is key-presence only (`!engineState.stages && !engineState.quick`), so `{stages: 42}` is accepted and stored; a later non-drifted full-mode completion would then throw inside canGenerateReport — the assessments suite's own comment concedes this path 'would throw reading .status off undefined' — surfacing as an unhandled 500. No test covers stored-garbage → completion.

**Evidence.** app/api/v1/orgs/[slug]/assessments/[id]/route.ts PATCH: `if (!engineState || typeof engineState !== 'object' || (!engineState.stages && !engineState.quick))`; `grep -rn 'valid engineState' __tests__ e2e` → no matches; __tests__/integration/assessments.test.ts:440-445 ('canGenerateReport(state) would need state.stages…and this would throw reading `.status` off `undefined` if the drift check did NOT short-circuit first').

**Impact.** A malformed or malicious autosave can poison an assessment into an uncompletable 500 state; the guard that exists is untested and does not entail the property it stands for (stored engineState is consumable by the engine).

**Direction (not an implementation).** Test the 400 branch; add structural validation (or a zod schema) for engineState and a test that stored garbage cannot make completion 500.

### T-09 [Medium] effective-config probe writes a deliberate lint violation into app/ source tree; residue observed in reality
*__tests__/lint/effective-config.test.ts:127* — sweep confidence: confirmed

**Claim.** The end-to-end ESLint check writes app/__effective_config_probe.ts (a file that intentionally violates the auth-import ban) into the real Next.js app directory and removes it in a finally block. A killed process leaves residue that fails `npm run lint` repo-wide and sits untracked where review packages (built from git diff) cannot see it. The session-start git status showed exactly this residue, so the failure mode has occurred; the fixed path also races concurrent vitest invocations.

**Evidence.** __tests__/lint/effective-config.test.ts:127-139 (`const probePath = 'app/__effective_config_probe.ts'; writeFileSync… finally { unlinkSync(probePath); }`); conversation-start git status snapshot: `?? app/__effective_config_probe.ts` (file since removed — `ls` now returns ENOENT).

**Impact.** Intermittent repo pollution that breaks lint and, per the project's own C4 doctrine, is invisible to diff-scoped reviewers; two parallel test runs can also delete each other's probe mid-lint, failing spuriously.

**Direction (not an implementation).** Write the probe to a temp dir with an eslint --stdin or a per-run unique gitignored path, or at minimum gitignore the probe filename.

### T-12 [Medium] Self-service and platform-admin routes: denial branches and destructive paths untested at any level
*app/api/admin/users/[id]/role/route.ts:37* — sweep confidence: confirmed

**Claim.** No test imports or drives: app/api/users/me/route.ts DELETE (account self-deletion — zero coverage anywhere), app/api/users/me/sessions/route.ts DELETE (logout-everywhere; only trigger-enumeration's grep proves the call exists), app/api/v1/orgs/route.ts POST (second-org creation at HTTP layer; only the lib function is tested). For app/api/admin/users/[id]/role, only the admin-succeeds path is tested; the platformRole denial (line 37), the cross-origin 403 (line 46), and the self-deactivation guard (line 63) have no tests. NON_ACTION_ROUTES 'accounts for' these files in port-completeness, which discharges enumeration but not enforcement.

**Evidence.** `grep -rn "import.*app/api" __tests__/integration/*.ts` output lists neither users/me/route, users/me/sessions, nor v1/orgs/route; `grep -rn users/me e2e/*.spec.ts` → nothing; app/api/admin/users/[id]/role/route.ts:37 `if (identity.platformRole !== 'admin')` — only caller in tests is an admin (password-gate.test.ts:142-148).

**Impact.** If the platformRole gate or the self-deletion semantics regressed (e.g., admin route open to any authenticated user), every suite stays green — the same 'declared surface, unproven trigger' shape trigger-enumeration exists to catch, on the one route family it does not cover.

**Direction (not an implementation).** Add route-level tests for the three admin-route denial branches, users/me DELETE (including what happens to org data the user owns), sessions DELETE behaviour, and POST /api/v1/orgs.

### T-10 [Low] 'wrong credentials show generic error' asserts no error at all
*e2e/security.spec.ts:67* — sweep confidence: confirmed

**Claim.** The test's name claims a generic (anti-enumeration) error is shown; its body asserts only that the URL stays on /login, then waitForTimeout(1000) with no subsequent assertion. A login page that shows nothing, or one that shows 'no such user' (the enumeration leak the name implies is prevented), both pass.

**Evidence.** e2e/security.spec.ts:67-77 — `await expect(page).toHaveURL(/\/login/); // Wait a moment for error to appear; await page.waitForTimeout(1000);` and nothing after.

**Impact.** The user-enumeration property the test advertises is unverified; the trailing timeout wastes a second per run while proving nothing.

**Direction (not an implementation).** Assert a visible error whose text is identical for wrong-password and unknown-email cases.

### T-11 [Low] Rate-limit-header test exercises a dead SPA-era endpoint
*e2e/security.spec.ts:82* — sweep confidence: confirmed

**Claim.** 'API responses include rate limit headers' GETs /api/projects, a route that no longer exists (org-scoped routes are /api/v1/orgs/[slug]/...). It passes because middleware decorates any /api path, so the test proves headers on a 404 to a nonexistent endpoint, not on any real API response. The sibling 'registration rejects empty fields' test similarly asserts only that the URL is unchanged.

**Evidence.** e2e/security.spec.ts:81-87 (`request.get('/api/projects')`); route inventory from `find app/api -name route.ts` contains no app/api/projects.

**Impact.** Weak evidence dressed as API coverage; a change scoping rate-limit headers to real routes only would make the suite's one header check misleading.

**Direction (not an implementation).** Point the check at a real v1 route (and optionally an authenticated one).

### T-13 [Low] CI flake gate covers only the chromium invocation, not the fixture setup project
*.github/workflows/ci.yml:361* — sweep confidence: confirmed

**Claim.** --fail-on-flaky-tests is passed only to the `--project=chromium --no-deps` run; the preceding `npx playwright test --project=setup` invocation runs with retries:2 (CI) and no flake gate, so a fixture build/login that passes only on retry is invisible.

**Evidence.** .github/workflows/ci.yml:361 (`run: npx playwright test --project=setup`) vs :385 (`run: npx playwright test --project=chromium --no-deps --fail-on-flaky-tests`); playwright.config.ts:6 (`retries: process.env.CI ? 2 : 0`).

**Impact.** Flake in the 20-login fixture path — the suite's single largest shared dependency — can silently persist; the register's own D-185 history shows what an unwatched flake becomes.

**Direction (not an implementation).** Add --fail-on-flaky-tests to the setup invocation too.

### T-14 [Low] Synthetic per-seat x-forwarded-for makes the e2e suite structurally blind to the real shared-IP rate-limit defect (D-124/D-199)
*e2e/fixtures/auth.setup.ts:84* — sweep confidence: confirmed

**Claim.** auth.setup.ts assigns each of the 20 fixture logins its own synthetic IP to avoid the credentials limiter, and security.spec.ts's registration test likewise uses a dedicated IP. Both are necessary and well-reasoned, but the consequence is that no automated test can ever reproduce the recorded real defect: 16+ genuine users behind one classroom NAT hit 429 today. The defect and the spoofability of x-forwarded-for (D-199 trusted-proxy allowlist) are honestly registered but remain outside the suite's reach by construction.

**Evidence.** e2e/fixtures/auth.setup.ts:40-59 (module doc: '16+ genuine users behind one *actual* shared IP … would hit this same 429 today', D-124) and :84-85 (`const syntheticIp = \`10.42.0.${i + 1}\``); e2e/security.spec.ts:182-191 (gap named, not closed; D-199/D-200).

**Impact.** The one live-verification instrument the project has for rate-limiting is configured so the known production-relevant failure mode cannot fire; closure of D-124/D-199 will need a dedicated test that today does not exist.

**Direction (not an implementation).** When D-199's trusted-proxy work lands, add a test that drives >15 logins from ONE address and pins the intended behaviour (whatever the fix chooses), converting the register row's pick-up trigger into a mechanical check.

**Not examined by this auditor:**
- Executing any suite (vitest or Playwright) to observe pass/fail live — Parallel auditors share the working tree and test database; a run would mutate makrai_test/dev DB state and could race another auditor (the probe-file residue appearing/disappearing during this session shows the tree is contended). All findings rest on static reading plus greps.
- Full reads of __tests__/integration/schema.test.ts, tenant-schema.test.ts, evidence-schema.test.ts, seed.test.ts, fixture.test.ts, members.test.ts, invite-email-failure.test.ts, framework-registry.test.ts, framework-current-version.test.ts, evidence-level-derived.test.ts, remediation-patch.test.ts, projects-patch-validation.test.ts, report-provenance.test.ts — Capacity; sampled deeply per the brief's named entry points instead. Structural skims (describe/it lists) showed no red flags in these.
- Most unit tests (rate-limit, proxy-rate-limit-logging, safe-callback-url, org-dispatch, org-nav, email-send, email-templates, connection, auth-secret, evidence-attach.test.tsx, evidence-data) — Capacity; prioritized the integration/e2e nets where D-191-class defects concentrate.
- Full reads of e2e/auth.spec.ts, org-routing.spec.ts, project.spec.ts, evidence-lifecycle.spec.ts bodies — Capacity; test-name enumeration showed scope, and the higher-risk specs (security, role-matrix, two-orgs, assessment-flow) were read in full or in the load-bearing sections.
- Whether the AdversarialClassification replica currently AGREES with useFindingsData.ts line-by-line — The structural finding (assertions target a replica, production hook untested) stands regardless of current agreement; a semantic diff of ~200 lines of logic was out of capacity and would not change the finding's severity.

## Coverage critic — what the whole audit missed

Coverage of the 17 named dimensions is unusually strong — a full git ls-files walk finds few tracked files untouched, and the NOT EXAMINED admissions are honest and specific. The blind spots are structural, not lazy. The single largest: nothing was ever executed — every Critical and High, including the three deploy-DOA findings and all the race/silent-loss claims, rests on static reading, in a project whose own doctrine defines done as live verification; a live pass could reprice the report's headline in either direction. Close behind, and more ironic: the dimension slicing reproduced the project's own recorded D-063 failure mode — the seams between dimensions (the deletion-scrub implementation, invitation-token redemption, proxy.ts, the dashboard/compare analytics pages, the framework content and shipped templates that are the actual product payload) were each deferred by every adjacent auditor to an owner that never existed, and a five-minute probe into one such seam (invitation links built from request-derived origin) already surfaced a plausible attack path.

- **Nothing was executed live, anywhere, by any of the 17 dimensions. Every auditor's NOT EXAMINED list independently admits it: no Docker image build/boot (3 Critical deploy-DOA findings rest on static reading of compose/runbooks), no browser drive of any flow, no Playwright run (forbidden by the gates brief), no restore drill, no live reproduction of any of the claimed races (D-185/AC-06/TEN-02) or of the silent-loss behaviors (FV-1, AC-04), no live HTTP status-code confirmation (api-surface).**
  Why it matters: The audit's highest-severity claims are exactly the ones that are static-only. The project's own doctrine (AGENTS.md C5) defines done as live end-to-end verification; the audit judged the product by a standard it did not apply to itself. A DEP-01..03 that turns out to half-work, or an FV-1 that a browser shows differently, changes the report's headline. Conversely, live runs routinely surface defects static reading cannot (this repo's own history: D-149 was found only by building).
  Suggested action: Commission one follow-up live-verification pass against a disposable stack: docker build + prod compose boot, one full register→org→assess→evidence→complete→report→PDF browser drive, one forced drift 409, the e2e suite, and a backup/restore drill. Mark each existing Critical/High as live-confirmed or live-refuted.

- **The product's actual payload was audited by no dimension: the framework content (78 questions, 21 areas, 28 controls in data/*.json) was explicitly punted by engine-scoring to register row D-032, and the 12 shipped artifact templates in /home/alvin/Downloads/MAK_RAI/toolkit-platform/public/templates/ (informed-consent, model card, datasheet, governance RACI, codebook — the closest thing to the vision's 'artifact generation' shift) appear in zero findings and zero NOT EXAMINED admissions. Additionally verified: they are referenced from the hashed data/assessmentAreas.json but are themselves outside BUNDLE_FILES (lib/framework/bundleHash.ts:18-23), so a template edit silently changes what a pinned, completed report links to — the R-13/FV-5 class, on files nobody opened.**
  Why it matters: For an RAI-governance product the content IS the product; every dimension audited the machinery around it. Wrong or stale guidance handed to institutions is a correctness defect no amount of RLS rigor offsets, and the template-outside-the-hash hole quietly undermines the framework-pinning guarantee the audit praised.
  Suggested action: Name D-032 (content currency vs ISO 42001 / AU Strategy / UNESCO) as an audit-level open gap in the final report; review the 12 templates for content and currency; either add template bytes to the bundle hash or record the exclusion as a deliberate decision with a register row.

- **The cross-assessment analytics surface has no owner and zero coverage: app/(authenticated)/orgs/[slug]/dashboard/page.tsx, app/(authenticated)/orgs/[slug]/projects/[id]/compare/page.tsx, components/dashboard/GapHeatmap.tsx, and components/dashboard/TrendChart.tsx (~600 lines total) are mentioned nowhere in INDEX.md — not as findings, not as NOT EXAMINED. Engine-scoring stopped at the engine, assessment-client at the assessment flow, reports at the report page + PDF; the pages that aggregate and display scores across assessments fell in the seam. Notably, PT-05 declared the 'benchmarking' vision shift absent without registering that a compare page exists.**
  Why it matters: These pages compute and present the numbers institutions will act on; the audit already proved the engine feeding them has confirmed scoring defects (ENG-01, ENG-03), so how the dashboard/compare layer aggregates that output is precisely where those defects become user-visible decisions. An entire user-facing feature (compare) escaped even the product-vision inventory.
  Suggested action: Assign a short 18th-dimension review: score aggregation correctness on dashboard and compare, behavior on partial/quick-mode data, and whether compare partially delivers the benchmarking shift PT-05 scored as absent.

- **Mutual-deferral orphans: units every adjacent auditor deferred to a dimension that does not exist. (a) scrubUserOnDeactivation (lib/data/identity.ts:363) — the implementation behind the privacy page's deletion promise; PT-01/API-07 judged the promise while api-surface and reports-pdf both punted the scrub to an 'identity-lifecycle dimension' nobody had, so no one knows what the scrub actually erases. (b) Invitation-token redemption lifecycle (expiry/single-use enforcement at redemption) — authn-session deferred to an 'invitations/tenancy dimension'; authz touched only creation-time caps. (c) proxy.ts as a whole — authz deferred to a nonexistent 'edge/middleware dimension'; only fragments (DEP-04, T-14) were read. (d) lib/security-logger.ts internals (event taxonomy, log-injection given R-02 proves user-controlled CR/LF reaches sinks). Concrete evidence the seam bites: app/api/v1/orgs/[slug]/members/route.ts:100 builds the emailed invitation link from req.nextUrl.origin — a request-host-derived URL in outbound email, the classic Host-header-poisoning-to-phishing seam — examined by nobody, and its safety depends on nginx/Next host pinning that was also unaudited (DEP-13 stops at header duplication).**
  Why it matters: This reproduces, at audit level, the exact substitution failure the project's own AGENTS.md documents (D-063): each reviewer read the silence as someone else's coverage. All four orphans are security-relevant, and one five-minute probe into the seam already surfaced a plausible attack path (platform-sent phishing links to arbitrary addresses via an attacker-controlled Host on their own invite request).
  Suggested action: Run a seam-sweep with an explicit named owner per orphan file; as a priority, verify whether nginx/Next pins the Host for members/route.ts:100's acceptUrl, and read scrubUserOnDeactivation against the privacy page's claims.

- **A lifecycle moment nobody walked: cutover from the still-deployed SPA. The locked primary adopter (team self-improvement) uses the live SPA today; the platform ships a byte-identical engine fork of it (DEP-6), the SPA persists assessments in localStorage (ENG-13's dead exports), and no dimension asked how existing users or in-progress assessments migrate, whether the two products coexist, or when the SPA is decommissioned.**
  Why it matters: Day one for the named primary adopter begins with 'where is my existing assessment?' — and two live products sharing an unsynced engine fork will silently diverge in scoring, so the same team could get two different scores for the same answers depending on which product they open.
  Suggested action: Add a cutover/coexistence decision to the plan of record (import path, or an explicit register row that legacy SPA data is abandoned), and a decommission trigger for the SPA tied to the platform's first production deploy.

- **The injection/output-encoding class is unowned as a class. R-02 caught one instance (unsanitized CR/LF-capable names in the PDF header), but no dimension audited user-authored strings (org/project/user names, evidence filenames) across all sinks — HTML report page, dashboards, email templates, security-logger lines — and no one evaluated the app's actual CSP: docker/nginx/default.conf:37 ships 'unsafe-inline' + 'unsafe-eval', which neutralizes most of CSP's XSS value (DEP-13 flagged header duplication, not header content). Zero occurrences of 'XSS' or 'CSP' anywhere in the 17 summaries.**
  Why it matters: Slicing the audit by subsystem means class-shaped defects are only found where a subsystem auditor happens to trip over one; R-02's existence is direct evidence the class is live in this codebase, and the sinks nobody enumerated are the ones most likely to hold its siblings.
  Suggested action: One focused pass: enumerate every sink of user-authored strings (grep-generatable), check encoding/sanitization per sink, and either justify or tighten the CSP.

- **The two deep-read methods with proven yield inside this very audit were both left incomplete: (a) nobody read DEFERRED_REGISTER.md end to end — all auditors sampled (docs-accuracy ~12 rows, process-register 10 closures, product-vision ~15 rows) even though PH-2 proves sampling misses are systematic (rows missed by four successive sweeps); (b) nobody diffed the five specs/plans in docs/superpowers/ against shipped code — docs-accuracy and process-register both punted on volume, yet EV-4 (a spec requirement silently dropped between spec and plan) was found precisely by reading one spec section.**
  Why it matters: Both methods have demonstrated hit-rates in this audit; the unread remainder (roughly 150 register rows and ~5 large spec documents) is statistically likely to contain more PH-2s and EV-4s — silently dropped obligations are the exact failure class this product exists to diagnose.
  Suggested action: One full mechanical register pass (script-assisted: status/kind/trigger consistency, cross-row contradiction detection) and one spec-vs-shipped diff per phase, before the next phase exit.

- **Consolidated NOT EXAMINED admissions that gate existing findings' confidence and belong verbatim in the final report: (1) Docker image never built or booted — the 3 Criticals are static; (2) restore never drilled; (3) scripts/pen-test.mjs (531 lines, npm run test:security) neither read nor run by any auditor, and no CI job runs it; (4) NextAuth's built-in /api/auth/* surface — the entire live login POST path — unexamined; (5) per-advisory exploitability of the @auth/core and Next 16.2.9 CVE chains unassessed, so DEP-1/DEP-2 severity is nominal; (6) external world state (VPS, rai.air.ug DNS, Resend domain verification) unverified; (7) Playwright e2e spec bodies never fully read and never run; (8) RLS query plans / Postgres tuning at production scale unassessed; (9) the AGENTS.md-claimed UserPromptSubmit hook left unresolved between two auditors (DOC-12 says 'no such hook ships' at prob-confidence; process-register admits it ran out of budget) — a direct contradiction in the audit record; (10) the AGENTS.md 'NOT the Next.js you know' vendored-docs divergence claim never tested; (11) no systematic accessibility pass — a11y findings (AC-09, PT-10) are incidental, though public-institution adopters typically carry legal a11y obligations.**
  Why it matters: These are the audit's own confidence boundary. Presenting the report without them converts honest scoped exclusions into implied coverage — the 'laundered deferral' failure the project's §6 names. Item (9) is also an internal inconsistency the merged report must resolve rather than ship both halves of.
  Suggested action: Include this list as a 'known audit boundary' section in the final report; resolve the hook contradiction with a one-command check of .claude/settings*; read pen-test.mjs and decide whether it becomes a CI job.
