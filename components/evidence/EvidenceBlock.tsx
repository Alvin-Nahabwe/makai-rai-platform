import type { EvidenceItemView } from '@/types/api';
import type { ReactElement } from 'react';

export type EvidenceBlockProps = {
  orgSlug: string;
  projectId: string;
  initial: EvidenceItemView[];
  disabled: boolean;
  onChange: (evidenceIds: string[]) => void;
  onUploadState: (s: { uploading: string[]; failed: string[] }) => void;
  /** W-4's evidence names in "your answer". */
  onItemsChange?: (items: EvidenceItemView[]) => void;
  /** M-18: files still uploading when the page closed, kept by the parent's per-account draft. */
  notUploaded?: readonly string[];
  /** W-3's "from version N". */
  fromVersionNumber?: number | null;
};

/**
 * The evidence of a decision form: add a file or a link, with a status line per upload (UX-30, FR-EVD-01 to
 * 03). A slot of S-12 (nested in the answer form) and S-15; EVD fills it.
 */
// SLOT_STUB: EVD
export function EvidenceBlock(_props: EvidenceBlockProps): ReactElement | null {
  return null;
}
