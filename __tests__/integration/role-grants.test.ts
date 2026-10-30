import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { Client } from 'pg';
import type { OrgContext } from '../../lib/data/tenant';
import { withOrg } from '../../lib/data/tenant';
import { testDb, resetDb, SEEDED_FRAMEWORK_VERSION_ID } from '../helpers/db';
import { adrColumnGrants, adrGrants, type LaneRole } from '../helpers/adr-grants';

/**
 * The two application roles hold exactly what ADR-0009 tables, and nothing that would
 * widen it later.
 *
 * Read from the catalog through the superuser `testDb`, over EVERY relation in
 * `public`, so a table added tomorrow is checked without anyone remembering to list
 * it: a new table must carry no grant to either role until the ADR says otherwise.
 *
 * Two readings of the same fact, because each misses something the other sees.
 * `information_schema.role_table_grants` lists grants made TO the role by name.
 * `has_table_privilege` answers what the role can actually do, which also counts grants
 * to PUBLIC and through role membership; a `GRANT SELECT ON projects TO PUBLIC` is
 * invisible to the first and caught by the second.
 */

const ROLES: LaneRole[] = ['makrai_identity', 'makrai_app'];

/** The eight definer functions makrai_identity may execute (v0.6.0 step 5), as regprocedure text. */
const DEFINER_FUNCTIONS = [
  { fn: 'accept_invitation(text,text,text)', returns: 'record' },
  { fn: 'admin_correct_org_name(text,text,text)', returns: 'text' },
  { fn: 'admin_create_organisation(text,text,text,text,text,date,text,text,text,text,timestamp with time zone,boolean)', returns: 'record' },
  { fn: 'admin_issue_owner_invitation(text,text,text,text,timestamp with time zone,text,boolean)', returns: 'text' },
  { fn: 'admin_record_agreement(text,text,text,text,date,text,text)', returns: 'text' },
  { fn: 'admin_resend_invitation(text,text,text,text,timestamp with time zone,boolean)', returns: 'text' },
  { fn: 'admin_revoke_invitation(text,text,text)', returns: 'void' },
  { fn: 'admin_set_account_active(text,text,boolean,text,text[])', returns: 'text[]' },
];
const TABLE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];

type Row = { relname: string; privilege: string };

function toGrantMap(rows: Row[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const { relname, privilege } of rows) (out[relname] ??= []).push(privilege);
  for (const k of Object.keys(out)) out[k].sort();
  return out;
}

async function explicitGrants(role: LaneRole): Promise<Record<string, string[]>> {
  return toGrantMap(
    await testDb.$queryRaw<Row[]>`
      SELECT table_name::text AS relname, privilege_type::text AS privilege
      FROM information_schema.role_table_grants
      WHERE grantee = ${role} AND table_schema = 'public'`,
  );
}

async function effectiveGrants(role: LaneRole): Promise<Record<string, string[]>> {
  return toGrantMap(
    await testDb.$queryRaw<Row[]>`
      SELECT c.relname::text AS relname, p.privilege
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN unnest(${TABLE_PRIVILEGES}::text[]) AS p(privilege)
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND has_table_privilege(${role}::text, c.oid, p.privilege)`,
  );
}

