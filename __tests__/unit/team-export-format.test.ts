import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The team export's format (makrai.team-export/1, docs/formats/team-export-1.json) against the Prisma schema, table by
 * table (C4 EXP-1 RE-3, controller ruling). readExportSnapshot writes every column of each exported table, and the
 * format refuses any property it does not name (additionalProperties false), so a migration that adds a column to an
 * exported table must update the export and the format in the same change, or list the column below as excluded with
 * its reason. This test fails until one of the two is done.
 */

const SCHEMA = readFileSync('prisma/schema.prisma', 'utf8');
const FORMAT = JSON.parse(readFileSync('docs/formats/team-export-1.json', 'utf8')) as {
  definitions: Record<string, { properties: Record<string, unknown> }>;
};

/** Every scalar column of a model (fields whose type is not another model). */
function columnsOf(model: string): string[] {
  const blocks = [...SCHEMA.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)];
  const models = new Set(blocks.map((b) => b[1]));
  const block = blocks.find((b) => b[1] === model);
  if (!block) throw new Error(`prisma/schema.prisma has no model ${model}`);
  return block[2].split('\n').map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && !l.startsWith('@@') && !l.startsWith('///'))
    .map((l) => /^(\w+)\s+(\w+)/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null && !models.has(m[2]))
    .map((m) => m[1]);
}

/**
 * Each exported table: its Prisma model, its definition in the format, the columns it writes under another name, the
 * properties the export adds, and the columns it leaves out on purpose, each with its reason.
 */
const TABLES: Array<{
  model: string; definition: string;
  renamed?: Record<string, string>; added?: string[]; excluded?: Record<string, string>;
}> = [
  {
    model: 'Project', definition: 'project',
    added: ['metadata', 'decisionVersions', 'decisionEvidence', 'evidence', 'findings', 'findingEvents', 'mitigationVersions',
      'mitigationEvidence', 'acceptedRisks', 'stageReviews', 'seals', 'issuedDocuments', 'issuedDocumentSeals', 'documentEvents'],
    excluded: {
      orgId: 'the export is of one organisation, named once at the top',
      createdById: 'EXP.md Task 1 lists a project as id, name, description, archivedAt and createdAt',
      updatedAt: 'as createdById',
    },
  },
  { model: 'ProjectMetadata', definition: 'projectMetadata' },
  { model: 'DecisionVersion', definition: 'decisionVersion' },
  { model: 'DecisionEvidence', definition: 'decisionEvidence' },
  { model: 'Evidence', definition: 'evidence', renamed: { filename: 'fileName' }, added: ['file'] },
  { model: 'Finding', definition: 'finding' },
  { model: 'FindingEvent', definition: 'findingEvent' },
  { model: 'MitigationVersion', definition: 'mitigationVersion' },
  { model: 'MitigationEvidence', definition: 'mitigationEvidence' },
  { model: 'AcceptedRisk', definition: 'acceptedRisk' },
  { model: 'StageReview', definition: 'stageReview' },
  { model: 'Seal', definition: 'seal' },
  {
    model: 'IssuedDocument', definition: 'issuedDocument', added: ['file', 'withdrawn'],
    excluded: { pdf: 'the bytes are the ZIP entry named by file, documents/<id>.pdf' },
  },
  { model: 'IssuedDocumentSeal', definition: 'issuedDocumentSeal' },
  { model: 'DocumentEvent', definition: 'documentEvent' },
  { model: 'Tombstone', definition: 'tombstone' },
];

describe('makrai.team-export/1 against prisma/schema.prisma', () => {
  it('reads the format and the schema, so the comparison is not vacuous', () => {
    expect(Object.keys(FORMAT.definitions).length).toBeGreaterThanOrEqual(TABLES.length);
    expect(columnsOf('DecisionVersion')).toEqual(expect.arrayContaining(['id', 'reason', 'reasonSalt', 'receivedAt']));
  });

  it.each(TABLES)('FR-EXP-01 (C4 EXP-1 RE-3): every column of $model is in the format or excluded with a reason, and nothing else is', (t) => {
    const columns = columnsOf(t.model);
    const excluded = t.excluded ?? {};
    for (const reason of Object.values(excluded)) expect(reason.length).toBeGreaterThan(10);
    for (const c of Object.keys(excluded)) expect(columns, `${t.model}.${c} is excluded but no longer exists`).toContain(c);
    const expected = [
      ...columns.filter((c) => !(c in excluded)).map((c) => t.renamed?.[c] ?? c),
      ...(t.added ?? []),
    ].sort();
    const definition = FORMAT.definitions[t.definition];
    expect(definition, `docs/formats/team-export-1.json has no definition ${t.definition}`).toBeDefined();
    expect({ table: t.model, properties: Object.keys(definition.properties).sort() }).toEqual({ table: t.model, properties: expected });
  });
});
