# Plan 1c — Evidence attachment and framework pinning

**Status:** design, awaiting human-partner review
**Date:** 2026-08-06
**Branch:** `phase1c-evidence-and-pinning`
**Closes:** D-001 (evidence attachment), D-003 **in part** (see §7)
**Bound by:** D-137 — design `FrameworkVersion` knowing Plan 2a exists

---

## §0 — What this is, and what is explicitly not its job

Plan 1c closes Phase 1 by making two claims verifiable that the product currently
asserts without support:

1. **"We have evidence for this."** Today `RemediationItem.evidenceLevel` can be set to
   `artifact_uploaded` by any client that sends the field, with no artifact, and nothing
   ever reads it. `artifactPath` has **no writer and no reader at all**. In a product whose
   thesis is that self-attestation is the ethics-washing it exists to diagnose, that is a
   defect, not merely a gap.
2. **"This was assessed against framework version X."** No assessment in this database
   records which content it was answered against. `engineState.version` looks like it does
   and does not: it is `const VERSION = '4.0.0'` in `lib/engine/AssessmentEngine.js:23`, the
   *engine's* version, while the content files carry `3.0.0`.

**Explicitly not its job:**

- Framework content as database rows. Deferred to **Plan 2a**, where the domain axis is
  designed, so that both content decisions are made once and together (D-137).
- Any domain-specific framework content, tiering, or gating (Plan 2a).
- Object storage, CDN, or any hosting decision — D-018 stays parked (§2.3).
- Malware scanning (§5.4), evidence versioning, or e-signature.
- Review / sign-off workflow (D-002), which depends on this landing first.

---

## §1 — Decisions taken, and by whom

| # | Decision | Taken by | Rationale |
|---|---|---|---|
| 1 | Evidence bytes live in Postgres `bytea`, behind a narrow storage boundary | human partner | No hosting dependency; RLS covers evidence for free; the boundary lets Plan 2b swap in object storage without touching the domain model |
| 2 | Evidence attaches to **a response** or **a remediation item** | human partner | Those are the two places the product currently accepts an unsubstantiated assertion |
| 3 | Framework content stays in files; the database holds a **registry** | human partner | Both content decisions get made in Plan 2a with the domain requirement in view, rather than 1c guessing and 2a unwinding |
| 4 | Evidence on a **completed** assessment is immutable | human partner | Same reasoning as the write-once pin: once a record is evidence about the past, the response to inconsistency is to freeze and disclose |
| 5 | On user erasure, evidence **bytes are kept, attribution scrubbed** | human partner | The artifact is the org's governance record, on the same basis its assessments are kept |
| 6 | `evidenceLevel` becomes **derived**, never accepted from a request | controller, after adversarial review | Two mechanisms for one fact can disagree; the enum is the defect this plan exists to close |

---

## §2 — Data model

### §2.1 `framework_versions` — the third data-access lane

```
id           text PRIMARY KEY
semver       text NOT NULL UNIQUE
contentHash  text NOT NULL              -- sha256 of the canonicalised content bundle
publishedAt  timestamptz NOT NULL
status       text NOT NULL CHECK (status IN ('published','deprecated'))
createdAt    timestamptz NOT NULL DEFAULT now()
```

This is the first table that is **neither tenant data nor identity data**. ADR-0001 has
exactly two lanes: tenant tables behind `withOrg` + RLS, and identity on the
SUPERUSER/BYPASSRLS connection. Framework content is global, read-mostly, non-tenant, and
must be readable by the restricted `makrai_app` role. Left undecided, the likely accident is
that it lands on the identity connection, because that is where "not tenant data" currently
routes — which would put framework reads on the connection whose entire purpose is that
almost nothing touches it.

**Decision: a third lane.** `framework_versions` is read by the app role directly, with
`SELECT` and nothing else. This gets **ADR-0003**, because it changes a two-lane
architecture into a three-lane one and a future reader would otherwise re-litigate it.

**Verified by spike, not assumed** (2026-08-06, `docker exec … psql`):

| Spike | Result |
|---|---|
| `makrai_app` SELECTs `framework_versions` with no grant | `ERROR: permission denied` |
| `makrai_app` INSERTs a tenant row whose FK points at it | **`INSERT 0 1` — succeeds** |
| …with a bad FK value | rejected, `violates foreign key constraint` |
| …writing a row for another org | rejected, `violates row-level security policy` |

