import type { DocumentType, Stage } from './record';

export type RecordPart = 'status' | 'reason' | 'options' | 'evidence' | 'scope';
export type SourceStage = Stage | 'review';
export type FieldSource =
  | { kind: 'record'; questionId: string; parts: RecordPart[] }
  | { kind: 'record_option'; questionId: string; option: string }
  | { kind: 'findings'; stage: SourceStage; filter: 'all' | 'open' | 'open_and_closed' | 'closed_by_mitigation' | 'counts'; areas?: string[] }
  | { kind: 'mitigations'; stage: SourceStage; filter: 'current' | 'done' | 'counts' }
  | { kind: 'accepted_risks'; stage: SourceStage }
  | { kind: 'project'; field: string }
  | { kind: 'typed'; structured?: 'ethics_approval' }
  | { kind: 'meta'; item: 'seals' | 'deciders' | 'no_decision' | 'not_applicable' | 'review' }
  | { kind: 'mapping' };
export interface FieldMapEntry { fieldId: string; label: string; section: string; sources: FieldSource[]; typedAddition: boolean }
export interface FieldMap { documentType: DocumentType; homeStage: Stage | 'review'; templateVersion: string; fields: FieldMapEntry[] }
