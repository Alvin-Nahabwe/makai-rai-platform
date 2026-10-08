import { describe, expect, it } from 'vitest';
import type { OrgContext } from '../../lib/data/tenant';
import { withOrg } from '../../lib/data/tenant';
import { testDb, resetDb, SEEDED_FRAMEWORK_VERSION_ID } from '../helpers/db';
import { adrGrants, type LaneRole } from '../helpers/adr-grants';

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
  it('reads the five identity tables the brief names, so the comparisons below are not vacuous', () => {
    expect(Object.keys(adrGrants('makrai_identity')).sort()).toEqual(
      ['consent_records', 'invitations', 'memberships', 'organizations', 'users'],
    );
    expect(Object.keys(adrGrants('makrai_app')).length).toBeGreaterThan(5);
  });

  it('grants equal ADR-0009 for both roles', async () => {
    for (const role of ROLES) {
      const expected = adrGrants(role);
      expect({ role, grants: await explicitGrants(role) }).toEqual({ role, grants: expected });
      expect({ role, grants: await effectiveGrants(role) }).toEqual({ role, grants: expected });

      // No column-level grant can reopen a table the table-level grant closes.
      const columnGrants = await testDb.$queryRaw<{ relname: string; attname: string }[]>`
        SELECT c.relname::text AS relname, a.attname::text AS attname
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL aclexplode(a.attacl) x
        WHERE n.nspname = 'public' AND a.attacl IS NOT NULL
          AND x.grantee IN (0, (SELECT oid FROM pg_roles WHERE rolname = ${role}))`;
      expect({ role, columnGrants }).toEqual({ role, columnGrants: [] });

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

      // Every function in public is a trigger or event-trigger function. PUBLIC's default
      // EXECUTE on those is inert: Postgres refuses to call them outside a trigger. A
      // callable function a role could execute is a grant ADR-0009 does not record.
      const callable = await testDb.$queryRaw<{ fn: string; returns: string }[]>`
        SELECT p.oid::regprocedure::text AS fn, p.prorettype::regtype::text AS returns
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND has_function_privilege(${role}::text, p.oid, 'EXECUTE')
          AND p.prorettype::regtype::text NOT IN ('trigger', 'event_trigger')`;
      expect({ role, callable }).toEqual({ role, callable: [] });

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