describe('database role grants (ADR-0009)', () => {
  it('reads the identity tables of ADR-0009 (the five of v0.5.0 and the three of v0.6.0), so the comparisons below are not vacuous', () => {
    expect(Object.keys(adrGrants('makrai_identity')).sort()).toEqual(
      ['consent_records', 'invitations', 'known_devices', 'memberships', 'organization_agreements', 'organizations',
        'password_reset_tokens', 'users'],
    );
    expect(Object.keys(adrGrants('makrai_app')).length).toBeGreaterThan(5);
    // The column grants table is read too (contract executed claim E-10).
    expect(adrColumnGrants('makrai_app')).toEqual({ invitations: { status: ['UPDATE'] } });
    expect(adrColumnGrants('makrai_identity')).toEqual({ password_reset_tokens: { usedAt: ['UPDATE'], voidedAt: ['UPDATE'] } });
  });

  it('grants equal ADR-0009 for both roles', async () => {
    for (const role of ROLES) {
      const expected = adrGrants(role);
      expect({ role, grants: await explicitGrants(role) }).toEqual({ role, grants: expected });
      expect({ role, grants: await effectiveGrants(role) }).toEqual({ role, grants: expected });

      // Column-level grants are exactly ADR-0009's "Column grants" table: no other column
      // grant can reopen a table the table-level grant closes.
      const columnRows = await testDb.$queryRaw<{ relname: string; attname: string; privilege: string }[]>`
        SELECT c.relname::text AS relname, a.attname::text AS attname, x.privilege_type::text AS privilege
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL aclexplode(a.attacl) x
        WHERE n.nspname = 'public' AND a.attacl IS NOT NULL
          AND x.grantee IN (0, (SELECT oid FROM pg_roles WHERE rolname = ${role}))`;
      const columnGrants: Record<string, Record<string, string[]>> = {};
      for (const r of columnRows) ((columnGrants[r.relname] ??= {})[r.attname] ??= []).push(r.privilege);
      for (const t of Object.values(columnGrants)) for (const c of Object.keys(t)) t[c].sort();
      expect({ role, columnGrants }).toEqual({ role, columnGrants: adrColumnGrants(role) });

      // Sequences are relations too, and USAGE on one is a grant the table check skips.
      // CASE, not AND: SQL fixes no evaluation order, and has_sequence_privilege raises
      // on a relation that is not a sequence.
      const sequences = await testDb.$queryRaw<{ relname: string }[]>`
        SELECT c.relname::text AS relname
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND CASE WHEN c.relkind = 'S'
                   THEN has_sequence_privilege(${role}::text, c.oid, 'USAGE, SELECT, UPDATE')
                   ELSE false END`;
      expect({ role, sequences }).toEqual({ role, sequences: [] });

      // Every other function in public is a trigger or event-trigger function, or one
      // executable by no application role (the operator functions, integrity_append).
      // PUBLIC's default EXECUTE on a trigger function is inert: Postgres refuses to call it
      // outside a trigger. The only callable functions are the eight SECURITY DEFINER
      // functions of 20261030000500_v060_05_functions, for makrai_identity alone (SRS 9.5
      // line 3673; ADR-0009 "Definer functions").
      const callable = await testDb.$queryRaw<{ fn: string; returns: string }[]>`
        SELECT p.oid::regprocedure::text AS fn, p.prorettype::regtype::text AS returns
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND has_function_privilege(${role}::text, p.oid, 'EXECUTE')
          AND p.prorettype::regtype::text NOT IN ('trigger', 'event_trigger')
        ORDER BY 1`;
      expect({ role, callable }).toEqual({ role, callable: role === 'makrai_identity' ? DEFINER_FUNCTIONS : [] });

      // No default privilege may grant this role (or PUBLIC) rights on relations nobody
      // has reviewed yet: the view fail-open of 20260803140500 came in exactly that way.
      const defaults = await testDb.$queryRaw<{ objtype: string }[]>`
        SELECT d.defaclobjtype::text AS objtype
        FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) x
        WHERE x.grantee IN (0, (SELECT oid FROM pg_roles WHERE rolname = ${role}))`;
      expect({ role, defaults }).toEqual({ role, defaults: [] });
    }
  });

  it('gives both roles schema USAGE only, and no right to create in the schema or the database', async () => {
    for (const role of ROLES) {
      const [row] = await testDb.$queryRaw<
        { usage: boolean; schema_create: boolean; db_create: boolean }[]
      >`
        SELECT has_schema_privilege(${role}::text, 'public', 'USAGE')  AS usage,
               has_schema_privilege(${role}::text, 'public', 'CREATE') AS schema_create,
               has_database_privilege(${role}::text, current_database(), 'CREATE') AS db_create`;
      expect({ role, ...row }).toEqual({ role, usage: true, schema_create: false, db_create: false });
    }
  });

  it('makes both roles plain logins: no superuser, BYPASSRLS, CREATEDB, CREATEROLE or REPLICATION, and members of no role', async () => {
    for (const role of ROLES) {
      const rows = await testDb.$queryRaw<
        {
          rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean;
          rolcreatedb: boolean; rolcreaterole: boolean; rolreplication: boolean; memberof: string[];
        }[]
      >`
        SELECT r.rolcanlogin, r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole,
               r.rolreplication,
               ARRAY(SELECT g.rolname::text FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
                     WHERE m.member = r.oid ORDER BY 1) AS memberof
        FROM pg_roles r WHERE r.rolname = ${role}`;
      expect({ role, rows }).toEqual({
        role,
        rows: [{
          rolcanlogin: true, rolsuper: false, rolbypassrls: false,
          rolcreatedb: false, rolcreaterole: false, rolreplication: false, memberof: [],
        }],
      });
    }
  });
});

