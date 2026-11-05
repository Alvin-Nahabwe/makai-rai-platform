import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DocumentType } from '@/types/record';
import type { FieldMap, FieldMapEntry, FieldSource } from '@/types/documents';
import type { LoadedContent } from '@/types/content';
import { runningContent } from '@/lib/content/loader';
import { PROJECT_FIELDS } from './copy';

const KINDS: readonly string[] = ['record', 'record_option', 'findings', 'mitigations', 'accepted_risks', 'project', 'typed', 'meta', 'mapping'];

/**
 * The field maps of the three documents (FR-DOC-01, FR-DOC-02; SRS 10.3). The files are C-MAP's `data/fieldmaps/<type>.json`;
 * this module reads one by a literal path under `process.cwd()` (contract "Static read paths", so the image traces it) and
 * checks it against the running content, so a map that names a question the content lacks fails loudly (SRS line 3896).
 */

const fail = (fieldId: string, why: string): never => {
  throw new Error(`field map ${fieldId}: ${why}`);
};

function checkSource(entry: FieldMapEntry, s: FieldSource, content: LoadedContent): void {
  if (!KINDS.includes(s.kind)) return fail(entry.fieldId, `source kind "${String(s.kind)}" is not one the generators know`);
  if (s.kind === 'project' && !PROJECT_FIELDS.includes(s.field)) return fail(entry.fieldId, `project field "${s.field}" is not a project column`);
  if (s.kind === 'typed' && s.structured !== undefined && s.structured !== 'ethics_approval') return fail(entry.fieldId, `typed structure "${String(s.structured)}" is not known`);
  if (s.kind !== 'record' && s.kind !== 'record_option') return;
  const q = content.questions.get(s.questionId);
  if (q === undefined) return fail(entry.fieldId, `question ${s.questionId} is not in content ${content.semver}`);
  if (s.kind === 'record_option') {
    if (!q.options?.includes(s.option)) fail(entry.fieldId, `question ${s.questionId} has no option "${s.option}"`);
    return;
  }
  if (s.parts.includes('scope') && q.type !== 'gate') fail(entry.fieldId, `part scope is only for a gate question, ${s.questionId} is a ${q.type}`);
  if (s.parts.includes('options') && q.type !== 'checklist') fail(entry.fieldId, `part options is only for a checklist question, ${s.questionId} is a ${q.type}`);
}

/** Validates a parsed map file against `content`; returns it typed. Throws an Error naming the field and the cause. */
export function parseFieldMap(json: unknown, content: LoadedContent): FieldMap {
  const map = json as FieldMap;
  if (typeof map !== 'object' || map === null || !Array.isArray(map.fields)) throw new Error('field map: not a map file');
  for (const entry of map.fields) for (const s of entry.sources) checkSource(entry, s, content);
  return map;
}

/** The committed map of a document type, checked against the running content version. */
export function loadFieldMap(type: DocumentType): FieldMap {
  const json: unknown = JSON.parse(readFileSync(join(process.cwd(), 'data', 'fieldmaps', `${type}.json`), 'utf8'));
  const map = parseFieldMap(json, runningContent());
  if (map.documentType !== type) throw new Error(`field map ${type}: the file says ${map.documentType}`);
  return map;
}
