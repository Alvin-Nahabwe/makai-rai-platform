import type { DocumentType, UtcInstant } from '@/types/record';
import type { FieldMap } from '@/types/documents';
import type { SealRef } from '@/types/seal';
import { renderDataCard } from './dataCard';
import { renderMitigationPlan } from './mitigationPlan';
import { renderModelCard } from './modelCard';

/** One field as the frame prints it: label, text (null prints "Not recorded") and the provenance line (contract Services row). */
export type ResolvedField = { fieldId: string; label: string; section: string; text: string | null; provenance: string };
/**
 * What the footer says the document is. An issued document names its time of issue and the seals it drew on. A draft names when its answers
 * were read, and has no seals, no fingerprint and no issue time to print (path to outputs, anti-goal 1).
 */
export type RenderStamp =
  | { kind: 'issued'; issuedAt: UtcInstant; seals: Array<SealRef & { fingerprint: string }> }
  | { kind: 'draft'; takenAt: UtcInstant };
export type RenderInput = { map: FieldMap; fields: ResolvedField[]; stamp: RenderStamp; organisationName: string; projectName: string };
export type Renderer = (input: RenderInput) => Promise<{ pdf: Buffer; plainText: string }>;

/** The renderer of each document type. A type with no renderer is `null` (S-18 offers only the types that have one). */
export const RENDERERS: Record<DocumentType, Renderer | null> = {
  data_card: renderDataCard,
  model_card: renderModelCard,
  mitigation_plan: renderMitigationPlan,
};
