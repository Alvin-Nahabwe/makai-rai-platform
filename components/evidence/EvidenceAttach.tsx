'use client';

/**
 * Plan 1c Task 10 — the evidence attach UI, rendered once per question
 * inside `QuestionBlock`.
 *
 * SINGLE RESPONSIBILITY: render one question's attached evidence, and offer
 * controls to add/remove it. It does NOT fetch, does NOT hold the evidence
 * list in its own state, and does NOT decide whether attach/delete is
 * allowed — all of that is the caller's job (`AssessmentPageClient.tsx`
 * owns the fetch/mutate/state cycle, exactly like it already owns
 * `engineState`; `page.tsx` derives `canCreate`/`canDelete` server-side from
 * the membership row via `can()`, exactly like `canRespond`/`canComplete`
 * already are). This component's only job is turning those already-decided
 * values into markup and forwarding user intent (a file was picked, a
 * delete was clicked) back up as plain callback calls.
 *
 * IT REFLECTS AN AUTHORIZATION DECISION; IT NEVER MAKES ONE. `canCreate`/
 * `canDelete` gate `mode: 'presence'` (e2e/role-matrix.spec.ts's
 * EVIDENCE_CONTROLS): a control the caller says is not permitted is ABSENT
 * from the tree, not merely disabled — the same distinction
 * AssessmentPageClient.tsx's D-129 comments already make for
 * canRespond/canComplete. Hiding a control here is a usability affordance;
 * the routes this component's callbacks eventually reach
 * (POST/DELETE .../evidence, Tasks 6–7) independently re-enforce
 * `evidence:create`/`evidence:delete` server-side regardless of what this
 * component renders — a DevTools-restored button still 403s.
 *
 * HOOKLESS BY DESIGN, NOT BY ACCIDENT: this repo has no jsdom, no
 * `@testing-library/react`, no `react-test-renderer` (confirmed via
 * package.json and vitest.config.ts's `environment: 'node'`) — the
 * established technique for unit-testing a component in this codebase
 * (`__tests__/unit/report-provenance.test.tsx`) is calling it directly as a
 * plain function and walking the returned element tree, which only works
 * for a component with no hooks (calling `useState`/`useRef` outside a real
 * React render throws "Invalid hook call"). `QuestionBlock`, `StageSelector`
 * and `ReportSummary`/`ReportPdf` all follow the same shape. Because of
 * this, "open the file picker" is wired via a `<button>` calling
 * `document.getElementById(fileInputId)?.click()` rather than the more
 * conventional `useRef` — `fileInputId` is derived deterministically from
 * the `questionId` prop, so it needs no ref, and `document.getElementById`
 * is only ever invoked inside the click handler (a real, browser-only
 * event), never during render/SSR, so this is safe under server rendering.
 */

export interface EvidenceAttachItem {
  id: string;
  filename: string;
  byteSize: number;
  uploadedAt: string;
}

export interface EvidenceAttachProps {
  questionId: string;
  orgSlug: string;
  items: EvidenceAttachItem[];
  /**
   * Fix round 1: `loading` and `loadError` together give an empty-looking
   * `items` array THREE distinguishable states, not two — "still loading"
   * (`loading`), "confirmed empty" (both false) and "failed to load"
   * (`loadError`). Before this round, there was no `loading` state: the
   * module doc on `AssessmentPageClient.tsx` claimed "an empty list can
   * never be mistaken for confirmed no evidence", but between mount and
   * the fetch resolving, `items` WAS `[]` with `loadError` false — exactly
   * the mistaken-for-confirmed-empty case the comment claimed didn't
   * exist. Adding the real third state (rather than weakening the
   * comment) is what makes the original claim true.
   */
  loading: boolean;
  /** True only once the initial fetch has settled and failed — distinct
   * from a genuinely empty list AND from still-loading (see `loading`
   * above). */
  loadError: boolean;
  /**
   * Fix round 2 (Important, reviewer finding): true when a mutation for
   * THIS question succeeded but the confirmation re-fetch that follows it
   * failed. Deliberately NOT gated on `items.length === 0` the way
   * `loading`/`loadError`/the confirmed-empty message all are — those three
   * describe "we have nothing to show INSTEAD of a list"; `stale` describes
   * "we ARE showing a list, and it may not reflect what you just did". The
   * round-2 bug was exactly this: gating the confirmation-failure signal
   * behind `items.length === 0` made it invisible for every question that
   * already had evidence — the common case, since most mutations happen on
   * a question that already has at least one item. Distinct from `error`
   * below: `error` means the mutation ITSELF failed (nothing changed
   * server-side); `stale` means the mutation SUCCEEDED and only its
   * confirmation could not be obtained — conflating the two would tell the
   * user their upload/delete failed when it did not, a different and worse
   * lie (see `lib/evidence/mutateThenConfirm.ts`'s module doc).
   */
  stale: boolean;
  canCreate: boolean;
  canDelete: boolean;
  /** True while an upload or delete for THIS question is in flight. */
  busy: boolean;
  error: string | null;
  onUpload: (file: File) => void;
  onDelete: (evidenceId: string) => void;
}