Referential-integrity checks run with the *referenced table's* rights, not the inserting
role's. **The app role therefore needs no privilege at all on `framework_versions` for
pinning to work, while integrity remains fully enforced.**

> **Correction, 2026-08-08.** This paragraph originally continued: *"The `SELECT` grant
> exists for exactly one reason — the report displays 'assessed against framework 3.0.0' —
> and if that display requirement is ever removed, the grant goes with it."* **That is no
> longer true, and the change that made it untrue was mine.**
>
> D-143 found that no task in the plan made the assessment-creation route *write* the pin —
> the plan's file list was generated from readers of the framework version and never asked
> which file writes it. Closing it required `getCurrentVersionId`, which reads
> `framework_versions` on **every** `POST .../assessments`. So this table is no longer
> passive display metadata: it is the request-blocking source of truth for whether an
> assessment can be created at all, and the `SELECT` grant is now load-bearing for
> creation, not only for display. Removing the provenance line would **not** release it.
>
> The consequence worth carrying into Plan 2a: the schema has no concept of *"the version
> new assessments should get."* `status` distinguishes `published` from `deprecated` — a
> validity state, not a currency marker — so "current" exists only as an exact string match
> between a JSON file's `meta.version` and a row's `semver`, reconciled at runtime with no
> constraint tying them together. **Promoting "current" into the data model is deliberately
> not done here:** that is a framework data-model change, and D-138 gives the framework data
> model to Plan 2a. Doing it in 1c would foreclose precisely what D-137 binds 1c not to
> foreclose. D-147 records the gap; a test added in Task 1 fix round 2 asserts the two
> strings agree, converting a future silent drift into a visible failure.

### §2.2 `Assessment.frameworkVersionId`

`NOT NULL`, FK to `framework_versions`, **written once**. An `UPDATE` that changes it is
rejected by a database trigger, not by application code (O-3).

### §2.3 `evidence` and `evidence_blobs`

```
evidence
  id                 text PRIMARY KEY
  orgId              text NOT NULL
  assessmentId       text NOT NULL
  frameworkVersionId text NOT NULL     -- denormalised; see note below
  questionId         text NULL
  remediationItemId  text NULL
  filename           text NOT NULL
  mimeType           text NOT NULL     -- SERVER-derived; never the client's claim
  byteSize           integer NOT NULL
  sha256             text NOT NULL
  uploadedById       text NULL         -- nullable: survives user scrub (§5.2)
  uploadedAt         timestamptz NOT NULL DEFAULT now()
  FOREIGN KEY (orgId, assessmentId) REFERENCES assessments(orgId, id) ON DELETE CASCADE
  CHECK (num_nonnulls(questionId, remediationItemId) = 1)
  UNIQUE (assessmentId, sha256, questionId, remediationItemId) NULLS NOT DISTINCT

evidence_blobs
  evidenceId  text PRIMARY KEY REFERENCES evidence(id) ON DELETE CASCADE
  orgId       text NOT NULL
  content     bytea NOT NULL
```

**Why the tables are split.** Prisma's default select fetches every scalar column, so a
`content bytea` beside the metadata means every listing query drags every blob out of TOAST
— the evidence list on a report page would pull tens of megabytes to render filenames. The
split makes that structurally impossible rather than a discipline to remember. It is also
the storage boundary decision 1 asked for: `evidence_blobs` is the local backing store, and
moving to object storage later drops that table and puts an object key on `evidence`, with
**no consumer of the evidence domain model changing**. The port is a table boundary rather
than an interface, which is cheaper and harder to bypass.

*Assumption for the implementer to verify, not to inherit:* that Prisma 7.8's default
`findMany` selects `Bytes` columns. Check with a query log (`DEBUG=prisma:query`) against a
single-table variant before relying on the reasoning above. The split is correct either way;
only this justification depends on it.

**Why `evidence_blobs` carries `orgId`.** It looks redundant — it is 1:1 with a row that
already has one. It is not redundant for *enforcement*: the DDL guard keys on the presence
of an `orgId` column (`prisma/migrations/20260803074244_…/migration.sql:135`), so a blob
table without it is silently exempted from RLS entirely, and the one table holding the actual
bytes becomes the one table with no tenant filter. When the enforcement mechanism triggers on
a marker, omitting the marker is an opt-out, not a simplification.

**Why `frameworkVersionId` is denormalised onto `evidence`.** It is derivable through the
assessment today. Storing it makes the row self-describing and makes Plan 2a's
question-ID→question-row migration a local update rather than a join. Consistency is
guaranteed because the assessment's pin is write-once.

