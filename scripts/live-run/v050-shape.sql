-- The v0.5.0-shaped database of SRS 12.2 step 3 (line 4983), for the live run's deploy and rollback rehearsal
-- (V-prog Task 8 Step 2; V reuses it). Run it on a database that the v0.5.0 migrator image has migrated and the v0.5.0
-- seed has filled (the platform administrator, owner of the seeded organisation ADMIN_ORG_NAME, A-6), as the owner role:
--
--   psql -U makrai -d makrai -v ON_ERROR_STOP=1 -v synthetic_slug=<SYNTHETIC_ORG_SLUG> -v password_hash=<bcrypt hash> \
--        -f scripts/live-run/v050-shape.sql
--
-- It adds, all synthetic (NFR-PRIV-05), every address at example.test:
--   - the synthetic organisation <synthetic_slug>, with one account, its owner;
--   - one assessor member in the seeded organisation (which keeps the platform administrator as its only owner and no
--     project, A-6);
--   - consent rows at version 1.0 with an IP address, 192.0.2.10 (a documentation address), for both new accounts, the
--     rows v0.6.0's makrai_clear_consent_ip_addresses() clears (deployment.md 9.5);
--   - one expired invitation to the synthetic organisation.
-- password_hash is the bcrypt hash of a password the run generates and keeps out of every file; the two new accounts
-- share it, so the rehearsal can sign them in. It refuses to run twice: the synthetic organisation's slug is unique.
-- It prints the counts of each part, then the totals, as its check.

\set ON_ERROR_STOP 1
begin;

insert into organizations (id, name, slug, "createdAt", "updatedAt")
values (gen_random_uuid()::text, 'Synthetic monitor organisation', :'synthetic_slug', now(), now());

insert into users (id, email, name, "passwordHash", role, "termsAccepted", "termsAcceptedAt", "createdAt", "updatedAt")
values (gen_random_uuid()::text, 'synthetic-owner@example.test', 'Synthetic Owner', :'password_hash', 'assessor', true, now(), now(), now()),
       (gen_random_uuid()::text, 'seeded-assessor@example.test', 'Seeded Assessor', :'password_hash', 'assessor', true, now(), now(), now());

insert into memberships (id, "orgId", "userId", role)
select gen_random_uuid()::text, o.id, u.id, 'owner'
from organizations o, users u where o.slug = :'synthetic_slug' and u.email = 'synthetic-owner@example.test';

-- The seeded organisation is the one the platform administrator owns (the v0.5.0 seed's ADMIN_ORG_NAME).
insert into memberships (id, "orgId", "userId", role)
select gen_random_uuid()::text, m."orgId", u.id, 'assessor'
from memberships m join users a on a.id = m."userId" and a.role = 'admin' and m.role = 'owner', users u
where u.email = 'seeded-assessor@example.test';

insert into consent_records (id, "userId", "consentType", version, granted, "ipAddress")
select gen_random_uuid()::text, u.id, t.kind::"ConsentType", '1.0', true, '192.0.2.10'
from users u, (values ('terms_of_service'), ('privacy_policy')) t(kind)
where u.email in ('synthetic-owner@example.test', 'seeded-assessor@example.test');

insert into invitations (id, "orgId", email, role, status, "invitedById", "expiresAt", "tokenHash")
select gen_random_uuid()::text, o.id, 'expired-invitee@example.test', 'viewer', 'expired', u.id, now() - interval '30 days',
       encode(sha256(gen_random_uuid()::text::bytea), 'hex')
from organizations o, users u where o.slug = :'synthetic_slug' and u.email = 'synthetic-owner@example.test';

commit;

select 'synthetic_org=' || count(*) from organizations where slug = :'synthetic_slug';
select 'synthetic_owner=' || count(*) from memberships m join organizations o on o.id = m."orgId"
  where o.slug = :'synthetic_slug' and m.role = 'owner';
select 'seeded_org_owners=' || count(*) from memberships m join users a on a.id = m."userId"
  where m.role = 'owner' and m."orgId" = (select m2."orgId" from memberships m2 join users a2 on a2.id = m2."userId"
    where a2.role = 'admin' and m2.role = 'owner' limit 1);
select 'seeded_org_assessors=' || count(*) from memberships m join users u on u.id = m."userId"
  where u.email = 'seeded-assessor@example.test' and m.role = 'assessor';
select 'consent_with_ip=' || count(*) from consent_records where "ipAddress" = '192.0.2.10';
select 'expired_invitations=' || count(*) from invitations where status = 'expired';
select 'projects=' || count(*) from projects;
select 'non_example_test_emails=' || count(*) from users where email not like '%@example.test';
