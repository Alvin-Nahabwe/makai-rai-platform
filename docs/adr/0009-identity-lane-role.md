# ADR-0009 — The identity lane connects as `makrai_identity`, not as the schema owner

**Status:** Accepted · **Date:** 2026-10-08 · **Deciders:** owner + engineering
**Supersedes in part:** ADR-0001 decision 4 ("they run on the owner connection") and the
sentence above it that sends `User`/`ConsentRecord` through `lib/data/identity.ts` "on the
unscoped client"
**Related:** ADR-0001 (data-access architecture), ADR-0003 (the framework-version lane)
**Register:** ARCH-03, HEALTH-09, TEN-04, D-076

## Context

ADR-0001 put tenant data behind row-level security and connected `withOrg` as
`makrai_app`, a role RLS binds. The two modules that must work *before* an organisation is
known were left on the schema owner's connection, `DATABASE_URL`:

- `lib/data/identity.ts` — `identityDb` (users and consent records) and the raw `base`
  client behind `scrubUserOnDeactivation`;
- `lib/data/preauth.ts` — memberships at login, organisation by slug, invitation by token,
  registration, invitation acceptance and organisation creation.

The owner, `makrai`, is a superuser. Superusers ignore RLS and every grant, so the web
process held the one credential that can read every organisation's rows, alter the schema
and read the server's files. Everything protecting tenant data from those two modules was
application code: a construction-built allowlist, a recursive argument walk, a pinned export
surface. Each has been bypassed at least once on this project before it was hardened
(`lib/data/identity.ts`'s module history records five attempts). A defect in any of them,
or one injection, reached every tenant at superuser level.

That is ARCH-03 and HEALTH-09. TEN-04 is the same question asked of `makrai_app`: it still
held the blanket SELECT, INSERT, UPDATE and DELETE that `20260803062144` granted, although
no code path used much of it. D-076 is the provisioning script's guard against its
well-known dev password, which keyed on `NODE_ENV=production` and so was off whenever
`NODE_ENV` was unset.

## Decision

1. **A third login role, `makrai_identity`**, `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB
   NOCREATEROLE`, created without a password by
   `prisma/migrations/20261008000100_identity_lane_role`. The migration also resets a role that
   already existed: it sets `NOREPLICATION`, and before granting the table below it revokes the
   role's privileges on tables, sequences and functions in schema `public`, on schema `public`
   itself and on the current database, and every role membership it holds. Procedures, default
   ACLs and object ownership are outside the reset: the role owns nothing and has none. Both
   identity-lane clients connect with it through `IDENTITY_DATABASE_URL`. The web container is
   no longer given `DATABASE_URL`; only the migrator is.
2. **Its grants are the table below, and nothing else**: no tenant record table (projects,
   assessments, remediation items, evidence), no sequences, no callable functions, no default
   privileges, no role memberships, `USAGE` but not `CREATE` on `public`.
3. **One permissive policy per pre-organisation table.** `organizations`, `memberships` and
   `invitations` have RLS enabled and forced with `org_isolation` as their only policy, which
   shows a row only when `app.current_org_id` names its organisation. No GUC can scope "which
   organisations is this user in" or "whose invitation is this token", so each table gets
   `CREATE POLICY identity_lane ON "<t>" FOR ALL TO makrai_identity USING (true) WITH CHECK
   (true)`. Permissive policies combine per role: `makrai_app` is still bound by
   `org_isolation` alone.
4. **`makrai_app` is narrowed to what its code uses** (TEN-04,
   `prisma/migrations/20261008000150_narrow_app_role_grants`), per the second table.
5. **Both lanes are checked at server start.** `instrumentation.ts#register` awaits
   `verifyDatabaseRoles` (`lib/data/connection.ts`), which connects with each URL and refuses
   a role that is a superuser, has BYPASSRLS or REPLICATION, or is a member of a superuser or
   BYPASSRLS role, and a
   lane connected as the other lane's role (swapped or reused URLs would put `withOrg` on
   `makrai_identity`, whose `identity_lane` policy would unscope its tenant reads). On a
   refusal `register()` exits the process, so a privileged or missing URL means no request is
   ever handled and the container's restart policy retries until the check passes. It exits
   rather than rejects because Next 16 does not stop on a rejected `register()`: measured
   against `next start` and the standalone `server.js`, it keeps listening, answers every
   request with 500, and never retries — so a server started before its role had a password
   would stay broken after the password arrived. This is the only check on the identity
   lane's own clients; `withOrg` keeps its per-process check on the app lane.
