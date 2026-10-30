import type { AgreementView } from '@/types/api';
import type { ReactElement } from 'react';

export type AgreementSummaryProps = { agreement: AgreementView | null };

/**
 * The organisation's agreement on the organisation settings page. A slot of its screen (contract "Screens and slots"): the screen's owner renders it, ORG fills it.
 */
// SLOT_STUB: ORG
export function AgreementSummary(_props: AgreementSummaryProps): ReactElement | null {
  return null;
}
