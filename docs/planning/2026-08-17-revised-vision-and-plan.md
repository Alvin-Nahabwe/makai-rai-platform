# Revised vision & development plan — PROPOSAL

**Date:** 2026-08-17
**Status:** PROPOSAL for the human partner's ruling. Nothing here is decided or scheduled.
**Grounded in:** `docs/audits/2026-08-17-full-platform-audit.md` (195 findings, 46
adversarially verified) and its appendix; the collaboration-model proposal
(`docs/planning/2026-08-14-collaboration-model-proposal.md`, PR #6); the locked product
decisions (team self-improvement primary; ISO/IEC 42001 + AU Continental AI Strategy +
UNESCO EIA anchors); and the newly procured **VPS + domain**.
**Process:** brainstorming (autonomous adaptation: open choices surface as §6 decision points
rather than being resolved by assumption); Deep `what-if-oracle` on this plan's own
decomposition (§7 — this also discharges the audit's PH-7 for the collaboration fork, which
is folded into branches Δ and ∞); independent adversarial review of the decomposition before
presentation (§10).

---

## 1. The one-sentence diagnosis the plan answers

The audit's verdict: **the inner ring is excellent, the outer shell is not built** — and the
current VISION_AND_PLAN (v0.1, last updated 2026-07-19) keeps sequencing work by feature
category while week-one adopter reality (deploy, recover a password, not lose answers, trust
the score, believe the privacy page) is unowned. This plan re-sequences around **trust
moments**, then returns to the vision's payoffs.

## 2. Vision amendments proposed (the vision's five shifts stay; these are additions)

- **V1 — "Deployed and operable" becomes a first-class product property.** A system of record
  that cannot be deployed, backed up, or restored is not a system of record. Backups with a
  proven restore, migration paths, log persistence, and monitoring are product features with
  exit criteria, not ops chores. (Replaces "Hosting/deployment — deferred" in §8 of the
  vision; that line is now false: the VPS exists.)
- **V2 — An honesty surface.** The product must never promise what it cannot do. Today it
  does, four ways (privacy-page controls, forgot-password instructions, the remediation
  facade, an unmarked score its own vision calls indefensible). For a tool whose framework
  scores *others* on accountability (PO-03), unhonorable promises are self-refuting. Every
  user-visible promise gets an implementation or a retraction.
- **V3 — The credible multi-user core includes collaboration semantics.** Phase 1's exit was
  written as "two orgs, isolated data" — met. But "multi-user" without concurrency semantics
  produced the silent-clobber cluster. The core is not credible until the collaboration model
  (single-writer + visible holder + audit trail, per the 2026-08-14 proposal) is decided and
  built.
- **V4 — Scoring: the provisional marker now, the maturity re-derivation as a phase.** The
  vision already condemns the single percentage, and it is still the unmarked headline of
  dashboard, report and PDF (ENG-04); the register already records a "provisional" marker as
  shipped (it never was — ENG-05). Until D-020's maturity-level rubric is derived, every
  score surface carries the marker. The rubric work is scheduled in T5 — a phase, not a
  parking-lot line — and its completion is the event that removes the marker.
- **V5 — Content is product.** The 78 questions / 21 areas / 28 controls were audited by no
  one (audit §8.2), and the standards crosswalk — a locked, non-negotiable decision — has no
  structural trace. Content fidelity and the crosswalk get a phase, not a footnote.
- **V6 — The SPA is a live production system until formally sunset.** The primary adopter
  uses it today; it shares an unmanaged engine fork with the platform (DEP-6), and every
  platform scoring fix silently forks the two products' numbers. The cutover story (import,
  comparability, or sunset banner) becomes an explicit deliverable. (Oracle §7's 1% insight.)

## 3. Proposed phase sequence

Phases are named for the trust moment they secure. Every exit condition is **live-verified**
per the project's own C5 doctrine — which the audit itself could not apply (its §8.1 caveat)
and which these phases therefore also serve: each phase re-prices the audit findings it
touches by driving them.

### T0 — Stop the bleeding (small, no design forks, days not weeks)
Contents: dependency updates (Next 16.3.1 — DEP-2; next-auth beta.32 — DEP-1) with the two
CI jobs as the regression net, plus an `npm audit` surveillance step in CI (DEP-3, DEP-11
being the enumeration it must not regress); the ENG-01
gate-weight fix **and the ENG-03 cross-stage-mapping fix together** — both scoring
corrections in one release so the recompute/SPA-fork event of §4.2 happens **once**, with
the recompute policy stated; the provisional-score marker in UI + PDF (ENG-05, V4);
truthful forgot-password copy (AUTH-01); the report page's `/controls` → `/explore/controls`
link fix (R-01); corrections to the two register rows verified false (D-037/ENG-05 and
D-117/PT-02 — the row *text* is corrected here even though PT-02's feature ruling is D2); the
lint-probe residue fix (write probes to a gitignored path — QG-2/T-09).
Sequencing note: **D6 (SPA policy) is ruled before the scoring fixes ship** — §4.2 makes
them the same event.
Exit: gates green including the new audit step; marker visible in a live browser walk;
corrected rows cite this audit; and an **engine-level red-before-green for each scoring
fix** (e.g., perfect pre-processing answers score 100 with the gate excluded; a cross-stage
likert answer moves its target area score) — the existing gates never caught ENG-01, so
"gates green" alone is a neighbouring-surface check.

### T1-0 — Provision the box and the edge (NEW — added 2026-08-18)
**Why this phase exists:** T1 as originally written repairs a deployment that has no server to
run on. The Hetzner VPS and the Cloudflare-managed domain are **purchased but not configured**,
and `docs/runbooks/deployment.md` opens at `ssh root@YOUR_SERVER_IP` (:29) — it covers five of
roughly fourteen steps a bare box needs, and two of those five are wrong in ways that matter.
Mixing provisioning with repair also makes every failure ambiguous, which is why this is a
separate phase rather than more T1 content.

**Stage A — decide before touching anything (the human partner's, not an implementer's).**
- **A1 is the one that can hurt outside this project:** confirm whether `rai.air.ug` sits under
  an existing institutional `air.ug` zone. Cloudflare's standard onboarding moves nameservers
  for the **whole apex zone**. If `air.ug` carries an institution's mail or other hosts, that
  is blast radius requiring the zone owner's consent, or a partial/CNAME setup instead. Nothing
  else starts until this is answered.
- A2: the Cloudflare posture is **RULED (2026-08-17): proxied, Full (strict)** — see §6.2.
  Record it as an ADR; it is also the input D-199 has been blocked on since 2026-08-02, whose
  stated blocker is verbatim *"cannot be written without knowing whether this app sits behind a
  real reverse proxy, and if so which one."*
- A3: origin certificate mechanism (**Cloudflare Origin CA**, per the posture ruling) and
  backup target (**Hetzner Storage Box + Borg**, recommended: off-box, client-side encrypted,
  which is what makes D-142 — dumps now contain user-uploaded evidence — survivable).

**Stage B — one-time host provisioning.** Ubuntu **24.04** LTS, not the runbook's 22.04 (whose
standard support ends inside this plan's lifetime). SSH key injected at server creation, never
a root password. **A Hetzner Cloud Firewall attached at creation** — this is the load-bearing
correction: `ufw` (runbook §1.3) **does not govern Docker-published ports at all**, because
Docker writes nat/FORWARD rules and packets never reach the INPUT chain where ufw lives. The
prod compose publishes 80/443 exactly that way, so today's firewall step is close to
decorative. Then: deploy user with key-only sudo, `PermitRootLogin no`, `PasswordAuthentication
no` (verified from a second session before closing the first), `unattended-upgrades`, NTP
**sync verified** (the runbook sets a timezone and never checks sync), a 2–4 GB swapfile (a
Next.js build alongside Postgres on 8 GB is the classic OOM, and the OOM killer's favourite
victim is the database), Docker from the pinned apt repository rather than `curl | sh`, and
**`/etc/docker/daemon.json` log rotation written BEFORE any container exists** (log-opts apply
only to containers created afterwards, so DEP-07's fix gets retroactively harder otherwise).
Directory layout `/srv/makrai{,/backups}` — and purge the developer laptop path
(`/home/alvin/Downloads/MAK_RAI/...`) from all three runbooks **and** the backup script, where
it is load-bearing rather than cosmetic: `backup-restore.md:53` sources `.env` from it.
`fail2ban` for sshd, the one port not behind Cloudflare under either posture.

**Stage C — DNS and TLS, in this order; the ordering is the point.** Add the zone and move
nameservers; A record **DNS-only first**, no AAAA (nginx listens on IPv4 only, so an AAAA
record yields 522s under proxied mode — open a register row so IPv6 is a scheduled decision,
not a silent drop); issue the Origin CA certificate; apply the nginx changes below; **run T1's
repair work and verify over TLS directly against the origin while still DNS-only** — real
login, real invitation email, real evidence upload, so every failure is attributable to your
own configuration; **only then flip to proxied.**

**The security correction that must land with the flip, not after it.** Cloudflare does *not*
fix the client-IP spoof — it adds a second appending hop and makes the spoof look fixed:
Cloudflare **appends** to a client-supplied `X-Forwarded-For`, nginx appends again
(`$proxy_add_x_forwarded_for`), and `proxy.ts:68` reads element **[0]** — so the attacker's
value survives both hops unchanged. Three changes are inseparable: nginx must **overwrite**
(`proxy_set_header X-Forwarded-For $remote_addr`) with `real_ip_header CF-Connecting-IP` and
`set_real_ip_from` the Cloudflare ranges; the app must read one header rather than a preference
chain; and **the origin must be firewalled to Cloudflare's ranges in the same change** —
trusting `CF-Connecting-IP` while the origin answers the whole internet is *strictly worse than
today*, because anyone who learns the IP can forge it. Note the standing maintenance cost: if
`set_real_ip_from` goes stale, every rate limit silently collapses into one shared bucket —
the same invisible degradation DEP-04 already describes.

Also in this stage, each verified against vendor documentation: **the runbook's certbot path
breaks under proxied mode** (HTTP-01 arrives at origin port 80, which nginx unconditionally
301s, and the https leg needs a cert that does not yet exist — Origin CA removes certbot, the
renewal cron, and the nightly nginx stop entirely); **Flexible mode is never an option here**
(plaintext origin leg carrying `__Secure-` session cookies and evidence, plus a redirect loop
with this exact nginx config); **Bot Fight Mode stays OFF** (it challenges API-shaped traffic
and on the Free plan cannot be skipped by any rule — the assessment client's autosave is a JSON
fetch loop); **no "Cache Everything" rule on this hostname** (defaults are safe — Cloudflare
does not cache HTML/JSON and `Set-Cookie` bypasses cache — but a future rule would serve one
user's dashboard to another); a `default_server` block returning 444 plus building the
invitation URL from `NEXTAUTH_URL`, closing a **newly found defect** (§11.3); drop `preload`
from the two-year HSTS header on a hostname whose TLS has never been served; drop the
unconditional `Connection: upgrade` (a protocol violation that breaks Cloudflare's origin
keep-alive); and raise `client_max_body_size` to 11m so the app's own 413 owns the boundary
rather than nginx killing a legal maximum-size upload on multipart overhead.

**Stage D — backups that satisfy T1's restore drill.** Off-box Storage Box + Borg, and the
drill must include `pg_dumpall --globals-only` (a single-database `pg_dump` excludes cluster
roles, so a fresh-host restore has no `makrai_app` — the role the entire RLS design runs on)
and `ON_ERROR_STOP=1` (the runbook's `gunzip | psql` currently "completes" past every failed
GRANT and POLICY). The drill runs on a *different* machine or it proves nothing.

Exit: a bare server became a serving host by following a runbook that was **rewritten from the
execution**, the origin is reachable only through Cloudflare, and a restore drill has run on a
separate machine.

### T1 — Deployable truth (the VPS phase)
Contents: the confirmed deploy-DOA chain end to end — compose env plumbing (audit C-1/C-2 =
DEP-01, DEP-02, CFG-01, DOC-13), `AUTH_TRUST_HOST` in prod config (C-3 = DEP-03), a working
migration/seed/provisioning path in the shipped image (C-4 = DEP-05, DEP-06), `proxy.ts`
secure-cookie fix so rate limits key by user behind TLS (DEP-04), log persistence (DEP-07),
backup with failure alerting **and an executed restore drill** (DEP-08, DOC-03), Resend
domain verification + email path (DEP-09), nginx hygiene (DEP-13), and the runbooks
rewritten **by executing them** on the actual VPS (DEP-10, DOC-02).
*Citation note: two audit dimensions share the `DEP-` prefix — deployment-ops uses
zero-padded `DEP-01..15`, dependency-platform uses `DEP-1..11`. Padding is significant; the
appendix disambiguates by dimension heading.*
Exit: the platform serves real logins on the procured domain; a restore drill has actually
run; **an invitation email was received at a real external mailbox** (this is the value T3's
D-048 reasoning reads — it needs a named writer here); the deployment runbook was produced
by the deployment, not before it; and **D-018 gets its disposition** (the hosting gate this
exit discharges), with its 26-row gated queue re-triaged rather than left orphaned. This
exit is also the audit's own completion condition for its largest caveat (§8.1).

### T1b — Public-exposure hardening (before any user outside the pilot team)
T1 puts open self-service registration on a public domain. The pre-auth abuse cluster the
triage ranked ahead of the silent-loss work (its §4.3 — including one **irreversible** harm)
must land between go-live and exposure: registration rate limiting that keys on something an
attacker does not control (D-199/D-124 — **paired in one commit with the e2e fixture's
synthetic per-seat `x-forwarded-for`**, the second armed trap on record, or the suite
detonates); the slug-squatting / unbounded-tenant-minting pair (D-201's irreversible squat,
AUTHZ-11, with D-107's product rule decided); lockout mechanics that cannot be evaded by
concurrency or weaponized cheaply (AUTH-03, AUTH-04); D-200 and D-125 from the same gated
queue; and the single-instance rate-limit assumption recorded as a conscious constraint of
the one-VPS topology (AUTH-07). Registration posture until T3 is D9.
Exit: the abuse paths have red-before-green tests; the classroom NAT population can log in
under the production cookie/rate-limit configuration (the DEP-04 fix proven live, not just
merged).

### T2 — The assessment doesn't lose work
Contents: the silent-loss cluster as one designed change, not eleven patches — autoSave
surfacing server refusals with a save-state indicator (AC-04, FV-1, PT-03); completion
handlers that cancel pending saves and honor failure (AC-07); a `version`/`updatedAt`
precondition on `respondToAssessment` and `completeAssessment` with server-side `FOR UPDATE`
or status-predicated writes (AC-05, TEN-02, D-104/D-130); the evidence-upload TOCTOU closed
the way its delete twin already is (EV-1); D-185's guard + the committed regression probe
(rebuilding what was destroyed, per D-185's recipe); pending-save handling on unmount and a
beforeunload guard that tests the right predicate (AC-08); D-145's shared fetch helper;
**server-side engineState validation** — the write path this phase adds preconditions to
also stops persisting arbitrary client JSON that bricks completion (ENG-02); jsdom +
@testing-library landed (the 2026-08-12 ruling — PH-3, T-06), **with the production
classifier `useFindingsData.ts` brought under test and the replica-asserting engine suite
retired against it (T-01)** — the exact infrastructure this ruling lands is what makes that
fixable; and the e2e journey un-fixmed via the production-build measurement the triage
prescribed (T-02 — the core journey's only assertive end-to-end test, quarantined today).
**Design constraint from the Oracle (§4.1): the conflict mechanism built here is the
substrate of T4's lock — conflict detection now, exclusivity later — so T4 extends rather
than replaces it.**
Also here (prerequisite, one commit, paired): the schema-drift trio D-109/D-163/D-154 —
`migrate dev` must work before any later phase carries a migration, and fixing it arms
D-163's DROP, so the pair lands together exactly as the triage's "armed traps" rule requires.
Exit: **the loss-scenario list is generated, not written** — enumerated mechanically from
the audit appendix's assessment-client and framework-versioning findings plus the register's
client rows (D-185/D-130/D-104/D-145/D-170/D-198), each with a red-before-green test; the
e2e journey runs assertively in CI; two concurrent editors produce a visible conflict, not
silent loss.

### T3 — Honest promises (the product side of V2)
Contents: a minimal account-settings surface — consent withdrawal (requires the missing
writer + a `ConsentRecord` append), data export, account deletion, voluntary password change
(PT-01); self-service password reset via the now-proven Resend path (PT-04/D-048 — pulled
forward from Phase 2 by V2; decision point D3); the remediation ruling implemented (build the
writer or shelve the surface — decision point D2); privacy/terms rewritten to match reality,
jurisdiction named (PT-07); README + a real cold-start doc (DOC-01, CFG-02); email
verification at registration (PT-13) if D3 rules it in.
Exit: matches V2's actual property, not a narrower one — **the promise inventory is
generated** (public pages, in-app copy and refusal messages, PDF output, API error text),
and every entry is implemented or retracted, verified live. Known members beyond the public
pages, so they cannot slip the exit: AUTHZ-8 ("delete the organization" — an operation that
does not exist), R-08 (the PDF exporting a "0/3 Stages Assessed" document the HTML refuses
to show), ENG-08 (weight modifiers reported as active that do nothing), and R-06 — the
export this phase gives a button to **currently claims completeness falsely**; wiring the
button without fixing the claim would green a narrower exit while violating V2.

### T4 — Collaboration & audit trail (the ruled restructure; blocked on D1)
Contents: per the 2026-08-14 proposal — roles restructured to per-project grants, the
single-writer lock with a **visible holder** and a ruled takeover path, and the tenant-scoped
audit trail (D-105) that single-writer converts from compliance item to functional
dependency. Also the orphaned-authority repairs that belong to the same model: last-owner
counting joins user activity (AUTHZ-1), a role-change/demotion path (AUTHZ-2), invitation
lifecycle states wired or dropped (AUTHZ-5/9); and the **assessment-deletion design defect**
the immutability promise leans on — an unlogged whole-project cascade with no
assessment-level delete and no visibility — repaired here where the audit trail can log it
(EV-2, TEN-07).
Prerequisites: the two open questions (D1) answered; T2's conflict substrate in place;
`migrate dev` working (T2). Design work re-runs `what-if-oracle` on the concrete schema when
it exists — §7 covers the plan-level fork, not the migration's mechanics.
Exit: two teammates negotiating an assessment see the holder, cannot silently clobber, and
can reconstruct who did what from the trail — live.

### T5 — Framework lifecycle & content truth
Contents: version publishing as a designed operation (tooling + runbook — FV-3); a policy for
in-progress assessments across versions (retain pinned content, or a ruled
migration-on-publish — FV-2); the content audit against sources (D-032; audit §8.2); **the
D-020 maturity-rubric derivation** — the scheduled phase V4 promises, done with the content
work it depends on (its output decides when the provisional marker comes off); the
standards crosswalk as versioned data (FV-6, V5); analytics-layer verification — the
dashboard/compare/trend surfaces nobody audited, against the engine as fixed in T0/T2
(ENG-01/03/02) (audit §8.3).
Exit: a content change ships without stranding anyone; crosswalk visible in output; content
fidelity documented.

### Payoffs (unchanged in spirit, re-anchored): artifact generation (model card vs datasheet
— D5), remediation loop maturation, API/CLI, benchmarking. Gated on real-usage signal from
the pilot (§4.3), not on T5 completing — payoff design work may begin in parallel once T3
exits (the Φ hedge, §7).

## 4. Cross-phase design constraints (from the Oracle — these are the plan's load-bearing bolts)

1. **T2 builds T4's substrate.** The version-precondition conflict mechanism is designed as a
   lease primitive (`version` + holder + expiry when T4 adds it). If T2 ignores T4, T4 rips
   T2 out — the ∞ branch's principal waste path.
2. **ENG-01's recompute policy must be stated in T0, not discovered later.** Engine *code* is
   outside the pinned-content hash (R-13), so the fix triggers no drift 409 — which is
   precisely why it silently changes what any in-progress assessment will score. Policy
   proposed: completed assessments keep their cached, immutable `reportData` (already the
   design); in-progress assessments re-score on next save, disclosed by the provisional
   marker; the fix and marker land in the same release. The same event **forks the SPA's
   numbers** (it shares the bug) — see D6.
3. **Content freeze until T5.** Any byte change to `data/*.json` before publish tooling
   exists bricks assessment creation platform-wide (D-147) and strands in-progress work
   (FV-2). The content audit (D-032) may *read* early but may not *write* before T5.
4. **The audit's 195 findings do not enter the register as 195 rows.** The register is
   already straining (PH-5); doubling it would break it. Proposed triage rule: the 40
   post-verification Critical/High findings map into the phase contents above; Medium/Low
   findings live in the committed appendix as the citable record, and only those consciously
   *deferred out of all phases* get rows. (Decision point D4 covers the register's medium.)
   **The mapping is generated, not written.** The property: *every finding the appendix
   lists at post-verification Critical or High is cited in a phase's contents.* It is
   checked by **`scripts/audit-coverage-diff.sh`**, which reads the two committed documents
   and needs nothing outside the repo. Current state: **OK — all 40 cited.** This mechanism
   has already earned its place twice: the adversarial reviewer's hand-run diff caught four
   Highs this document had silently dropped (ENG-02, ENG-03, EV-2, T-01), and the scripted
   run then caught eleven more that were present only as shorthand (`DEP-1/2/3/11`), as the
   audit's C-numbering, or as prose — invisible to any checker and to grep. Proven
   non-vacuous by removing ENG-02 from the plan and watching it fail naming exactly ENG-02.
   Re-run it after any edit to §3. (It also surfaced a live citation hazard: **two
   dimensions share the `DEP-` prefix** — deployment-ops `DEP-01..15` zero-padded,
   dependency-platform `DEP-1..11` unpadded.)

## 5. Process interventions (parallel to any phase, cheap)

- **P1 — Register mechanics:** add `KNOWN_KINDS` and reconcile the status vocabulary
  (register-integrity test ↔ header); every future sweep enumerates row IDs from the file
  and diffs, never filters by one label (PH-2/PH-6 — the triage doc already proved this
  method); fix the three rows D-052 claims closed.
- **P2 — Dependency surveillance:** the CI `npm audit` step from T0, plus a monthly review
  trigger recorded once in the register (DEP-3).
- **P3 — Docs truth:** ADR amendment batch (DOC-04..07: status lines, dead paths, the
  404-vs-403 wording, the never-built memoisation); supersession banners on the legacy audit
  docs (DOC-08); a `docs/README.md` index naming the current plan of record (DOC-09); this
  document and the audit added to it; and the **end-to-end reads the audit never did**
  (audit §8.7): the ~5 large spec/plan documents, and the register in full — both methods
  had proven yield inside the audit itself.
- **P4 — The audit's own orphans**, attached where each file is actually opened (not
  blanket-assigned): `proxy.ts` in full and `security-logger` internals → **T1** (DEP-04 and
  DEP-07 open both); invitation-token redemption → **T1b/T4** (rate-limit pairing and
  invitation lifecycle open it); `scrubUserOnDeactivation` → **T3** (account deletion opens
  it); the injection/output-encoding pass as a class (R-02's class) → its own small task in
  T3, since it cuts across files no single phase opens.
- **P6 — Commit and PR hygiene (NEW 2026-08-18).** The convention lives in
  `docs/COMMIT_CONVENTION.md`; adoption is **forward-only** because published history cannot be
  rewritten (`main`'s protection blocked force-pushes, and 37+ commit SHAs are cited in tracked
  documents and would dangle). The measured problem: from 2026-08-01 the repository's commit
  messages became long-form essays — median 29-line bodies, 98% of subjects over 50 characters,
  24% carrying first-person session narrative — while only **22%** cite the file:line or command
  evidence that AGENTS.md §5 already requires. Three published commits cite evidence paths under
  the gitignored `.superpowers/` workspace that no longer exist (`2adf381`, `3114fb7`,
  `603f6e1`) — the permanent cost of the same local/remote confusion, already ruled for code
  comments as D-207 and continued in messages. **The binding gap is doctrinal, not
  presentational: AGENTS.md has six checkpoints and none of them fires at `git commit`** — which
  is precisely the failure §0 names, *"an obligation that names no observable trigger will not
  fire."* Hence C7 (§5.1 below), not merely a style document.
- **P7 — Repo/remote hygiene follow-through (NEW 2026-08-18).** The items R1–R3 do not cover:
  supersession banners on the six dead legacy audit documents; the register's own public-facing
  problem (if the repo goes public again, its 84 open RISK/BUG rows need curating, and the
  runbook's production fingerprint needs placeholders); `public/robots.txt` still advertising
  the *old* SPA's sitemap, so the platform would point search engines at its predecessor;
  `SECURITY.md` absent from a governance product; and `package.json` carrying no description,
  licence, or repository field.
- **P5 — The register re-target sweep the T-naming makes mandatory.** ~139 open rows carry
  targets in the old phase vocabulary; C6's "no open row targeted at this phase" check greps
  for names that will no longer exist and would green vacuously at every T-exit. Before the
  first T-phase exits: write the dual-target rule the triage's §5 already demanded (six rows
  read "1d or 2" — retiring "1d" leaves them ruleless), then re-target by enumerating row
  IDs from the file and diffing (the P1 method), never by label filter. Includes the three
  rows D-052 falsely claims closed (PH-2) and D-018's queue disposition from T1's exit.

### 5.1 One new checkpoint, and why prose would not do

The commit convention (P6) needs a trigger or it will not fire — the project's own measured law.
Proposed as **C7 — before committing**, to be added to AGENTS.md §1 in the same commit that
adopts the convention (the SKILLS_INVENTORY rule that an entry naming no checkpoint is
decorative applies to rules too):

> **C7 — Before committing.** Read the message you are about to write as someone who was not
> here: does it describe *the change*, or *the doing of the change*? Every identifier is
> qualified on first use; every load-bearing claim cites a file:line or a command; no path
> under a gitignored directory is cited. Session narrative goes to the register or the SDD
> workspace, not into permanent history.

A lint check can catch the banned tokens; it cannot catch the semantic half — which is exactly
the D-191 reasoning that made trigger-enumeration a *reading* obligation rather than another
grep. C7 is the reading obligation; the token check is the mechanism. Both, or neither works.

## 6. Decision points — rulings needed from the human partner

- **D1 (blocks T4):** the two collaboration questions, unchanged from PR #6: does the lock
  cover reviewing as well as filling; and what happens when the holder disappears (timeout /
  explicit release / owner-admin takeover). **Rule this with a void visible: "reviewing" is
  not yet a capability.** The reviewer role today confers nothing beyond viewer (AUTHZ-7),
  and the review/sign-off workflow (D-002, gated on D-001 credibility tiers) is scheduled
  nowhere — so granting per-project "reviewer" in T4 without deciding what it confers would
  re-create the declared-but-never-wired class one level down. My recommendation: one lock
  covering filling and any future annotating (same scoring graph), holder visible to all
  members, owner/admin takeover recorded in the audit trail — and T4 grants the reviewer
  role **only alongside a minimal reviewing capability or an explicit ruling that the grant
  is dormant until D-002**, stated in the UI at the point of grant.
- **D2 (blocks part of T3):** remediation — build the writer (generate items from report
  gap/attention tiers at completion) or shelve the surface until the payoff phase. My
  recommendation: build the minimal writer; the reading surface already exists and tested,
  and a working loop is the vision's shift 5 at low marginal cost. Shelving is defensible if
  T3 must stay small.
- **D3 (scopes T3):** password reset and email verification now (T3) vs Phase-2-as-registered
  (D-048's current target). My recommendation: now — V2 makes recovery a trust minimum, and
  the blocker recorded in D-048 (no proven email path) dissolves in T1.
- **D4 (scopes P1):** register medium — keep the single file with mechanized sweeps (cheap,
  proposed above) vs restructure to a row-per-file directory with a generated index
  (structural fix for PH-5's corruption class, but a migration of 210 rows). My
  recommendation: mechanized sweeps now; restructure only if corruption recurs after P1.
- **D5 (payoffs):** first artifact — model card vs datasheet. Unchanged, ruled when payoffs
  schedule.
- **D6 (policy, cheap to state, expensive to ignore):** the live SPA — patch its ENG-01 twin
  and pin the fork to sync, or freeze it with a sunset/comparability banner pointing at the
  platform. My recommendation: the banner; maintaining two scoring brains is the failure
  mode DEP-6 warns about, and the SPA's anonymity means no user is stranded by a freeze.
- **D7 (sequencing hedge, §7 Φ):** whether the pilot (own team as user zero) starts at
  T2-exit as proposed, or waits for T3. My recommendation: T2-exit — the pilot's feedback is
  the only force that can legitimately reorder T3–T5, and the pilot team is the one
  population that can consent to the not-yet-honest promises knowingly.
- **D8 (T1 detail):** deploy mechanics on the VPS — repair the compose/runbook path as
  written (minimal change, audit-verified fix list) vs move to CI-driven deploys (build in
  Actions, push image, SSH deploy step). My recommendation: repair first, CI-driven as a
  later P-item; T1's exit is a working deployment, not deployment automation.
- **D9 (scopes T1/T1b — the window the plan otherwise leaves open):** registration posture
  between go-live and T3's honest promises: open self-service (status quo), invite-gated,
  or allowlisted domains. Until T3, every registration collects consent against promises
  the product cannot honor (PT-01) with no email verification (PT-13). My recommendation:
  invite-gated until T3 exits — it costs the pilot nothing (invitations work) and closes
  both the consent exposure and most of the pre-auth abuse surface while T1b lands.
- **D10 (positioning, cheap to rule):** i18n (PT-08 — Francophone institutions are named
  adopters, zero provision exists) and low-bandwidth/offline resilience (PT-09 — a property
  the SPA implicitly had and the platform dropped without a decision). Neither is scheduled
  here; the ruling needed is *whether they enter the payoff phases or are consciously
  parked with a register row each*. Note the D6 interaction: freezing the SPA removes the
  offline-capable, account-free artifact that implicitly served PT-09's population — the
  banner recommendation makes an undecided drop harder to reverse, which is why this
  D-point exists now rather than later.

### 6.1 RULING — 2026-08-17

**The human partner ruled: proceed with the recommendation on every point, D1 through D10.**
Recorded here rather than left in conversation. What that settles, in plain terms:

| # | Ruled |
|---|---|
| D1 | One lock covering filling and any future annotating; holder visible to all members; owner/admin takeover, recorded in the audit trail. The per-project **reviewer grant does not ship dormant** — T4 either carries a minimal reviewing capability or states at the point of grant that it confers nothing until D-002. |
| D2 | **Build** the remediation writer (generate items from report gap/attention tiers at completion). The vision's shift 5 stops being a facade. |
| D3 | Password reset **and** email verification move into T3 — not Phase 2. D-048's re-target premise dissolves when T1 proves the email path. |
| D4 | Register stays one file with **mechanized** sweeps (P1/P5); restructure only if corruption recurs. |
| D5 | Deferred with the payoff phases (unchanged — it was never urgent). |
| D6 | The live SPA gets a **sunset/comparability banner**, not a parallel patch. One scoring brain. Note this now interacts with D10 — see the caveat below. |
| D7 | Pilot starts at **T2 exit**, with our own team as user zero — the one population that can consent knowingly to promises not yet honest. |
| D8 | **Repair first**, automate later. T1's exit is a working deployment, not a deployment pipeline. *(Scope grew after this ruling — see §11.)* |
| D9 | Registration is **invite-gated** until T3 exits. |
| D10 | i18n and low-bandwidth/offline **enter the payoff phases** rather than being parked — each gets a register row naming it as scheduled work, not a silent drop. |

### 6.2 SECOND RULING — 2026-08-18 (repo posture, licence, edge)

Three further decisions, raised after the human partner asked why agent-process files were
being published. The first two were not in the D-list at all; the investigation that answered
the question found them.

| # | Ruled | Consequence |
|---|---|---|
| **R1 — repository visibility** | **Private, now.** Revisit deliberately once the open-RISK count is down and a front door exists. | Done 2026-08-18. The repo was public while `docs/DEFERRED_REGISTER.md` enumerated **68 open RISK and 16 open BUG rows** naming exactly which controls are missing, alongside a named production target (`rai.air.ug`, Hetzner CX32, Ubuntu 22.04, sudo account) and a working dev credential for the RLS role in `.env.example:29`. Traffic showed **173 clones from 74 unique cloners against 1 unique human viewer** — automated scraping. **This does not un-publish anything already taken; nothing can.** The mitigating fact is timing: `rai.air.ug` does not resolve yet, so it was a roadmap to a system that did not exist. That stops being true at T1-0 Stage C. |
| **R2 — licence** | **Apache-2.0.** | `LICENSE` added 2026-08-18, byte-identical to the canonical text apart from the copyright line. Without it the default was *all rights reserved*: no institution could legally adopt, fork, or evaluate the toolkit — which contradicted the entire adopter model. **Open item: the copyright line reads "Alvin Nahabwe" because that is the only attribution verifiable from the repository. If the work belongs to Makerere University or another institution, that line must change before the repo is shared.** |
| **R3 — Cloudflare posture** | **Proxied, Full (strict)**, with the origin firewalled to Cloudflare ranges **in the same change**. | Detailed in T1-0. Two costs recorded rather than absorbed: **Cloudflare terminates TLS and therefore sees every request in plaintext — institutional self-assessments and uploaded evidence included.** That belongs in an ADR and on the privacy page rewritten in T3. And the Cloudflare IP list becomes a maintained dependency with a silent failure mode. |

**A regression R1 caused, recorded rather than discovered later.** Making the repository private
on this account **disabled branch protection and rulesets** — both now return HTTP 403,
*"Upgrade to GitHub Pro or make this repository public to enable this feature."* That silently
undoes **D-193**, the ruling that gated `main` behind both CI checks with `enforce_admins`.
GitHub Actions still runs (verified: Actions enabled, workflow runs listing normally), so CI
still *reports* on every PR — it is no longer *enforced* as a merge gate. Three ways out, none
urgent: accept it (single-contributor repo, the gate becomes self-discipline), GitHub Pro
restores it, or it returns automatically when the repo goes public again. Recorded here so the
next phase exit does not read a green D-193 that is no longer true.

**One caveat the first ruling creates, flagged rather than silently absorbed:** D6 (freeze the SPA)
and D10 (low-bandwidth is real, scheduled work) now point in opposite directions for the same
users. The SPA is today the only offline-capable, account-free way to take an assessment on a
bad connection. Freezing it removes that before its replacement exists. The banner should
therefore **not** be posted until the platform's low-bandwidth story is at least specified —
otherwise the ruling on D10 is undone by the execution of D6. This is a sequencing
constraint, not a re-opening of either decision.

## 7. Deep Oracle — "what if this plan ships exactly as specified?"

*(Also discharges the plan-level oracle obligation on the collaboration fork (PH-7); the
concrete T4 schema gets its own run when it exists.)*

**Ω Best (15%, HIGH confidence in shape):** T0 in days; T1 finds and fixes a handful of *new*
defects live (that is success — the audit predicted its static findings would re-price under
execution); pilot starts at T2-exit; D1 answered early; payoffs begin design by T5.
Trigger: T1 completes with runbooks rewritten from execution. What most miss: Ω does not mean
"no new findings"; it means new findings arrive while the phase built to absorb them is open.

**α Likely (40%):** T0 fast; **T1 stretches on external latencies** (DNS, TLS, Resend domain
verification, provider quirks — human-time waits, not engineering); T2 lands parallel to
T1's waits; T3 partially lands (account settings is real product work); T4 waits on D1.
Required response, built into the plan: T1 and T2 are deliberately independent (deploy vs
client/server code) so neither blocks the other.

**Δ Worst (20%):** two failures co-occur. (1) A content edit sneaks in before T5 — D-147
bricks assessment creation platform-wide and FV-2 strands in-progress work; (2) T4's
migration detonates the schema-drift trio (D-109/D-163/D-154) because it ran before the trio
was fixed, or T4 discards T2's concurrency work because T2 was designed without it. Floor:
weeks of rework and a register that stops being trusted. The plan's §4.1, §4.3 and T2's
trio-pairing exist precisely to price this branch down; the tripwires below are its early
signals.

**Ψ Wild card (10%):** a real external team arrives before T3 — the AU-strategy alignment
makes early demos politically attractive — and consent is being collected against promises
the product cannot honor, with lockout-and-no-recovery live, in exactly the community the
tool serves. Second wild card: a data-protection query (Uganda DPPA-shaped) arrives through
the university, and the honest answer today is "the page overpromises." Required response:
T0's honesty minimum (marker, recovery copy) plus T3's privacy rewrite ordered ahead of any
external demo; D7's pilot population is the knowing-consent hedge.

**Φ Contrarian (10%):** truth-first is the wrong order — adopters come for artifacts (the
vision's own primary-adopter logic), and a quarter spent on trust infrastructure reaches
"trustworthy with zero users." The plan absorbs the true part without accepting the
conclusion: a pilot on a lossy, undeployable tool spends the scarcest asset (institutional
trust) to learn less; so the hedge is D7's early pilot with the one team that can knowingly
consent, plus payoff design unblocked at T3-exit rather than T5 (§3). Golden-ratio split:
~62% truth track, ~38% pilot-and-payoff track once T2 exits.

**∞ Second order (5% probability, high attention):** (1) surfacing hidden failures (AC-04)
makes drift 409s *visible* → users hit FV-2's stranding sooner → T5's publish tooling gets
pulled forward the day content must change — the content freeze (§4.3) is what keeps that
day inside T5; (2) T2's lock substrate shapes T4 (§4.1); (3) restructuring the register
after opening the audit's follow-up rows would migrate them twice — hence §4.4's triage rule
precedes any row-opening; (4) fixing scoring forks the SPA (§4.2 → D6); (5) D6's SPA freeze
removes the offline, account-free artifact that implicitly served the low-bandwidth
population — an undecided drop (PT-09) becomes harder to reverse the moment the banner goes
up, which is what D10 exists to catch.

**Robust actions (pay in ≥3 branches):** the T2 trio-pairing; the §4 constraints as written;
D7's early pilot; T0's honesty minimum; T1/T2 independence.
**Tripwires:** T1 > 2 weeks of elapsed external waiting → start T2 immediately (if not
already); any external user before T3 → T3's privacy/recovery items jump the queue; any
request to edit `data/*.json` before T5 → stop, it is the Δ branch knocking; D1 answered →
schedule T4 design with its own oracle.
**The 1% insight:** the platform and the SPA are **two live products sharing one scoring
brain**, and every scoring fix forks them. Nobody tracks the SPA as production anymore —
but users do. D6 is a ten-minute ruling that closes the longest-fuse risk in the plan.

## 8. Execute-the-claims register (per AGENTS.md §2 hand-over rule)

Claims this plan makes about behaviour, and their standing:
**Run/verified during the audit:** the deploy-DOA chain (compose config reproduced;
trustHost traced in installed `@auth/core`; CI's own UntrustedHost repro at ci.yml:262-282);
ENG-01 (engine executed: Transparency = 31/100 at perfect answers); `prisma migrate diff`
proposing the dedup DROP; beta.32/16.3.1 advisory fixes (npm audit + publish dates);
production build issues one assessment GET per mount (AC-01 verification).
**Assumptions the implementer must check, not inherit:** VPS provider specifics (unknown to
the repo — D8); Resend domain verification timeline (external); that `next start` vs
standalone `node server.js` behaves equivalently for T1's first boot (CFG-07 says it may
not — treat as a T1 checklist item); that no Next 16.3.x API change touches `proxy.ts`
(release notes unread — T0 checks); D-048's row text after T1 changes its blocker premise.

## 9. What this plan deliberately does not do

It does not re-litigate locked decisions (adopter, standards anchors). It does not schedule
benchmarking/API/CLI (payoffs remain signal-gated). It does not decide the ten D-points
(D1–D10) — they are the human partner's. It does not open register rows (per §4.4, that
follows the ruling on this document). And it does not claim the audit's findings are
exhaustive — the audit's own §8 boundary (nothing executed live; content unaudited) is
inherited here, and T1/T5 are, among other things, the instruments that close it.

## 10. Adversarial review of this decomposition

An independent adversarial pass on this document's decomposition ran before presentation
(per the §2 trigger; self-review is 0-for-9 on this class in this project after this run).
**Verdict on the draft: BLOCK — 12 findings, 0 manufactured.** The three Criticals: four
confirmed Highs (ENG-02, ENG-03, EV-2, T-01) had no home while §4.4 claimed complete
mapping — caught by the mechanical ID diff this document now mandates; the pre-auth abuse
cluster (with D-201's irreversible harm) was absent while T1 makes the platform public —
now phase T1b + D9; and D1 asked for a ruling on a "reviewing" lock while no reviewing
capability exists or was scheduled — D1 now states the void. The remaining findings
(D-020's promised phase missing → T5; the register re-target sweep → P5; T3's exit narrower
than V2's property → rewritten with known members named; T1→T3 read/write pairing on the
email path → T1 exit line; T0/T2 exits' D-191-shaped gaps → engine-level red-green and a
generated loss-scenario list; P4's misattached orphans → re-homed; a six-vs-eight D-point
count defect → recounted; i18n/low-bandwidth undecided-drop interaction with D6 → D10 and
∞-branch 5) were each absorbed at the cited section. The reviewer confirmed clean: all five
Criticals homed, the D-109/D-163 pairing, the T2↔T4 seam, T1/T2 independence, the §8
verified/assumption split, and the audit-§8 gap homes.

## 11. Defects found AFTER the audit closed (2026-08-18)

The audit's §8 listed what it could not reach. Investigating the human partner's three
questions walked into four of those gaps and found real defects there. They are recorded here
rather than appended to the audit, because the audit is a closed artifact with a stated
boundary and editing it would erase the fact that these came from a different lens.

**11.1 — The repository was public with its own defect register.** Covered in §6.2/R1. No audit
dimension examined repository visibility; the coverage critic did not surface it either. It was
found by asking a question about file *aesthetics*.

**11.2 — Cloudflare would have made the client-IP spoof look fixed while leaving it forgeable.**
Covered in T1-0. This is a *design* defect that would have been introduced by the deployment
work itself, and it is the second time this exact class has appeared (D-199/D-124). Worth
naming as a class: **a control that becomes less trustworthy the more infrastructure you put in
front of it**, because each hop appends where the reader assumes it overwrites.

**11.3 — Host-header poisoning reaches an outbound invitation email. NEW, unexamined by anyone.**
The invitation URL is built from the request
(`app/api/v1/orgs/[slug]/members/route.ts:100`, `new URL(..., req.nextUrl.origin)`), nginx
forwards `Host $host` from the request, and nginx declares **no `default_server`** — so the
single 443 block answers any Host header. A request to the origin IP carrying
`Host: attacker.example` produces an invitation email whose link points at the attacker's
domain. The audit's §8 named this seam in its list of mutual-deferral orphans — *"a
request-host-derived URL in outbound email, the classic Host-header-poisoning-to-phishing
seam — examined by nobody."* It has now been examined, and the defect is real. Fixed in T1-0
Stage C (a `default_server` returning 444, and deriving the URL from `NEXTAUTH_URL`).

**11.4 — The skills inventory's own audit method does not measure what it claims.** Its
maintenance rule says to grep the git log for skill names; that counts commit-message
*mentions*, not invocations, and over-counts by 10–25×. Measured directly: grep reports
`code-review` 25 times, while the true count of Skill-tool invocations across 107 session
transcripts is **1**. Several of the grep hits are commits *recording that the skill was not
invoked*. Corrected in the v0.4 inventory. The wider consequence for §7's process claims: the
strong form of the project's central law — *"checkpoint-bound skills fire, unbound ones do
not"* — **is partly falsified** on re-measurement. Over the v0.3 window four of the six
newly-bound skills still never fired, and two skills that *had* been firing reliably
(`verification-before-completion`, `rigor-loop`) dropped to zero. `test-driven-development` and
`systematic-debugging` have never been invoked in the project's history. Binding is necessary;
it is not sufficient. That is a genuine correction to a belief this project has been building
on since 2026-08-03, and it deserves a phase-exit conversation rather than a footnote.