6. **Passwords come only from `scripts/provision-app-db-role.sh`**, on psql's stdin, for
   either role. Its dev passwords are refused unless `ALLOW_DEV_DB_PASSWORD=1`, whatever
   `NODE_ENV` says, and refused even when passed explicitly. Before `ALTER ROLE` it turns off,
   for its own session, every setting that copies statement text into the server log
   (`log_min_error_statement`, `log_statement`, `log_min_duration_statement`,
   `log_min_duration_sample`, `log_transaction_sample_rate`, `debug_print_*`), and checks the
   role exists in a statement that carries no password.

## Grants

`__tests__/integration/role-grants.test.ts` parses the three tables in this section and
compares them with the live catalog over every relation in `public`, so they are the
specification, not a description. A table not listed has no grant, and a column not listed
under "Column grants" has no column-level grant.

**v0.6.0** (migrations `20261030000200_v060_02_identity` to `20261030000600_v060_06_freeze`;
`docs/plans` contract "Grants"): the identity lane gains the reset-token and known-device
tables and a read of `organization_agreements` under its read-only `identity_lane` policy, and
loses DELETE on `consent_records`, which are kept through account deletion (FR-EXP-04). The
app lane gains SELECT and INSERT on the record tables, SELECT only on `tombstones` and
`organization_agreements`, UPDATE on `document_draft_fields`, and a column grant on
`invitations.status`; it loses INSERT and UPDATE on `assessments`, UPDATE on
`remediation_items` and DELETE on `evidence` (the scored tables are frozen; no route deletes
evidence). The identity rows for `organizations`, `memberships` and `invitations` stay as they
were until ORG's identity-revocation migration removes their direct writes. The definer and
operator roles (`makrai_definer`, `makrai_operator_fn`) are NOLOGIN, reached only through the
functions they own; their grants are the "Function-owner grants" table below.

### `makrai_identity` grants

| Table | Grants |
|---|---|
| `users` | SELECT, INSERT, UPDATE |
| `consent_records` | SELECT, INSERT |
| `organizations` | SELECT, INSERT |
| `memberships` | SELECT, INSERT |
| `invitations` | SELECT, UPDATE |
| `password_reset_tokens` | SELECT, INSERT |
| `known_devices` | SELECT, INSERT, UPDATE |
| `organization_agreements` | SELECT |

### `makrai_app` grants

| Table | Grants |
|---|---|
| `projects` | SELECT, INSERT, UPDATE, DELETE |
| `project_metadata` | SELECT, INSERT, UPDATE |
| `assessments` | SELECT |
| `remediation_items` | SELECT |
| `evidence` | SELECT, INSERT |
| `evidence_blobs` | SELECT, INSERT |
| `framework_versions` | SELECT |
| `memberships` | SELECT, UPDATE, DELETE |
| `invitations` | SELECT, INSERT |
| `organizations` | SELECT |
| `organization_agreements` | SELECT |
| `organisation_events` | SELECT, INSERT |
| `decision_versions` | SELECT, INSERT |
| `decision_evidence` | SELECT, INSERT |
| `findings` | SELECT, INSERT |
| `finding_events` | SELECT, INSERT |
| `mitigation_versions` | SELECT, INSERT |
| `mitigation_evidence` | SELECT, INSERT |
| `accepted_risks` | SELECT, INSERT |
| `stage_reviews` | SELECT, INSERT |
| `seals` | SELECT, INSERT |
| `issued_documents` | SELECT, INSERT |
| `issued_document_seals` | SELECT, INSERT |
| `issued_document_sources` | SELECT, INSERT |
| `document_events` | SELECT, INSERT |
| `document_draft_fields` | SELECT, INSERT, UPDATE |
| `reminder_log` | SELECT, INSERT |
| `tombstones` | SELECT |
| `request_receipts` | SELECT, INSERT |