### §2.4 The mutable-natural-key hazard

`questionId` is a **string**, not a foreign key, because in the registry model there is no
question table to point at. `Q-PP-01` is the join key for responses, `gaps` arrays,
`conditionalQuestions` triggers — and now evidence — and nothing declares it unique across
versions. If a later version reuses `Q-PP-01` for a different question, every piece of
evidence attached to it silently re-points to a claim it does not support. Not a crash: a
governance tool asserting that a document proves something it does not.

**Mitigation.** The pair `(frameworkVersionId, questionId)` identifies a claim, and
`contentHash` makes the pair verifiable (§4). This plays the same role the composite
`(orgId, id)` foreign keys play for tenancy — making an invalid reference unrepresentable
rather than merely unlikely. When Plan 2a turns questions into rows, the pair becomes a real
foreign key and the guarantee strengthens without the model changing shape.

---

## §3 — Components

Each unit's single responsibility, and what is explicitly not its job:

| Unit | Responsibility | Not its job |
|---|---|---|
| `lib/evidence/inspect.ts` | Decide what these bytes are, from magic bytes, and whether that is allowed | Storage, auth, tenancy — a pure function over a buffer, testable with no database |
| `lib/data/evidence.ts` | Tenant-scoped CRUD, exclusively through `withOrg(ctx, …)` | Deciding *who* may call it |
| `lib/data/framework.ts` | Resolve and verify the pinned version; expose `contentHash` | Serving content — content still comes from the JSON files in 1c |
| upload route | Trust boundary: authorize, inspect, hash, persist | Rendering |
| download route | Stream one blob with hostile-safe headers | Deciding attachment semantics |
| attach UI | Let a user pick a file and see what is attached | Any authorization decision — it *reflects* `can()`, never enforces it |

**`lib/data/framework.ts`, not `lib/framework/registry.ts`.** `eslint.config.mjs:184`
exempts `lib/data/**` from the `lib/db` import ban; a module elsewhere would be banned from
reading its own table. Found by varying the search *root* rather than the predicate.

### §3.1 Upload flow, with the trust boundary marked

```
browser ──multipart──▶ ┃ POST /api/v1/orgs/[slug]/assessments/[id]/evidence
                       ┃ 1. requireOrgContext(slug, 'evidence:create')
                       ┃ 2. size gate BEFORE buffering
                       ┃ 3. inspect(buffer) → real MIME | reject   ← client's claim discarded
                       ┃ 4. sha256(buffer)
                       ┃ 5. withOrg(ctx):
                       ┃      a. assessment is in-progress (§5.1)
                       ┃      b. attach target is IN this assessment (O-6)
                       ┃      c. questionId exists in the pinned version (O-22)
                       ┃      d. insert metadata + blob in ONE transaction
  trust boundary ──────┸──▶ evidence (RLS) + evidence_blobs (RLS)
```

Steps 3 and 5b fail differently and need separate tests: 3 admits a malicious file, 5b admits
a legitimate file onto the wrong claim.

### §3.2 Type inspection, and its honest limit

Accepted: PDF, PNG, JPEG, plain text, CSV, and the OOXML family (`.docx`, `.xlsx`, `.pptx`).

**The limit, stated rather than discovered by an implementer:** OOXML files are ZIP
containers whose magic bytes are `PK\x03\x04` — identical to any ZIP, JAR, or APK. Magic-byte
inspection therefore establishes "this is a zip", not "this is a Word document". Plan 1c
accepts that: the residual risk is a zip mislabelled as a document, and it is bounded by the
download path never serving anything inline and never executing anything (O-8). Deeper
validation (reading `[Content_Types].xml` from the central directory) is **deferred with a
register row**, not silently skipped.

### §3.3 Reach — what changes beyond the obvious file list

| Touched, though it appears in no feature description | Why |
|---|---|
| `e2e/role-matrix.spec.ts` control registry | New buttons on walked screens; the census **fails** if unregistered — the D-129 mechanism working, a deliberate cost |
| `__tests__/integration/trigger-enumeration.test.ts` | Three new guards and a new gating column, or a guard ships with no caller again |
| `app/api/v1/orgs/[slug]/assessments/[id]/remediation/route.ts` | Stops accepting `evidenceLevel` (§1 decision 6) |
| `/api/users/me/export` | Evidence is authored data; omit it and export/delete go asymmetric |
| `components/report/useEvidenceData.ts` | Renamed `useFindingsData.ts` — see §4.3 |
| `lib/rate-limit.ts` | Default is 60/min per user (`lib/rate-limit.ts:24`); correct to have a limit, wrong value for a byte-accepting endpoint |
| `scripts/pen-test.mjs` | The first byte-accepting endpoint in the product ships with zero cases in the file that exists to attack it |
| `prisma/migrations/**` | The registry row is **reference data in a migration**, not seed data — see §6 O-21 |

