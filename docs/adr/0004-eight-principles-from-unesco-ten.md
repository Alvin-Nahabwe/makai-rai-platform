# ADR 0004 — The framework's eight principles, and how they relate to UNESCO's ten

**Status:** accepted (recording a decision already embodied in shipped content)
**Date:** 2026-08-31
**Context:** finding 12 of the 2026-08-18 framework content audit

## The problem this record exists to fix

`data/projectConfig.json` sets `principlesSource` to *"UNESCO Recommendation on the
Ethics of Artificial Intelligence"*, and the product presents eight principles under
that attribution. UNESCO's Recommendation states **ten**. Nothing in the product, the
README, or the code said that a mapping had happened, which two principles do not appear
as principles, where their subject matter went, or that one was renamed to something
that means a different thing.

A reader comparing the two lists finds a discrepancy and no explanation. That is the
defect. The mapping itself is defensible; presenting it as an unqualified quotation
was not.

## The mapping, as shipped

Verified against `data/scoringConfig.json` and `data/assessmentAreas.json` on
2026-08-31, not from memory.

| UNESCO principle | In this framework |
|---|---|
| Proportionality and Do No Harm | **Proportionality & Do Not Harm** — direct |
| Safety and Security | **Safety & Security** — direct |
| Fairness and Non-Discrimination | **Fairness & Non-discrimination** — direct |
| Sustainability | **Sustainability** — direct |
| Transparency and Explainability | **Transparency & Explainability** — direct |
| Awareness and Literacy | **Awareness & Literacy** — direct |
| Multi-stakeholder and Adaptive Governance and Collaboration | **Multi-stakeholder Collaboration** — direct, shortened |
| Responsibility and Accountability | **Reproducibility & Accountability** — **renamed**, see below |
| Right to Privacy, and Data Protection | **not a principle.** Its subject matter is area `PP-06 Privacy & Consent Violations`, filed under *Safety & Security* |
| Human Oversight and Determination | **not a principle.** Its subject matter is area `PO-02 Lack of Human Oversight`, filed under *Awareness & Literacy*, with control `C-24 Human-in-the-Loop Design` |

## Decision

Keep the eight, and say all of the above plainly wherever the attribution appears.

**Why eight and not ten.** The eight are *scoring* dimensions, not an ethical taxonomy.
Each must aggregate enough questions across enough areas to produce a score that means
something; a principle carried by one area produces a score that is really one area's
score wearing a principle's name. Privacy and human oversight are each covered by a
single area, so promoting them to principles would have added two thin dimensions rather
than two informative ones. That is a measurement argument, not an ethical one — and it
is exactly why the framework must not claim the eight ARE UNESCO's ten.

**Why the renaming is the sharpest part of this.** UNESCO's *Responsibility and
Accountability* is about who answers for an outcome. *Reproducibility* is about whether a
result can be obtained again. They are not the same idea, and reproducibility is not a
narrower reading of responsibility — it is a different axis that happens to support it.
The four areas filed under it (`IP-04`, `IP-06`, `PO-01`, `PO-03`) are genuinely about
reproducibility and traceability, so the *content* is coherent; the *name* claims UNESCO
lineage it does not have. Renaming the principle back to "Responsibility & Accountability"
would misdescribe the areas underneath it. Both options are wrong in different
directions, so this ADR records the choice rather than pretending it away.

## Consequences

- The two folded-in principles sit under headings that do not obviously contain them.
  Privacy under *Safety & Security* and human oversight under *Awareness & Literacy* are
  both defensible and neither is natural. A reader looking for privacy will not guess
  where to find it. This is a known cost, not an oversight.
- **A user cannot currently see any of this in the product.** Fixing that is content work
  (finding 13, the scope boundary in front matter), batched with the other content
  changes rather than shipped piecemeal — every content change costs a framework version
  bump, which invalidates pinned assessments (D-167).
- If the framework ever gains enough privacy or oversight areas to score meaningfully,
  the measurement argument above expires and they should be promoted. That is the
  concrete trigger for revisiting this.

## What this ADR does not do

It does not claim the mapping is the only defensible one, and it does not establish that
eight is better than ten. It records what was decided, on what reasoning, so that the
next person can disagree with something specific.