### Column grants

| Role | Table | Column | Grants |
|---|---|---|---|
| `makrai_app` | `invitations` | `status` | UPDATE |
| `makrai_identity` | `password_reset_tokens` | `usedAt` | UPDATE |
| `makrai_identity` | `password_reset_tokens` | `voidedAt` | UPDATE |

### Function-owner grants

What the two NOLOGIN roles that own the SECURITY DEFINER functions hold (migrations
`20261030000200_v060_02_identity`, `20261030000300_v060_03_tenant` and
`20261030000500_v060_05_functions`). `*` is a table-level grant; a column name is a column grant.
`role-grants.test.ts` compares this table with the catalogue, both ways.

Beyond the contract's Grants rows, each needed by a function's own reads: `makrai_operator_fn`
SELECT on `evidence_blobs` (the WHERE of `erase_evidence_bytes`), on `issued_document_sources`
(which documents printed the erased field) and on `consent_records` (the WHERE of
`makrai_clear_consent_ip_addresses`); `makrai_definer` SELECT on `password_reset_tokens`
`userId`, `usedAt`, `voidedAt` (`admin_set_account_active` voids the open tokens). And, since C4
item 2 (WIO-1), `makrai_operator_fn` SELECT and UPDATE (`requestDigest`) on the eleven
retry-keyed tables: an erasure replaces the request digest of the erased row's request with
`'erased'`, the one value the refusal trigger admits there. And, since EXP's C4 fix round
(migration `20261105000000_exp_personal_platform_rows`), `makrai_definer` SELECT on
`platform_events` and `organisation_events`: the reads of `personal_platform_rows`, which returns
a person's own rows of those tables for the personal export (NFR-PRIV-08), ids, kinds and times
only. `organization_agreements` stays INSERT-only for it: `makrai_identity` already reads every
agreement through its `identity_lane` policy, so the export reads them on that lane.