---

## §4 — Pinning, and why the pin must be checked

Writing `frameworkVersionId` proves nothing on its own. In 1c content still lives in JSON
files while the pin lives in a database row, so the running app would go on serving whatever
the files currently say to an assessment claiming it was answered against `3.0.0`. That is
`engineState.version` again: a field that looks like provenance and is decoration.

Two mechanisms, at two moments:

| Moment | Mechanism | Catches |
|---|---|---|
| Build / CI | A test recomputes the SHA-256 of the canonicalised content bundle from disk and asserts it equals the registry row | Content edited without a version bump — caught before merge |
| Runtime, per assessment load | `resolveFramework()` compares the module-load bundle hash against the pinned row's `contentHash` | A deployed tree that does not match its registry |

### §4.1 Behaviour on mismatch, split by status

- **Completed** → render the cached `reportData` (`prisma/schema.prisma:146`) with a
  provenance banner. The historical report stays what it was; nothing is recomputed against
  content the respondent never saw.
- **In-progress** → **stop accepting answers.** Continuing means one response set spanning
  two versions of the same question — silent corruption no later check could untangle.

The asymmetry is the point. For a completed assessment the cached report is already the
historical truth, so a mismatch is an annotation problem. For an in-progress one there is no
cached truth yet, and every further answer makes the corruption harder to detect.

### §4.2 The provenance line

> *Assessed against MAK-AI RAI Framework **3.0.0**, pinned 2026-08-06 · content `a1b2c3d4…`*

An ISO 42001 auditor's first question about any assessment is which version of the control set
it was answered against. Today the report cannot answer it. This single line is arguably more
of D-003's value than the whole content model.

### §4.3 Evidence on the report, and the name collision

| Surface | Shows | Why not more |
|---|---|---|
| Question / remediation item | Attach control and what is attached | The working surface |
| HTML report | Per-finding evidence list, downloadable | The reviewing surface |
| PDF | An evidence **manifest** — filename, SHA-256, uploader, date — and **not** the bytes | An auditor needs to know what exists and can request it; a hash is stronger provenance than an embedded copy, and the PDF stays bounded |

`components/report/useEvidenceData.ts` computes *findings* — which questions scored low and
why. That is not evidence in the sense this phase introduces, and shipping both words into one
report is a defect in a document read by auditors who have a fixed definition of the term. It
becomes `useFindingsData.ts`; "evidence" means artifacts, everywhere, from this phase on.

---

## §5 — Lifecycle

This section exists because the first four design sections did not have one, and an
adversarial pass on the decomposition ruled that a governance product cannot ship an evidence
store whose retention story is unspecified.

### §5.1 Deletion

Evidence may be deleted **while its assessment is in progress**. Once the assessment is
completed, its evidence set is frozen: no insert, no delete. Same reasoning as the write-once
pin — an auditor can trust that a completed assessment's evidence set is what was actually
reviewed. Removing evidence afterwards requires deleting the assessment, which is visible.

### §5.2 User erasure

Under the standing "deactivate + scrub, keep org records" ruling: evidence rows and their
bytes **survive**; `uploadedById` is scrubbed exactly as other authored records are (hence
`uploadedById` is nullable). The artifact is the organisation's governance record, on the
same basis its assessments are kept.

The residual case — an uploaded document that itself contains personal data — is **not**
solved by this and is deferred with a register row and a pick-up trigger (first pilot holding
real institutional data).

### §5.3 Duplicate uploads

`UNIQUE (assessmentId, sha256, questionId, remediationItemId) NULLS NOT DISTINCT`. A retry
after a dropped response is idempotent: the same bytes on the same claim return the existing
row rather than creating a second one. `NULLS NOT DISTINCT` is required — without it, two rows
with a NULL `remediationItemId` are considered distinct and the constraint does not fire.

### §5.4 Malware