/**
 * 10 MiB. Duplicated from `lib/evidence/inspect.ts#MAX_BYTES`, not
 * imported — that module's `SIGNATURES` array calls `Buffer.from(...)` at
 * MODULE SCOPE, which runs unconditionally on import (ES modules have no
 * partial evaluation). `Buffer` is a Node global with no browser
 * equivalent; this repo has no `buffer` polyfill dependency and
 * `next.config.ts` configures no Node-polyfill for client bundles
 * (verified: neither exists). Importing `inspect.ts` — even only for
 * `MAX_BYTES` — into this 'use client' file would therefore risk a
 * `ReferenceError: Buffer is not defined` the first time this component's
 * module evaluates in a browser. The duplication is pinned, not silent:
 * `__tests__/unit/evidence-attach.test.tsx` asserts this constant equals
 * the real `MAX_BYTES`, so a future change to the server limit fails a test
 * instead of silently drifting — the same "duplicate + a coupling test,
 * not normalise" idiom this branch already used for the meta.version/
 * registry-row semver drift (Task 1).
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Visually-hidden-but-focusable pattern, inlined rather than a new global
 * CSS class: keeps this task's footprint to the files it was asked to
 * touch (AssessmentPage.css is not in that list). */
const VISUALLY_HIDDEN_STYLE: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0,0,0,0)',
  whiteSpace: 'nowrap',
  border: 0,
};

/** Prevents a pathologically long filename (Task 7's own module doc: a
 * stored `Evidence.filename` is bounded by nothing in the schema) from
 * forcing horizontal overflow. `overflowWrap`/`wordBreak` only affect
 * WRAPPING, never the characters rendered — no relationship to the
 * escaping question addressed separately below. */