| Role | Table | Column | Grants |
|---|---|---|---|
| `makrai_definer` | `invitations` | * | INSERT, SELECT, UPDATE |
| `makrai_definer` | `memberships` | * | INSERT, SELECT |
| `makrai_definer` | `organisation_events` | * | INSERT, SELECT |
| `makrai_definer` | `organization_agreements` | * | INSERT |
| `makrai_definer` | `organizations` | * | INSERT, SELECT |
| `makrai_definer` | `organizations` | `name` | UPDATE |
| `makrai_definer` | `password_reset_tokens` | `usedAt` | SELECT |
| `makrai_definer` | `password_reset_tokens` | `userId` | SELECT |
| `makrai_definer` | `password_reset_tokens` | `voidedAt` | SELECT, UPDATE |
| `makrai_definer` | `platform_events` | * | INSERT, SELECT |
| `makrai_definer` | `users` | * | SELECT |
| `makrai_definer` | `users` | `isActive` | UPDATE |
| `makrai_definer` | `users` | `sessionEpoch` | UPDATE |
| `makrai_operator_fn` | `accepted_risks` | * | SELECT |
| `makrai_operator_fn` | `accepted_risks` | `lookAgainNote` | UPDATE |
| `makrai_operator_fn` | `accepted_risks` | `lookAgainNoteSalt` | UPDATE |
| `makrai_operator_fn` | `accepted_risks` | `reason` | UPDATE |
| `makrai_operator_fn` | `accepted_risks` | `reasonSalt` | UPDATE |
| `makrai_operator_fn` | `accepted_risks` | `requestDigest` | UPDATE |
| `makrai_operator_fn` | `consent_records` | * | SELECT |
| `makrai_operator_fn` | `consent_records` | `ipAddress` | UPDATE |
| `makrai_operator_fn` | `decision_versions` | * | SELECT |
| `makrai_operator_fn` | `decision_versions` | `reason` | UPDATE |
| `makrai_operator_fn` | `decision_versions` | `reasonSalt` | UPDATE |
| `makrai_operator_fn` | `decision_versions` | `requestDigest` | UPDATE |
| `makrai_operator_fn` | `document_draft_fields` | * | SELECT |
| `makrai_operator_fn` | `document_draft_fields` | `fieldValues` | UPDATE |
| `makrai_operator_fn` | `document_events` | * | SELECT |
| `makrai_operator_fn` | `document_events` | `requestDigest` | UPDATE |
| `makrai_operator_fn` | `evidence` | * | SELECT |
| `makrai_operator_fn` | `evidence` | `filename` | UPDATE |
| `makrai_operator_fn` | `evidence` | `filenameSalt` | UPDATE |
| `makrai_operator_fn` | `evidence` | `label` | UPDATE |
| `makrai_operator_fn` | `evidence` | `labelSalt` | UPDATE |
| `makrai_operator_fn` | `evidence` | `requestDigest` | UPDATE |
| `makrai_operator_fn` | `evidence` | `url` | UPDATE |
| `makrai_operator_fn` | `evidence` | `urlSalt` | UPDATE |
| `makrai_operator_fn` | `evidence_blobs` | * | DELETE, SELECT |
| `makrai_operator_fn` | `finding_events` | * | SELECT |
| `makrai_operator_fn` | `finding_events` | `reason` | UPDATE |
| `makrai_operator_fn` | `finding_events` | `reasonSalt` | UPDATE |
| `makrai_operator_fn` | `finding_events` | `requestDigest` | UPDATE |
| `makrai_operator_fn` | `findings` | * | SELECT |
| `makrai_operator_fn` | `findings` | `description` | UPDATE |
| `makrai_operator_fn` | `findings` | `descriptionSalt` | UPDATE |
| `makrai_operator_fn` | `findings` | `requestDigest` | UPDATE |
| `makrai_operator_fn` | `findings` | `title` | UPDATE |
| `makrai_operator_fn` | `findings` | `titleSalt` | UPDATE |
| `makrai_operator_fn` | `issued_document_sources` | * | SELECT |
| `makrai_operator_fn` | `issued_documents` | * | SELECT |
| `makrai_operator_fn` | `issued_documents` | `pdf` | UPDATE |
| `makrai_operator_fn` | `issued_documents` | `plainText` | UPDATE |
| `makrai_operator_fn` | `issued_documents` | `requestDigest` | UPDATE |
| `makrai_operator_fn` | `issued_documents` | `typedFields` | UPDATE |
| `makrai_operator_fn` | `mitigation_versions` | * | SELECT |
| `makrai_operator_fn` | `mitigation_versions` | `cancelReason` | UPDATE |
| `makrai_operator_fn` | `mitigation_versions` | `cancelReasonSalt` | UPDATE |
| `makrai_operator_fn` | `mitigation_versions` | `changeNote` | UPDATE |
| `makrai_operator_fn` | `mitigation_versions` | `changeNoteSalt` | UPDATE |
| `makrai_operator_fn` | `mitigation_versions` | `closureNote` | UPDATE |
| `makrai_operator_fn` | `mitigation_versions` | `closureNoteSalt` | UPDATE |
| `makrai_operator_fn` | `mitigation_versions` | `requestDigest` | UPDATE |
| `makrai_operator_fn` | `mitigation_versions` | `what` | UPDATE |
| `makrai_operator_fn` | `mitigation_versions` | `whatSalt` | UPDATE |
| `makrai_operator_fn` | `request_receipts` | * | SELECT |
| `makrai_operator_fn` | `request_receipts` | `requestDigest` | UPDATE |
| `makrai_operator_fn` | `seals` | * | SELECT |
| `makrai_operator_fn` | `seals` | `requestDigest` | UPDATE |
| `makrai_operator_fn` | `stage_reviews` | * | SELECT |
| `makrai_operator_fn` | `stage_reviews` | `preparedFor` | UPDATE |
| `makrai_operator_fn` | `stage_reviews` | `preparedForSalt` | UPDATE |
| `makrai_operator_fn` | `stage_reviews` | `requestDigest` | UPDATE |
| `makrai_operator_fn` | `tombstones` | * | INSERT |