**No scanning in Plan 1c.** Stated rather than left silent. The basis: no hosting and no real
accounts exist yet (D-018), uploads are confined to authenticated members of an organisation
they belong to, and the download path never serves anything inline or executable (O-8). This
is an accepted risk with a register row and a pick-up trigger (first deployment reachable by
users outside the developing team), not an oversight.

### §5.5 Backups

A `pg_dump` of this database now contains arbitrary user-uploaded documents. The sensitivity
class of a backup changed with this design. Register row.

---

## §6 — Proof obligations

Grouped by **what they prove**, not by which file they live in — because the failure this
project keeps hitting is obligations individually satisfied and collectively insufficient.

**Isolation — cross-tenant**

- **O-1** `evidence` and `evidence_blobs` each carry an `org_isolation` policy with both
  `USING` and `WITH CHECK`, matching the form of all 7 existing policies (verified via
  `pg_policies`). Each proven non-vacuous by reverting it and watching a cross-org test go red.
- **O-5** `makrai_app` holds `SELECT` only on `framework_versions`; `INSERT`, `UPDATE` and
  `DELETE` raise. Proven by executing all four as that role.

**Confinement — intra-tenant.** *A different claim from O-1; neither proves the other.*

- **O-6** Evidence attaches only to a target inside the assessment named in the URL. Proven by
  attaching org A's assessment-2 item to org A's assessment-1 and expecting 404.

> Stated explicitly because collapsing these two is a mistake this project has already made: a
> test showing an invitation adding a second user to an org was once written as proof of
> two-org isolation, which it cannot establish at all.

**Content trust**

- **O-7** MIME derived from magic bytes; a file declaring `image/png` whose bytes are HTML is
  **rejected**, not corrected. The OOXML limit of §3.2 is asserted as a test, not left implicit.
- **O-8** Download serves `application/octet-stream` + `Content-Disposition: attachment` with
  an RFC 6266 filename + `X-Content-Type-Options: nosniff`. Proven with filenames containing
  CRLF and `"`.
- **O-9** Every row records uploader, timestamp, byte length and SHA-256; the hash is verified
  on download.

**Structural invariants, enforced in the database**

- **O-2** Exactly-one attach target: both-null and both-set are rejected by a `CHECK`.
- **O-3** `frameworkVersionId` is `NOT NULL`, and an `UPDATE` changing it is rejected by
  Postgres, not by application code.
- **O-4** Explicit indexes on all four new FK columns — Postgres does not create them.
- **O-23** The duplicate-upload constraint fires with a NULL component present (proving
  `NULLS NOT DISTINCT` is doing its job, since the default would silently not fire).

**Provenance is checked, not merely stored**

- **O-13** A test recomputes the content-bundle hash from disk and asserts it equals the
  registry row.
- **O-14** On mismatch: completed renders the cached report plus banner; in-progress blocks
  answering.
- **O-15** The provenance line (§4.2) appears in both the HTML report and the PDF, carrying
  semver, pin date and content hash. Proves the report can answer *which version was this
  assessed against*.
- **O-16** The PDF carries an evidence **manifest** and no evidence bytes. Proves the PDF
  stays bounded regardless of how much evidence an assessment accumulates — a distinct claim
  from O-15, which is about provenance rather than size.
- **O-22** A questionId that does not exist in the pinned version is rejected at upload. O-2
  proves *exactly one* attach target; it does not prove the target *exists*.

**The seam — where two exhaustive lists must actually touch**

- **O-10** Three new actions (`evidence:create`, `evidence:read`, `evidence:delete`) with a
  **proved-non-vacuous** matrix. The proof method is fixed in advance because the obvious one
  has already failed here: swap each action for one with a *demonstrably different* grant set
  and confirm the predicted cells go red. Two actions with identical grants make the check
  vacuous while looking rigorous.
- **O-17** The action string each route passes to `requireOrgContext` is the same string the
  matrix tests, generated from one source rather than written twice.

> O-17 exists because an RBAC matrix and a route port were once each exhaustive, and nothing
> asked whether they touched — so `can()` could have been perfect while every route consulted
> the wrong action.

**Closing the defect this plan cites as its motivation**

- **O-20** `RemediationItem.evidenceLevel` is **derived** (`artifact_uploaded` iff evidence
  rows exist for that item) and the PATCH route no longer accepts it from a request body.
  Proven by sending `{evidenceLevel: 'artifact_uploaded'}` with no evidence and asserting the
  stored/derived value is `self_attestation`. `artifactPath` is dropped.

