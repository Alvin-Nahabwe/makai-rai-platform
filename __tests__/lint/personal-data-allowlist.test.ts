import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * NFR-PRIV-01: the system holds no personal data beyond the list in SRS 5.8 (lines
 * 1326-1337). Every column of every table v0.6.0 creates or changes appears in a
 * reviewed allow-list that maps it to a row of 5.8 or says "no personal data"; a
 * column not on the list fails CI (SRS lines 3017-3021).
 *
 * Two roots (AGENTS.md section 3): the columns of the v0.6.0 models in
 * `prisma/schema.prisma`, and the columns the v0.6.0 migration files create or add.
 * A column reachable from either and missing from the list fails.
 */

const ALLOW_LIST = '__tests__/lint/personal-data-allowlist.json';
const MIGRATIONS = 'prisma/migrations';
const V060_FIRST = '20261030';

/** The models v0.6.0 creates, and the existing ones whose columns it changes (00-contract.md, Data model names). */
const V060_MODELS = [
  // created
  'OrganisationAgreement', 'RequestReceipt', 'PasswordResetToken', 'KnownDevice', 'PlatformEvent',
  'OrganisationEvent', 'DecisionVersion', 'DecisionEvidence', 'MitigationEvidence', 'Finding', 'FindingEvent',
  'MitigationVersion', 'AcceptedRisk', 'StageReview', 'Seal', 'IssuedDocument', 'IssuedDocumentSeal',
  'IssuedDocumentSource', 'DocumentEvent', 'DocumentDraftFields', 'ReminderLog', 'Tombstone',
  // changed
  'User', 'ConsentRecord', 'Invitation', 'Project', 'Evidence',
];

/** SRS 5.8, lines 1326-1337: the "Where" column. */
const SRS_58_ROWS = ['Accounts', 'Acceptances', 'Organisation agreements', 'Records', 'Evidence', 'Logs',
  'Browser drafts', 'Email (Resend, US)'];

type Column = { table: string; column: string };
type Entry = Column & { maps: string };

function allowList(): Entry[] {
  return JSON.parse(readFileSync(ALLOW_LIST, 'utf8')) as Entry[];
}

/** Every scalar column of the named models, as `{ table: @@map name, column: field name }`. */
function columnsOfModels(schema: string, models: readonly string[]): Column[] {
  const blocks = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)];
  const modelNames = new Set(blocks.map((b) => b[1]));
  const enumNames = new Set([...schema.matchAll(/^enum (\w+) \{/gm)].map((m) => m[1]));
  const out: Column[] = [];
  for (const [, name, body] of blocks) {
    if (!models.includes(name)) continue;
    const map = /@@map\("([^"]+)"\)/.exec(body);
    if (!map) throw new Error(`model ${name} has no @@map`);
    for (const raw of body.split('\n')) {
      const line = raw.replace(/\/\/.*$/, '').trim();
      if (!line || line.startsWith('@@') || line.startsWith('///') || line.startsWith('*') || line.startsWith('/**')) continue;
      const m = /^(\w+)\s+(\w+)(\[\]|\?)?/.exec(line);
      if (!m) continue;
      const type = m[2];
      if (modelNames.has(type)) continue; // a relation field, not a column
      if (!enumNames.has(type) && !/^(String|Int|BigInt|Boolean|DateTime|Bytes|Json|Float|Decimal)$/.test(type)) {
        throw new Error(`model ${name}: cannot classify field type ${type} of ${m[1]}`);
      }
      out.push({ table: map[1], column: m[1] });
    }
  }
  for (const model of models) {
    if (!blocks.some((b) => b[1] === model)) out.push({ table: `(model ${model} missing)`, column: '*' });
  }
  return out;
}

function v060MigrationSql(): string[] {
  return readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.slice(0, 8) >= V060_FIRST)
    .map((d) => d.name)
    .sort()
    .map((name) => readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' '));
}

const unquote = (s: string) => s.replace(/^"|"$/g, '');

/** Columns of every `CREATE TABLE` and every `ADD COLUMN` in the SQL. */
function columnsAddedOrCreated(files: readonly string[]): Column[] {
  const out: Column[] = [];
  for (const sql of files) {
    for (const m of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?("[^"]+"|\w+)\s*\(([\s\S]*?)\);/gi)) {
      const table = unquote(m[1]);
      let depth = 0;
      let cur = '';
      const parts: string[] = [];
      for (const ch of m[2]) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
        cur += ch;
      }
      parts.push(cur.trim());
      for (const p of parts) {
        if (/^(CONSTRAINT|PRIMARY KEY|UNIQUE|FOREIGN KEY|CHECK|EXCLUDE)\b/i.test(p)) continue;
        const c = /^("[^"]+"|\w+)\s/.exec(p);
        if (c) out.push({ table, column: unquote(c[1]) });
      }
    }
    for (const stmt of sql.split(';')) {
      const t = /ALTER TABLE (?:IF EXISTS )?(?:ONLY )?("[^"]+"|\w+)/i.exec(stmt);
      if (!t) continue;
      for (const c of stmt.matchAll(/\bADD (?:COLUMN )?(?:IF NOT EXISTS )?("[^"]+"|\w+)/gi)) {
        if (/^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE)$/i.test(c[1])) continue;
        out.push({ table: unquote(t[1]), column: unquote(c[1]) });
      }
    }
  }
  return out;
}

function missingFromAllowList(cols: readonly Column[]): Column[] {
  const listed = new Set(allowList().map((e) => `${e.table}.${e.column}`));
  const seen = new Set<string>();
  return cols.filter((c) => {
    const key = `${c.table}.${c.column}`;
    if (listed.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

describe('NFR-PRIV-01 personal-data allow-list', () => {
  it('NFR-PRIV-01: every v0.6.0 column is in the allow-list, from schema.prisma and from the migrations', () => {
    expect(existsSync(ALLOW_LIST)).toBe(true);
    const fromSchema = columnsOfModels(readFileSync('prisma/schema.prisma', 'utf8'), V060_MODELS);
    const fromSql = columnsAddedOrCreated(v060MigrationSql());
    expect(fromSql.length).toBeGreaterThan(0);   // the SQL root is not empty, so the comparison is not vacuous
    expect(missingFromAllowList([...fromSchema, ...fromSql])).toEqual([]);
  });

  it('NFR-PRIV-01: every allow-list entry maps to a row of SRS 5.8 or says "no personal data"', () => {
    const entries = allowList();
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect(SRS_58_ROWS.concat('no personal data')).toContain(e.maps);
    // One entry per column: a duplicate could carry two different mappings.
    const keys = entries.map((e) => `${e.table}.${e.column}`);
    expect(keys.length).toBe(new Set(keys).size);
  });
});
