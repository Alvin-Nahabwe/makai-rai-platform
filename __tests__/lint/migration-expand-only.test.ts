import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * NFR-REL-07: the v0.5.0 image must keep running against the v0.6.0 schema, so an
 * application-only rollback needs no database restore (SRS lines 3165-3169). The
 * lint refuses, in every v0.6.0 migration file, a DROP or RENAME, a NOT NULL added
 * without a DEFAULT to a table v0.5.0 writes, and a new CHECK constraint on such a
 * table, except the four constraints the contract allow-lists (00-contract.md, Data
 * model, "NFR-REL-07 against 9.5"; owner question 6).
 *
 * Plain string parsing of the SQL. Comments are stripped first, so a word inside a
 * comment is never read as DDL; function bodies are NOT stripped, so a DROP inside
 * a DO block or a function still counts (conservative: the lint over-reports
 * rather than under-reports).
 */

const MIGRATIONS = 'prisma/migrations';
const V060_FIRST = '20261030';

/** Tables the v0.5.0 application writes (W:`lib/data`, `app/api`). */
const V050_WRITTEN = ['users', 'consent_records', 'organizations', 'memberships', 'invitations', 'projects',
  'project_metadata', 'assessments', 'remediation_items', 'evidence', 'evidence_blobs'];

/** The reading of NFR-REL-07 recorded in the contract (Data model, "NFR-REL-07 against 9.5"; owner question 6). */
const ALLOWED = [
  { table: 'evidence', constraint: 'evidence_kind_check', why: "kind defaults to 'file', which every v0.5.0 write gets" },
  { table: 'invitations', constraint: 'invitations_kind_check', why: "kind defaults to 'member'" },
  { table: 'evidence', constraint: 'evidence_attach_target_check', why: 'replaced by a wider CHECK every v0.5.0 row and write meets' },
  { table: 'evidence', constraint: 'evidence_dedup_key', why: 'replaced by the same unique index WHERE assessmentId IS NOT NULL' },
  // v0.6.1 (20261112000000_v061_organisation_legal_name): both keep every v0.5.0 and v0.6.0 write valid.
  { table: 'organisation_events', constraint: 'organisation_events_action_check', why: 'dropped and added back with one more action; every earlier action stays allowed' },
  { table: 'organizations', constraint: 'organizations_legalName_chk', why: 'on a new nullable column: no old write sets it, and NULL passes' },
];

type MigrationFile = { name: string; sql: string };
type Finding = { file: string; table?: string; name: string; statement: string };

function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