### Definer functions

`makrai_identity` may execute exactly nine functions, all SECURITY DEFINER and owned by the
NOLOGIN role `makrai_definer` (migration `20261030000500_v060_05_functions`; SRS 9.5 line 3673):
`accept_invitation`, `admin_create_organisation`, `admin_record_agreement`,
`admin_issue_owner_invitation`, `admin_resend_invitation`, `admin_revoke_invitation`,
`admin_set_account_active` and `admin_correct_org_name`, and the read
`personal_platform_rows` (migration `20261105000000_exp_personal_platform_rows`). Each
administrator function checks that its actor is an active platform administrator; each writes
its `organisation_events` (or `platform_events`) row in the same transaction as the action.
`personal_platform_rows` writes nothing: it returns the rows of `platform_events`, and the
organisation events an account acted in as `platform_admin`, that name one account, for its
personal export (FR-EXP-02, NFR-PRIV-08), with no other person's id or address in any one call.
It trusts its user-id argument, as the administrator functions trust their actor argument (the
database cannot know who is signed in), and it has no actor check to bound it. So any
`makrai_identity` session can call it for every id it can read in `users`, and joining those
results on the row ids rebuilds `platform_events` (actor, target, action and time; never
`requestReference`) and the id, organisation, action and time of every `platform_admin`
organisation event, which no application role can otherwise read. Its one caller is
`personalPlatformRows` (`lib/data/definer.ts`), called only by `personalExport`, which only
route 38 calls, with the signed-in session's own id; `personal-platform-rows-caller.test.ts`
pins that path, so a second caller fails CI. `makrai_app` may execute none.
`role-grants.test.ts` pins the list. The identity lane calls them only through
`lib/data/definer.ts`, on `identityLaneClient` (`lib/data/identityClient.ts`).

## Operation map

Every call that reaches one of these tables, found with
`git grep -nE '(ownerClient|tx|base|identityDb|appClient|client)\.(user|consentRecord|organization|membership|invitation)\.'`
widened to every model, plus relation `include`s, nested writes and raw SQL. Two PostgreSQL
rules decide some rows: Prisma's `create`/`update`/`delete` return the row with `RETURNING`,
which needs SELECT; and `SELECT … FOR UPDATE` needs UPDATE.

### Identity lane (`makrai_identity`)