> This obligation exists because the first four design sections opened by naming
> `evidenceLevel` as the motivating defect and then built nineteen obligations without
> returning to it. **Naming a problem is not closing it.** The generalisable check: for every
> defect a design cites as motivation, point at the obligation that closes it.

**Deployment-time correctness**

- **O-21** The `3.0.0` registry row is inserted **by the migration**, in the same transaction
  as the backfill, in this order: create table → insert `3.0.0` → add nullable column →
  backfill → set `NOT NULL`. It is reference data, not seed data: `npm run seed` is a
  standalone script that the test harness never invokes, so a row created only there breaks
  every integration test that creates an assessment and leaves any deployed environment with a
  constraint it cannot satisfy. Migration applied to **both** `makrai` and `makrai_test`.

**Lifecycle**

- **O-24** Evidence cannot be inserted into or deleted from a completed assessment (§5.1), and
  a user scrub nulls `uploadedById` while leaving the row and its bytes intact (§5.2).

**Enumeration backstops**

- **O-11** `trigger-enumeration.test.ts` entries for the three new guards and the new gating
  column.
- **O-12** `/api/users/me/export` includes evidence — export and delete stay symmetric.
- **O-18** An explicit rate-limit rule for the upload path.
- **O-19** `pen-test.mjs` gains oversize, wrong-magic-bytes, and cross-assessment-attach cases.

**Pre-flight, before Task 1:** confirm `lib/data/framework.ts` placement against the resolved
ESLint config, with `__tests__/lint/effective-config.test.ts` pinning it.

---

## §7 — What this defers, and why

Every row below gets an entry in `docs/DEFERRED_REGISTER.md` **in the same commit that creates
it**, with a concrete pick-up trigger.

| Deferred | Why | Pick-up trigger |
|---|---|---|
| Framework content as rows | Made once, with the domain axis, in Plan 2a (D-137) | Plan 2a design |
| D-003 remainder | This plan closes the *pinning* half; the *content model* half moves to 2a | Plan 2a design |
| OOXML deep validation (§3.2) | Bounded by the attachment-only download path | A format-confusion finding, or a hosted deployment |
| Malware scanning (§5.4) | No hosting, no real accounts; uploads confined to org members | First deployment reachable outside the developing team |
| Evidence containing third-party personal data (§5.2) | Needs a real DPO and a real institution | First pilot holding real institutional data |
| Backup sensitivity class (§5.5) | Follows the hosting decision | D-018 |

---

## §8 — Process record

Skills invoked, in order, with what each found:

| Skill | Checkpoint | Found |
|---|---|---|
| `superpowers:brainstorming` | C1 | — (framing) |
| `what-if-oracle` (Deep, on the decomposition) | §2 fork trigger | Ψ the mutable-natural-key hazard (§2.4); ∞ the third data-access lane (§2.1) |
| `engineering-skills:senior-security` | C1, preventive | STRIDE on 4 new DFD elements → O-6, O-7, O-8, O-9, O-5, O-3 |
| `database-design:postgresql` | C1, schema change | `num_nonnulls`, `NULLS NOT DISTINCT`, manual FK indexes, and the four DB spikes in §2.1 |
| `engineering-skills:adversarial-reviewer` | §2, finished design artifact | **BLOCK** — 3 criticals: O-20, O-21 and the absent §5 entirely |

**Claims executed rather than asserted** (D-136 check 1, applied to planning):

| Claim | Command | Result |
|---|---|---|
| `engineState.version` is the framework version | `grep -n VERSION lib/engine/AssessmentEngine.js` | **False** — it is the engine's version |
| `can()` denies an action that does not exist | `npx tsx -e "can(role,'evidence:create')"` | `false` for all 5 roles including owner — fail-closed |
| RI checks need a grant on the referenced table | 4 psql spikes with savepoints | **False** — no grant needed; integrity still enforced |
| Upload path has no rate limit | `grep -n default lib/rate-limit.ts` | **False** — default 60/min applies |
| The test harness seeds | `grep -rn seed vitest.config.* __tests__/helpers/` | **False** — it does not, hence O-21 |

**Two-lens decomposition** (AGENTS.md §3). Lens 1: "what does each design decision claim?"
Lens 2 varied the *root* rather than the predicate — `eslint.config.mjs`, `lib/rate-limit.ts`,
`scripts/` — and found the module-placement build-breaker, the upload rate-limit value, and the
pen-test gap, none of which lens 1 could reach.