const FILENAME_STYLE: React.CSSProperties = {
  overflowWrap: 'anywhere',
  wordBreak: 'break-word',
  flex: '1 1 auto',
  minWidth: 0,
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function EvidenceAttach({
  questionId,
  orgSlug,
  items,
  loading,
  loadError,
  stale,
  canCreate,
  canDelete,
  busy,
  error,
  onUpload,
  onDelete,
}: EvidenceAttachProps) {
  const fileInputId = `evidence-file-${questionId}`;

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset so selecting the SAME file again still fires onChange (e.g.
    // retrying immediately after a server-side rejection) — browsers do not
    // fire `change` a second time for an unchanged file list otherwise.
    e.target.value = '';
    if (file) onUpload(file);
  }

  return (
    <div className="evidence-attach">
      <h4 style={{ fontSize: '0.8rem', fontWeight: 600, marginTop: 'var(--space-4)', marginBottom: 'var(--space-2)' }}>
        Evidence
      </h4>

      {/* Fix round 2: unconditional on `items.length` — see `stale`'s own
          prop doc for why. `role="status"` (a polite live region), not
          `role="alert"` like `error` below: this is advisory ("verify by
          reloading"), not a report that the user's own action failed —
          using `alert`'s assertive semantics here would itself overstate
          what happened. Wording is deliberately about WHAT TO DO
          (reload to see current state), not just what went wrong, and
          deliberately does NOT say "upload failed"/"delete failed" —
          the action succeeded; only its confirmation did not. */}
      {stale && (
        <p role="status" style={{ fontSize: '0.85rem', margin: '0 0 var(--space-2)', color: 'var(--color-risk-moderate)' }}>
          Your last change was saved, but this list could not be refreshed to confirm it. Reload the page to see the current state.
        </p>
      )}

      {items.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 var(--space-2)' }}>
          {items.map((item) => (
            <li
              key={item.id}
              style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', padding: 'var(--space-1) 0', flexWrap: 'wrap' }}
            >
              {/* Plain JSX text child — React escapes this by construction
                  (it becomes a text node, never parsed as markup). Never
                  dangerouslySetInnerHTML; see this file's own tests for the
                  structural proof. `title` repeats the same STRING value
                  (also escaped, as any JSX attribute value is) so a
                  visually-truncated/wrapped name still has its full text
                  available on hover. */}
              <span style={FILENAME_STYLE} title={item.filename}>{item.filename}</span>
              <span className="text-muted" style={{ fontSize: '0.8rem', flexShrink: 0 }}>
                {formatBytes(item.byteSize)}
              </span>
              {/* href is built ONLY from orgSlug (a route param) and
                  item.id (a server-issued UUID) — never from item.filename.
                  Evidence:read is granted to every role (lib/authz/
                  policy.ts), so this link is unconditional, matching the
                  report page's "Download PDF" precedent. */}
              <a
                href={`/api/v1/orgs/${orgSlug}/evidence/${item.id}`}
                className="btn btn--secondary btn--small"
                style={{ flexShrink: 0 }}
                target="_blank"
                rel="noopener noreferrer"
              >
                Download evidence
              </a>
              {canDelete && (
                <button
                  type="button"
                  className="btn btn--secondary btn--small"
                  style={{ flexShrink: 0 }}
                  disabled={busy}
                  onClick={() => onDelete(item.id)}
                >
                  Delete evidence
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {items.length === 0 && loading && (
        <p className="text-muted" style={{ fontSize: '0.85rem', margin: '0 0 var(--space-2)' }}>
          Loading evidence…
        </p>
      )}

      {items.length === 0 && !loading && !loadError && (
        <p className="text-muted" style={{ fontSize: '0.85rem', margin: '0 0 var(--space-2)' }}>
          No evidence attached yet.
        </p>
      )}

      {items.length === 0 && !loading && loadError && (
        <p className="text-muted" style={{ fontSize: '0.85rem', margin: '0 0 var(--space-2)' }}>
          Evidence could not be loaded. Reload the page to try again.
        </p>
      )}

      {error && <p className="form-error" role="alert">{error}</p>}

      {canCreate && (
        <div>
          <button
            type="button"
            className="btn btn--secondary btn--small"
            disabled={busy}
            onClick={() => document.getElementById(fileInputId)?.click()}
          >
            {busy ? 'Uploading…' : 'Attach evidence'}
          </button>
          <input
            id={fileInputId}
            type="file"
            aria-label={`Attach an evidence file for question ${questionId}`}
            /*
              C6 whole-branch review, F6. This list used to stop at `.zip`,
              which HID the OOXML family from the OS file picker even
              though spec §3.2 names it as accepted and the server already
              stores it: `inspect()` (lib/evidence/inspect.ts) matches
              `PK\x03\x04` and returns `application/zip`, and the upload
              route persists that SNIFFED type rather than the browser's
              declared one, so a `.docx` uploads and round-trips today.
              For the primary adopter -- institutional teams whose policies
              and DPIAs live in Word -- that was the format that mattered
              most, greyed out by an accept list nobody had reconciled with
              the spec.

              The OOXML entries are extensions AND their official media
              types: a browser file picker matches either, and the two
              spellings disagree about which files they surface on some
              platforms. `application/zip` stays for a plain `.zip`, which
              is separately accepted.

              What this does NOT claim: that a `.docx` is validated AS a
              Word document. It is validated as a zip container and no
              further -- the known, bounded limit recorded as D-139.
            */
            accept={[
              '.pdf', '.png', '.jpg', '.jpeg', '.zip',
              '.docx', '.xlsx', '.pptx',
              'application/pdf', 'image/png', 'image/jpeg', 'application/zip',
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            ].join(',')}
            disabled={busy}
            onChange={handleFileChange}
            style={VISUALLY_HIDDEN_STYLE}
          />
          <p className="text-muted" style={{ fontSize: '0.75rem', margin: 'var(--space-1) 0 0' }}>
            Accepted formats: PDF, PNG, JPEG, Word (.docx), Excel (.xlsx), PowerPoint (.pptx)
            and ZIP. Max size {formatBytes(MAX_UPLOAD_BYTES)}.
          </p>
        </div>
      )}
    </div>
  );
}