| Operation | Call site | Privileges |
|---|---|---|
| Sign-in lookup, lockout counters | `lib/auth.ts:48`, `:86`, `:100` | users SELECT, UPDATE |
| Session resolve, epoch bump | `lib/auth/identity.ts:100`, `:330` | users SELECT, UPDATE |
| Home page, admin list and count | `app/page.tsx:22`, `app/(authenticated)/admin/users/page.tsx:27`, `app/(authenticated)/admin/settings/page.tsx:27` | users SELECT |
| Platform role change | `app/api/admin/users/[id]/role/route.ts:54`, `:68`, `:91` | users SELECT, UPDATE |
| Registration pre-checks | `app/api/auth/register/route.ts:75`, `app/api/v1/invitations/[token]/register/route.ts:55` | users SELECT |
| Password change | `app/api/users/me/password/route.ts:32`, `:65` | users SELECT, UPDATE |
| Account export | `app/api/users/me/export/route.ts:62`, `:79` | users SELECT, consent_records SELECT |
| Display names | `lib/data/identity.ts:333` (`lookupUserNames`) | users SELECT |
| Deactivate and scrub (batch `$transaction` on `base`) | `lib/data/identity.ts:377`, `:387` | users UPDATE (+SELECT: `sessionEpoch + 1` reads the column), consent_records DELETE |
| Memberships at login | `lib/data/preauth.ts:88` (`include: { org }`, filter on `org.deletedAt`) | memberships SELECT, organizations SELECT |
| Organisation by slug | `lib/data/preauth.ts:97` | organizations SELECT |
| Invitation by token | `lib/data/preauth.ts:127` (`include: { org: { select: { name } } }`) | invitations SELECT, organizations SELECT |
| Registration | `lib/data/preauth.ts:165`, `:173`, `:433`, `:515`, `:534` | users INSERT, consent_records INSERT, memberships INSERT, organizations INSERT (each +SELECT for `RETURNING`) |
| Account from invitation | `lib/data/preauth.ts:232`, `:239` | users INSERT, consent_records INSERT |
| Accept invitation | `lib/data/preauth.ts:327`, `:333`, `:339` | invitations UPDATE, SELECT; memberships INSERT |
| Create another organisation | `lib/data/preauth.ts:411`, `:433`, `:534` | memberships SELECT, INSERT; organizations INSERT |
| Slug-retry savepoints | `lib/data/preauth.ts:532`, `:538`, `:542` | none (transaction control) |
| Admin seed | `prisma/seed.ts:101`, `:121`, `:143`, plus `bootstrapOrgWithOwner` | users SELECT, UPDATE; as registration |

Nothing on the lane deletes a user (`identityDb` exposes no delete; the role has no DELETE on
`users`), so the `memberships_userId_fkey ON DELETE CASCADE` path is closed twice.

### App lane (`makrai_app`)

| Table | Kept, with call sites | Revoked |
|---|---|---|
| `projects` | SELECT (dashboard, project pages, API reads); INSERT `app/api/v1/orgs/[slug]/projects/route.ts:92`; UPDATE `…/projects/[id]/route.ts:102`; DELETE `…/projects/[id]/route.ts:137` | — |
| `project_metadata` | SELECT (`include: { metadata }`); INSERT nested create `…/projects/route.ts:104` and upsert `…/projects/[id]/route.ts:108`; UPDATE the same upsert | DELETE |
| `assessments` | SELECT (many); INSERT `…/assessments/route.ts:86`; UPDATE `lib/data/assessments.ts:84`, `:201` and the `FOR UPDATE` lock at `…/evidence/[evidenceId]/route.ts:278` | DELETE |
| `remediation_items` | SELECT `…/remediation/route.ts:36`, `:75`, `…/assessments/[id]/evidence/route.ts:226`, includes; UPDATE `…/remediation/route.ts:89` | INSERT, DELETE |
| `evidence` | SELECT `lib/data/evidence.ts:33`, `:84`, `:111`; INSERT `lib/data/evidence.ts:43`; DELETE `…/evidence/[evidenceId]/route.ts:294` | — |
| `evidence_blobs` | SELECT (`include: { blob }`, `…/evidence/[evidenceId]/route.ts:130`); INSERT `lib/data/evidence.ts:57` | DELETE |
| `framework_versions` | SELECT `lib/data/framework.ts:102` | — |
| `memberships` | SELECT (member lists, owner counts); UPDATE `…/members/[userId]/route.ts:26` and the `FOR UPDATE` locks at `app/api/users/me/route.ts:97`, `lib/data/members.ts:130`; DELETE `app/api/users/me/route.ts:101`, `lib/data/members.ts:135` | INSERT |
| `invitations` | INSERT `lib/data/members.ts:58` (+SELECT for `RETURNING`) | UPDATE, DELETE |
| `organizations` | SELECT `lib/data/members.ts:68` | INSERT, UPDATE, DELETE |
| `users`, `consent_records`, `_prisma_migrations` | none (unchanged since `20260803062144`) | — |