function v060MigrationSql(): MigrationFile[] {
  return readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.slice(0, 8) >= V060_FIRST)
    .map((d) => d.name)
    .sort()
    .map((name) => ({ name, sql: stripComments(readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8')) }));
}

const unquote = (s: string) => s.replace(/^"|"$/g, '');
const IDENT = String.raw`("[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*("[^"]+"|[A-Za-z_][\w$]*))?`;

/** Each `;`-terminated statement, whitespace collapsed. */
function statements(sql: string): string[] {
  return sql.split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** The table an `ALTER TABLE [IF EXISTS] [ONLY] <name>` statement changes, or null. */
function alteredTable(stmt: string): string | null {
  const m = new RegExp(String.raw`^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?${IDENT}`, 'i').exec(stmt);
  if (!m) return null;
  return unquote(m[2] ?? m[1]);
}

/** Top-level comma split of an ALTER TABLE's action list (parentheses respected). */
function actions(stmt: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of stmt) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Every DROP of a named object and every RENAME, with the name it drops or renames. */
function dropsAndRenames(files: MigrationFile[]): Finding[] {
  const out: Finding[] = [];
  for (const f of files) {
    for (const stmt of statements(f.sql)) {
      // DROP <kind> [IF EXISTS] <name>: a standalone DROP statement, or inside ALTER TABLE.
      const dropRe = new RegExp(String.raw`\bDROP (?:TABLE|COLUMN|TYPE|VIEW|MATERIALIZED VIEW|INDEX|CONSTRAINT|POLICY|TRIGGER|FUNCTION|SEQUENCE|SCHEMA|DOMAIN) (?:CONCURRENTLY )?(?:IF EXISTS )?${IDENT}`, 'gi');
      for (const m of stmt.matchAll(dropRe)) out.push({ file: f.name, name: unquote(m[2] ?? m[1]), statement: stmt });
      // ALTER TABLE t DROP <column> (the COLUMN keyword is optional in PostgreSQL).
      if (alteredTable(stmt)) {
        for (const a of actions(stmt.replace(/^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?\S+(?:\s*\.\s*\S+)? /i, ''))) {
          const m = new RegExp(String.raw`^DROP (?!COLUMN\b|CONSTRAINT\b|NOT NULL\b|DEFAULT\b|EXPRESSION\b|IDENTITY\b)(?:IF EXISTS )?${IDENT}`, 'i').exec(a);
          if (m) out.push({ file: f.name, table: alteredTable(stmt)!, name: unquote(m[1]), statement: stmt });
        }
      }
      for (const m of stmt.matchAll(new RegExp(String.raw`\bRENAME (?:COLUMN |CONSTRAINT )?(?:TO )?${IDENT}`, 'gi'))) {
        out.push({ file: f.name, name: unquote(m[2] ?? m[1]), statement: stmt });
      }
    }
  }
  return out;
}

/** `ADD COLUMN ... NOT NULL` with no DEFAULT, and `SET NOT NULL`, on the named tables. */
function addedNotNullWithoutDefault(files: MigrationFile[], tables: readonly string[]): Finding[] {
  const out: Finding[] = [];
  for (const f of files) {
    for (const stmt of statements(f.sql)) {
      const table = alteredTable(stmt);
      if (!table || !tables.includes(table)) continue;
      for (const a of actions(stmt)) {
        // An added column, not an added constraint; `IS NOT NULL` inside an expression is not a
        // column constraint.
        const add = new RegExp(String.raw`\bADD (?:COLUMN )?(?:IF NOT EXISTS )?(?!(?:CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE)\b)${IDENT}`, 'i').exec(a);
        if (add && /(?<!\bIS )\bNOT NULL\b/i.test(a) && !/\bDEFAULT\b/i.test(a)) out.push({ file: f.name, table, name: unquote(add[1]), statement: stmt });
        const set = new RegExp(String.raw`\bALTER (?:COLUMN )?${IDENT} SET NOT NULL\b`, 'i').exec(a);
        if (set) out.push({ file: f.name, table, name: unquote(set[1]), statement: stmt });
      }
    }
  }
  return out;
}

/** Every CHECK added to the named tables, by constraint name (`(unnamed)` for an inline unnamed one). */
function addedChecks(files: MigrationFile[], tables: readonly string[]): Finding[] {
  const out: Finding[] = [];
  for (const f of files) {
    for (const stmt of statements(f.sql)) {
      const table = alteredTable(stmt);
      if (!table || !tables.includes(table)) continue;
      for (const a of actions(stmt)) {
        if (!/\bCHECK\s*\(/i.test(a)) continue;
        const named = new RegExp(String.raw`\bCONSTRAINT ${IDENT} CHECK\b`, 'i').exec(a);
        out.push({ file: f.name, table, name: named ? unquote(named[1]) : '(unnamed)', statement: stmt });
      }
    }
  }
  return out;
}

describe('NFR-REL-07 migration lint (expand only)', () => {
  it('NFR-REL-07: v0.6.0 migrations contain no DROP or RENAME of anything except the allow-listed constraints', () => {
    expect(dropsAndRenames(v060MigrationSql()).filter((d) => !ALLOWED.some((a) => a.constraint === d.name))).toEqual([]);
  });

  it('NFR-REL-07: no NOT NULL without DEFAULT added to a table v0.5.0 writes', () => {
    expect(addedNotNullWithoutDefault(v060MigrationSql(), V050_WRITTEN)).toEqual([]);
  });

  it('NFR-REL-07: no new CHECK constraint on a table v0.5.0 writes except the allow-list', () => {
    expect(addedChecks(v060MigrationSql(), V050_WRITTEN).filter((c) => !ALLOWED.some((a) => a.constraint === c.name))).toEqual([]);
  });

  it('NFR-REL-07: the lint sees the v0.6.0 files (not vacuous)', () => {
    expect(v060MigrationSql().length).toBeGreaterThanOrEqual(7);
  });

  it('NFR-REL-07 (lint self-test): each parser catches the shape it exists to refuse', () => {
    const probe: MigrationFile[] = [{
      name: 'probe',
      sql: stripComments(`
        -- DROP TABLE "in_a_comment";
        DROP TABLE IF EXISTS "gone";
        ALTER TABLE "users" DROP "oldCol", ALTER COLUMN "x" DROP NOT NULL, ALTER COLUMN "y" DROP DEFAULT;
        ALTER TABLE "evidence" DROP CONSTRAINT "evidence_dedup_key";
        ALTER TABLE "projects" RENAME COLUMN "name" TO "title";
        ALTER TABLE "users" ADD COLUMN "a" TEXT NOT NULL, ADD COLUMN "b" BOOLEAN NOT NULL DEFAULT true;
        ALTER TABLE "memberships" ALTER COLUMN "role" SET NOT NULL;
        ALTER TABLE "users" ADD CONSTRAINT "users_new_fkey" FOREIGN KEY ("x") REFERENCES "y"("id");
        ALTER TABLE "users" ADD COLUMN "c" TEXT CHECK ("d" IS NOT NULL);
        ALTER TABLE "invitations" ADD CONSTRAINT "inv_new_check" CHECK ("x" > 0);
        ALTER TABLE "evidence" ADD COLUMN "k" TEXT NOT NULL DEFAULT 'file' CHECK ("k" <> '');
        ALTER TABLE "decision_versions" ADD CONSTRAINT "dv_check" CHECK (true);`),
    }];
    // A RENAME is reported under the name it takes away (the old one).
    expect(dropsAndRenames(probe).map((d) => d.name).sort()).toEqual(['evidence_dedup_key', 'gone', 'name', 'oldCol']);
    expect(addedNotNullWithoutDefault(probe, V050_WRITTEN).map((d) => `${d.table}.${d.name}`)).toEqual(['users.a', 'memberships.role']);
    expect(addedChecks(probe, V050_WRITTEN).map((d) => `${d.table}.${d.name}`)).toEqual(['users.(unnamed)', 'invitations.inv_new_check', 'evidence.(unnamed)']);
  });
});
