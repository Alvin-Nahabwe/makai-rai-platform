/* eslint-disable @typescript-eslint/no-unused-vars -- the stub keeps the contract's parameter names; DEC-b replaces the body. */
import type { OrgRole } from '@prisma/client';
import type { OrgContext } from '@/lib/data/tenant';
import type { Identity } from '@/lib/auth/identity';
import type { DeclaredDate, ScopeAnswer, Stage } from '@/types/record';
import type { LoadedQuestion, ReasonCodeEntry } from '@/types/content';
import type { SealRef } from '@/types/seal';
import type { DecisionVersionView } from '@/types/api';
import { NotImplementedError } from '@/lib/http/errors';

/** What S-12 (the question panel) shows, loaded once for the page (FR-DEC-01, FR-CNT-02, UX-08). */
export interface QuestionPanelData {
  orgSlug: string; projectId: string; projectArchived: boolean; stage: Stage;
  question: LoadedQuestion;                 // wording of the version the current decision was answered against (FR-CNT-07)
  runningQuestion: LoadedQuestion;          // wording in the running content (FR-CNT-08 marker)
  position: { index: number; total: number; previousId: string | null; nextId: string | null };
  current: DecisionVersionView | null; historyCount: number;
  seals: SealRef[]; reasonCodes: ReasonCodeEntry[];
  members: Array<{ userId: string; name: string }>; viewer: { userId: string; name: string; role: OrgRole };
  canWrite: boolean; canRaiseFinding: boolean; lastOwnSaveDate: DeclaredDate | null;
  openFinding: { findingId: string } | null; gateAnswer: ScopeAnswer | null; contentSemver: string;
  orgId: string;                            // the draft key's organisation (UX-26; gap G041)
}

/**
 * The panel for one question of one project, or `NotFoundError` when the project or the question is not
 * this organisation's. A typed stub until DEC-b merges: it throws, because an empty panel would look like a
 * question with no decision.
 */
// CONTRACT_STUB: DEC-b
export async function loadQuestionPanel(
  ctx: OrgContext, identity: Identity, p: { projectId: string; stage: Stage; questionId: string },
): Promise<QuestionPanelData> {
  throw new NotImplementedError('DEC-b');
}