/**
 * The role migration must leave makrai_identity exactly at ADR-0009 even when the role
 * already existed and carried more: a hand-made role from an earlier attempt, or one an
 * operator widened while debugging. CREATE ROLE's defaults cover only a new role, so the
 * migration resets attributes, revokes what this database can hold for the role (see the
 * migration's own comment for the scope), and grants back the table. Proven by
 * dirtying the role in each way a reset must undo, re-running the migration's SQL as the
 * superuser, and comparing again.
 */
describe('the role migration resets a pre-existing makrai_identity', () => {
  const MIGRATION = 'prisma/migrations/20261008000100_identity_lane_role/migration.sql';

  it('removes REPLICATION, schema and database CREATE, sequence, function and table grants, and memberships', async () => {
    const su = new Client({ connectionString: process.env.DATABASE_URL, options: '' });
    await su.connect();
    const cleanup = [
      'DROP SEQUENCE IF EXISTS public.zz_reset_probe_seq',
      'DROP FUNCTION IF EXISTS public.zz_reset_probe_fn()',
      'DROP ROLE IF EXISTS zz_reset_probe_group',
      'ALTER ROLE makrai_identity NOREPLICATION',
      'REVOKE CREATE ON SCHEMA public FROM makrai_identity',
      'REVOKE SELECT ON "projects" FROM makrai_identity',
      `DO $$ BEGIN EXECUTE format('REVOKE CREATE ON DATABASE %I FROM makrai_identity', current_database()); END $$`,
    ];
    // v0.6.0 setup change (K0a): the re-run below grants back only the five v0.5.0 tables, with
    // DELETE on consent_records, and revokes every later grant, so the whole case runs in one
    // transaction that is rolled back (no later file sees a widened or stripped role), and the
    // makrai_identity GRANT and REVOKE statements of every later migration are replayed after
    // the re-run, so the comparison is still against ADR-0009 as it stands.
    const LATER_IDENTITY_GRANTS = readdirSync('prisma/migrations', { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name > '20261008000100_identity_lane_role')
      .map((d) => d.name).sort()
      .flatMap((name) => readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8')
        .replace(/--[^\n]*/g, ' ').split(';').map((s) => s.trim())
        .filter((s) => /^(GRANT|REVOKE)\b/i.test(s) && /\bmakrai_identity\b/.test(s)));
    await su.query('BEGIN');
    try {
      await su.query(`
        ALTER ROLE makrai_identity REPLICATION;
        GRANT CREATE ON SCHEMA public TO makrai_identity;
        GRANT SELECT ON "projects" TO makrai_identity;
        DO $$ BEGIN EXECUTE format('GRANT CREATE ON DATABASE %I TO makrai_identity', current_database()); END $$;
        CREATE SEQUENCE public.zz_reset_probe_seq;
        GRANT USAGE, SELECT, UPDATE ON SEQUENCE public.zz_reset_probe_seq TO makrai_identity;
        CREATE FUNCTION public.zz_reset_probe_fn() RETURNS int LANGUAGE sql AS 'SELECT 1';
        REVOKE EXECUTE ON FUNCTION public.zz_reset_probe_fn() FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION public.zz_reset_probe_fn() TO makrai_identity;
        CREATE ROLE zz_reset_probe_group NOLOGIN;
        GRANT zz_reset_probe_group TO makrai_identity;`);

      const state = async () =>
        (await su.query(`
          SELECT r.rolreplication AS replication,
                 has_schema_privilege('makrai_identity', 'public', 'CREATE') AS schema_create,
                 has_database_privilege('makrai_identity', current_database(), 'CREATE') AS db_create,
                 has_sequence_privilege('makrai_identity', 'public.zz_reset_probe_seq', 'USAGE, SELECT, UPDATE') AS sequence,
                 has_function_privilege('makrai_identity', 'public.zz_reset_probe_fn()', 'EXECUTE') AS function,
                 has_table_privilege('makrai_identity', 'projects', 'SELECT') AS projects_select,
                 ARRAY(SELECT g.rolname::text FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
                        WHERE m.member = r.oid) AS memberof
          FROM pg_roles r WHERE r.rolname = 'makrai_identity'`)).rows[0];

      // The dirt is really there, so the assertion after the re-run is not vacuous.
      expect(await state()).toEqual({
        replication: true, schema_create: true, db_create: true, sequence: true,
        function: true, projects_select: true, memberof: ['zz_reset_probe_group'],
      });

      await su.query(readFileSync(MIGRATION, 'utf8'));

      expect(await state()).toEqual({
        replication: false, schema_create: false, db_create: false, sequence: false,
        function: false, projects_select: false, memberof: [],
      });
      expect(LATER_IDENTITY_GRANTS.length).toBeGreaterThan(0);
      for (const statement of LATER_IDENTITY_GRANTS) await su.query(statement);
      expect(await explicitGrants('makrai_identity')).toEqual(adrGrants('makrai_identity'));
    } finally {
      await su.query('ROLLBACK');
      for (const q of cleanup) await su.query(q);
      await su.end();
    }
  });
});

/**
 * The narrowed app grants hold no DELETE on project_metadata, assessments or
 * remediation_items (20261008000150), on the strength of one PostgreSQL fact: an
 * ON DELETE CASCADE runs with the referencing table's OWNER's rights, not the caller's.
 * If that were wrong, deleting a project with children would fail for makrai_app.
 * The evidence -> evidence_blobs cascade is covered the same way by
 * evidence-download.test.ts ("... and its blob with it").
 */
describe('cascades after the app grants were narrowed', () => {
  it('removes a deleted project\u2019s metadata, assessments and remediation items, which makrai_app may not delete itself', async () => {
    await resetDb();
    const user = await testDb.user.create({ data: { email: 'cascade@x.org', name: 'c', passwordHash: 'x' } });
    const org = await testDb.organization.create({ data: { name: 'cascade', slug: 'cascade' } });
    const project = await testDb.project.create({
      data: { orgId: org.id, name: 'p', createdById: user.id, metadata: { create: {} } },
    });
    const assessment = await testDb.assessment.create({
      data: {
        orgId: org.id, projectId: project.id, userId: user.id,
        frameworkVersionId: SEEDED_FRAMEWORK_VERSION_ID, engineState: {},
      },
    });
    await testDb.remediationItem.create({
      data: {
        orgId: org.id, assessmentId: assessment.id, areaId: 'PO-03',
        areaName: 'Accountability', tier: 'gap', description: 'cascade probe',
      },
    });

    const ctx = { orgId: org.id, role: 'owner' } as OrgContext;
    await withOrg(ctx, (tx) => tx.project.delete({ where: { id: project.id } }));

    expect({
      metadata: await testDb.projectMetadata.count({ where: { projectId: project.id } }),
      assessments: await testDb.assessment.count({ where: { projectId: project.id } }),
      remediation: await testDb.remediationItem.count({ where: { assessmentId: assessment.id } }),
    }).toEqual({ metadata: 0, assessments: 0, remediation: 0 });
  });
});
