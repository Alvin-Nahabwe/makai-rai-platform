import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCORING_VERSION, generateReportData, createAssessment } from '@/lib/engine/AssessmentEngine';
import { formatProvenanceLine, formatScoringLine } from '@/lib/report/provenance';

/**
 * ENG-03 prerequisite P-a: a scored assessment must record WHICH scoring
 * methodology produced it, and a reader must be able to see that.
 *
 * The framework bundle hash covers data (questionBank, scoringConfig,
 * assessmentAreas) but NOT engine code, so a change to how scores are
 * computed produces no drift and no version bump. Two assessments carrying
 * an identical framework semver and an identical content hash can therefore
 * have been scored by different methodologies, with nothing recording it —
 * and the dashboard renders trends across exactly those numbers, so a silent
 * change manufactures a fake improvement.
 *
 * The engine already stamped `version` into report data, but no surface ever
 * read it, and that constant doubles as the assessment STATE schema version,
 * so bumping it for a scoring change would misreport the state format.
 * Scoring methodology gets its own version.
 */

const PROVENANCE = {
  semver: '3.0.0',
  pinnedDate: '2026-08-06',
  contentHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
};

describe('SCORING_VERSION is a distinct, declared methodology version', () => {
  it('is exported and looks like a version', () => {
    expect(SCORING_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is not the same constant as the assessment state version', () => {
    // createAssessment().version is the STATE schema version. Conflating the
    // two means a scoring fix silently claims the state format changed, and a
    // state migration silently claims the methodology changed.
    // Both halves asserted concretely: `undefined !== '4.0.0'` would pass
    // this vacuously if SCORING_VERSION did not exist.
    expect(typeof SCORING_VERSION).toBe('string');
    expect(createAssessment().version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(SCORING_VERSION).not.toBe(createAssessment().version);
  });
});

describe('a scored report records the methodology that produced it', () => {
  it('stamps scoringVersion into generated report data', () => {
    const report = generateReportData(createAssessment());
    // Asserted against the shape, not only against the constant: comparing
    // two undefineds would pass while proving nothing.
    expect(report.scoringVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(report.scoringVersion).toBe(SCORING_VERSION);
  });
});

describe('the scoring version is shown to the reader, beside the framework provenance', () => {
  /**
   * Deliberately a SEPARATE line from formatProvenanceLine. That function's
   * copy is mandated verbatim by the Phase 1c design spec §4.2 and pinned
   * with toBe() by an O-15 obligation test; appending to it would edit a
   * spec-mandated string to solve a problem the spec never contemplated.
   * A sibling line reaches the reader identically and leaves O-15 intact.
   */
  it('names the version when the report recorded one', () => {
    const line = formatScoringLine('4.1.0');
    expect(line).toContain('4.1.0');
    expect(line).toMatch(/scoring/i);
  });

  it('says so explicitly when a report predates the recording, rather than falling silent', () => {
    // Every assessment completed before 2026-08-18 has no scoringVersion and
    // its cached report is immutable. Omitting the clause would make an
    // unrecorded methodology indistinguishable from a recorded one — the
    // exact ambiguity this prerequisite exists to remove.
    const line = formatScoringLine(undefined);
    expect(line).toMatch(/scoring/i);
    expect(line).toMatch(/unrecorded|not recorded/i);
  });

  it('leaves the framework provenance line byte-identical to what O-15 mandates', () => {
    expect(formatProvenanceLine(PROVENANCE)).toBe(
      'Assessed against MAK-AI RAI Framework 3.0.0, pinned 2026-08-06 · content a1b2c3d4…',
    );
  });
});

/**
 * Surface coverage. The line existing is not the same claim as a reader
 * seeing it — the engine already stamped a version into report data long
 * before this change, and no surface ever read it, which is precisely how
 * the identity stayed invisible.
 */
describe('both report surfaces render the scoring line', () => {
  it('is exported for the surfaces to consume', () => {
    expect(typeof formatScoringLine).toBe('function');
  });

  /**
   * A SOURCE assertion, and it is here because the component tests cannot
   * make this claim. Proven, not assumed: removing the prop from the report
   * page leaves every component test in this suite green, because those tests
   * hand ReportSummary the prop themselves. They show the component renders
   * the line WHEN GIVEN a version; only this shows the page supplies one.
   *
   * That gap is the failure class the project records as D-191 — the check
   * sits on a neighbouring surface and passes while the property is violated.
   * The honest technique available here is reading the source: there is no
   * DOM test infrastructure in this repo (jsdom is ruled in but not landed),
   * so the page cannot be rendered.
   *
   * Its limitation, stated rather than papered over: this matches text, so a
   * rename that preserves behaviour will fail it, and a wiring that passes
   * the wrong value would satisfy it. It catches deletion, which is the
   * regression that actually happened when the prop was first added.
   */
  it('the report page actually passes scoringVersion to ReportSummary', () => {
    const page = readFileSync(
      join(process.cwd(), 'app/(authenticated)/orgs/[slug]/assessment/[id]/report/page.tsx'),
      'utf8',
    );
    expect(page).toMatch(/scoringVersion=\{report\?\.scoringVersion\}/);
  });

  it('the PDF reads scoringVersion off the report data it was given', () => {
    const pdf = readFileSync(join(process.cwd(), 'lib/pdf/ReportPdf.tsx'), 'utf8');
    expect(pdf).toMatch(/formatScoringLine\(reportData\.scoringVersion\)/);
  });
});

