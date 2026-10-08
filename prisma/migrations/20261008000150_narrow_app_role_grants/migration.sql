-- Least privilege for makrai_app (ADR-0009). 20260803062144 granted it SELECT, INSERT,
-- UPDATE and DELETE on every table that existed then; the later tables (evidence,
-- evidence_blobs, framework_versions) were granted one by one. This revokes every
-- privilege that no makrai_app code path uses, so a defect or an injection on the app
-- lane can do no more than the application does.
--
-- Method: every withOrg / appClient call in app/ and lib/ was mapped to the privileges
-- it needs, including nested writes, relation includes and raw SQL. ADR-0009 holds the
-- full table; the reasons for each revoke are:
--
--   project_metadata  DELETE          never deleted directly; a project delete removes
--                                     it by ON DELETE CASCADE, which PostgreSQL runs
--                                     with the table owner's rights, not the caller's
--   assessments       DELETE          same: only ever removed by cascade from projects
--   remediation_items INSERT, DELETE  no path creates one (the bulk-create POST was
--                                     not ported; see the remediation route's header)
--                                     and none deletes one except by cascade
--   evidence_blobs    DELETE          removed by cascade from evidence
--   memberships       INSERT          memberships are created only on the identity
--                                     lane (lib/data/preauth.ts acceptInvitation,
--                                     createOwnedOrg)
--   invitations       UPDATE, DELETE  the app lane only creates them
--                                     (lib/data/members.ts createInvitation); the
--                                     status transition runs on the identity lane
--   organizations     INSERT, UPDATE, the app lane only reads the current
--                     DELETE          organisation (lib/data/members.ts)
--
-- Kept privileges that look surprising: UPDATE on assessments and memberships also
-- serves SELECT ... FOR UPDATE row locks, which PostgreSQL authorises as UPDATE
-- (app/api/v1/orgs/[slug]/evidence/[evidenceId]/route.ts, lib/data/members.ts,
-- app/api/users/me/route.ts). SELECT on invitations serves the INSERT ... RETURNING
-- that Prisma's create issues.
--
-- REVOKE of a privilege the role does not hold is a no-op, so this is safe to re-run.
REVOKE DELETE                 ON "project_metadata"  FROM makrai_app;
REVOKE DELETE                 ON "assessments"       FROM makrai_app;
REVOKE INSERT, DELETE         ON "remediation_items" FROM makrai_app;
REVOKE DELETE                 ON "evidence_blobs"    FROM makrai_app;
REVOKE INSERT                 ON "memberships"       FROM makrai_app;
REVOKE UPDATE, DELETE         ON "invitations"       FROM makrai_app;
REVOKE INSERT, UPDATE, DELETE ON "organizations"     FROM makrai_app;