Children of a deleted project, assessment or evidence row go by `ON DELETE CASCADE`, which
PostgreSQL runs with the referencing table owner's rights, so `makrai_app` needs no DELETE on
them. Pinned by `role-grants.test.ts` ("cascades after the app grants were narrowed") and
`evidence-download.test.ts` ("… and its blob with it").

## The trade-off

`identity_lane` is `USING (true)`: the lane reads every organisation, membership and
invitation on the platform, exactly as it did on the owner connection. This decision does not
narrow that; it removes everything else the owner credential carried — every other tenant
table, schema changes, superuser file and function access — and puts a database refusal
behind the application guards instead of nothing.

The write side is as wide. `WITH CHECK (true)`, with INSERT on memberships and UPDATE on
invitations, lets the lane add any user to any organisation in any role and rewrite any
invitation, and UPDATE on users lets it set any account's password hash. That matches the
pre-M0 owner connection, which could do strictly more, and the M1/M3 groups work narrows it.

Narrowing the three tables needs a key the database can check before an organisation is
known, such as the authenticated user's id in a GUC, so that a policy can say "memberships of
this user" and "invitations to this user's email". That arrives with the M1/M3 groups work.

## Consequences

**Positive**

- No web-process credential can bypass RLS, read a tenant record table it is not given, or
  create objects in the schema. `__tests__/integration/identity-lane.test.ts` proves the role
  is refused every tenant record table (generated from `pg_policies`) and `CREATE`.
- A misconfigured URL cannot silently restore the old exposure: the server refuses to start.
- `makrai_app` loses 11 privileges no code used, so a defect on the app lane can no longer,
  for example, insert a membership into its own organisation or rewrite an invitation.
- The dev passwords cannot be provisioned by accident: the default is opt-in, and the script
  refuses the published value however it arrives.

**Negative, accepted**

- A defect in the identity lane can therefore still reach any tenant indirectly, through an
  account: enrol one in the organisation, or set a member's password hash, then sign in and be
  served by the app lane as that member.
- A third credential to provision and rotate. Deployment gains a step (runbook §6.4).
- The server will not start until the identity role has its password, so the first deploy
  runs the migrator, provisions the password, and only then starts the app.
- `CREATE TEMP TABLE` still works for both roles: PostgreSQL grants `TEMPORARY` on every
  database to PUBLIC by default. Temporary objects are session-local and invisible to other
  connections; revoking it is a database-level change this ADR does not make.
- The boot check is the only guard on the identity lane's clients. If `register()` did not
  run — a custom server, or a script importing `lib/data/preauth` directly, as
  `prisma/seed.ts` does — nothing checks that lane's role at run time. The seed runs only in
  the migrator, with the same URL the server checks.
- A new table that the identity lane needs must be granted here and in a migration; the
  grants test fails until both agree.

## Alternatives rejected

- **Keep the owner connection and harden the guards further.** Five rounds of hardening
  `identityDb` show how that ends: each guard closed the paths its author imagined. A grant is
  enforced by the database for every path.
- **Use `makrai_app` for the identity lane.** It would need the identity grants and a
  permissive policy on three tenant tables, so every tenant request would carry the identity
  lane's reach. Two roles keep each lane's reach to what it needs.
- **Per-command policies instead of `FOR ALL`.** The grants already limit the commands; four
  policies per table would restate them and could drift from them.
- **`SECURITY DEFINER` functions for the pre-organisation lookups.** They would narrow reads
  today, but move query logic into SQL, outside Prisma and the tests that cover it, and still
  need an owner with the old reach.

## References

- `prisma/migrations/20261008000100_identity_lane_role/migration.sql`,
  `prisma/migrations/20261008000150_narrow_app_role_grants/migration.sql`
- `lib/data/connection.ts` (`assertUnprivilegedRole`, `verifyDatabaseRoles`),
  `instrumentation.ts`
- `scripts/provision-app-db-role.sh`; `docs/runbooks/deployment.md` §4, §6.4
- `__tests__/integration/identity-lane.test.ts`, `__tests__/integration/role-grants.test.ts`,
  `__tests__/lint/provision-script.test.ts`
