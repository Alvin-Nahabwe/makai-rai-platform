# Skills Inventory — MAK-AI RAI Toolkit

**Status:** v0.4 · Companion to `AGENTS.md` and the plan of record
**Re-measured 2026-08-18.** The organising idea — entries filed by *moment*, not by topic — is
unchanged from v0.3 and is not what failed. What failed was the **measurement** the document
told you to take, and the **law** that measurement was used to prove.

---

## §0 — How this document works, and why it is shaped this way

### §0.1 The measurement, corrected

v0.3 (2026-08-03) opened with a table showing that eight checkpoint-bound skills had fired and
six unbound ones had not, and concluded:

> *"A skill that is not bound to an observable moment will not be invoked."*

That conclusion was drawn from `git log | grep`, which **does not measure invocation at all**.
It measures how often a skill's name was typed into a commit message. Re-measured against the
session transcripts, the two numbers diverge by an order of magnitude:

| Skill | `git log --all --format=%B \| grep -ic` | Actual `Skill` tool invocations |
|---|---|---|
| `code-review` (both name forms) | 25 | 18 |
| `simplify` | 19 | 18 |
| `silent-failure-hunter` | 16 | 18 *(as an Agent, not a Skill)* |
| `superpowers:test-driven-development` | 8 | 39 |
| `superpowers:systematic-debugging` | 4 | 8 |
| `rigor-loop` | 3 | 7 |

The grep is not merely imprecise, it is **anti-correlated in places**. Several of its hits are
commits that exist *because* a skill was not invoked — for example, commit bodies on this branch
containing the strings `` C4 required running `code-review` and `simplify`. Both skills' `` and
`` `simplify` scored 13 and 15 for skills D-197 records were never invoked ``. A rule that counts
those as evidence the skill fired will report the opposite of the truth.

*(Identifiers of the form `D-nnn` throughout this document are rows in
`docs/DEFERRED_REGISTER.md`, the project's record of everything consciously not done.)*

**The second error was worse and less obvious.** The first attempt to correct the grep read the
transcripts at `~/.claude/projects/-home-alvin-Downloads-MAK-RAI-toolkit-platform/*.jsonl` — 107
files — and reported 59 invocations lifetime, with `superpowers:test-driven-development` and
`superpowers:systematic-debugging` at **zero across the project's entire history**. That is also
wrong. Subagent transcripts are stored one directory level down, at
`<project>/<session-id>/subagents/*.jsonl`:

```
$ find ~/.claude/projects/-home-alvin-Downloads-MAK-RAI-toolkit-platform/ -name '*.jsonl' | wc -l
457
$ ls ~/.claude/projects/-home-alvin-Downloads-MAK-RAI-toolkit-platform/*.jsonl | wc -l
107
```

107 main-thread files, 344 subagent files (six are neither — memory and workflow scratch). Reading
only the top level undercounts by **3.6×** and misattributes the entire process to nobody.

This is `AGENTS.md` §3 exactly: *"Vary the search **root**, not only the **predicate**."* The
git-log grep and the flat transcript scan asked two different questions of the same wrong place.

### §0.2 What the corrected numbers say

Counting `tool_use` blocks named `Skill` across **all 451 main-and-subagent transcripts**:

| | Lifetime | Before 2026-08-04 | 2026-08-04 → 08-18 (v0.3 in force) |
|---|---|---|---|
| Total `Skill` invocations | **211** | 72 | **139** |
| …by the controller (main thread) | 59 | 40 | 19 |
| …inside dispatched subagents | 152 | 32 | **120** |
| Distinct skills ever invoked | 26 | 20 | 22 |

Top of the v0.3 window: `superpowers:test-driven-development` 28, `engineering-skills:senior-security`
28, `simplify` 14, `code-review:code-review` 9 (+ bare `code-review` 6), `database-design:postgresql` 7,
`superpowers:systematic-debugging` 6, `engineering-advanced-skills:env-secrets-manager` 5,
`modern-web-guidance:modern-web-guidance` 5. Agent dispatches in the same window:
`pr-review-toolkit:silent-failure-hunter` 14 of 175.

### §0.3 The law, restated

v0.3's law is **half right, and the wrong half was load-bearing**.

> **Binding an obligation to an observable checkpoint is NECESSARY but NOT SUFFICIENT.**
> What actually makes a skill fire on this project is a **dispatch brief that names it**.
> 120 of the 139 invocations in the v0.3 window — **86%** — happened inside subagents.

The three pieces of evidence, each of which independently breaks the old formulation:

1. **Bound skills can die quietly.** `superpowers:verification-before-completion` sat in v0.3's
   "fired reliably" column with a count of 9, and it is bound twice over — the always-on tier at
   `AGENTS.md §1 C1`, plus the `UserPromptSubmit` hook, which names it explicitly. `rigor-loop` is
   bound at `AGENTS.md §1 C1` as the first always-on entry. Over the v0.3 window, which carried nearly
   **twice** the total invocation volume of everything before it (139 against 72), they scored
   **2** and **3**. `verification-before-completion` fired twice while C5 — "before claiming done" —
   must have been reached dozens of times. Binding held; frequency collapsed.

2. **Unbound skills fire anyway, when a brief names them.** `engineering-advanced-skills:env-secrets-manager`
   (5) and `modern-web-guidance:modern-web-guidance` (5) appear in **no** `AGENTS.md` checkpoint and
   in **no** hook — `grep -c` over `AGENTS.md` returns 0 for both. They fired regardless, entirely
   inside subagents, because dispatch briefs named them. So does
   `engineering-advanced-skills:ci-cd-pipeline-builder` (2), `engineering-skills:senior-architect` (2)
   and `ui-design:accessibility-audit` (1), all unbound workstream entries.

3. **The controller is the weak lane, not the subagent.** The controller invoked 19 skills in two
   weeks against the subagents' 120. Every checkpoint C1–C6 binds the controller. The mechanism
   that is actually working is `AGENTS.md` §4 — *"every dispatch carries the process"* — because a
   brief is a written artifact that a reviewer can check, while a checkpoint is a thing you have to
   remember you have reached.

**The practical consequence, and it is the only actionable sentence in this section:** if you want a
skill to run, **name it in the brief**. Adding it to a checkpoint table raises the chance it is
noticed; naming it in the dispatch is what has actually produced invocations here, 6 to 1.

What remains true from v0.3: a skill named in **neither** a checkpoint nor a brief fires zero times.
`handoff:handoff`, `reflect:reflect`, `superpowers:executing-plans`,
`superpowers:requesting-code-review`, `superpowers:receiving-code-review`,
`frontend-design:frontend-design`, `humanizer`, `code-to-prd:code-to-prd`,
`statistical-analyst:statistical-analyst`, `data-quality-auditor:data-quality-auditor` and
`chrome-devtools-mcp:chrome-devtools` are all at **0** across all 211 invocations.

### §0.4 Maintenance rules (these are rules, not preamble)

1. **Every entry names the moment it fires.** An entry whose trigger is a topic rather than an
   event is rejected — find its moment or leave it out.
2. **A §1 or §2 entry must also be named in the corresponding `AGENTS.md` checkpoint or trigger
   row, or be marked `PROPOSED` here.** This document alone binds nothing. v0.3 broke this rule
   four times without marking it; the tables below now carry a **Binding site** column citing
   `AGENTS.md:<line>`, the hook, or `PROPOSED` where no binding exists yet.
3. **Verify the exact name at the point of use.** Two things drift: what is *installed on disk*
   and what is *visible to the `Skill` tool this session*. They are different sets. The session's
   own available-skills listing is the authority; disk is corroboration. See §4.
4. **Re-audit at every phase exit by reading the transcripts, not the git log.** Command below.
   The git-log grep may be kept as a *secondary* signal — the gap between "25 mentions" and
   "18 invocations" is itself diagnostic — but it must be labelled as measuring **discussion**,
   never invocation.
5. **Prefer converting a rule here into a script or hook** (`AGENTS.md` §0.4). The
   `update-config` skill is the tool for that and has been used once.

### §0.5 The re-audit command (rule 4)

Run this at every phase exit. It counts `Skill` tool calls in **both** lanes and reports them
separately, because the main/subagent split is the finding that matters most. Pass a start date to
window it; omit for lifetime.

```bash
python3 - 2026-08-04 <<'PY'
import json, glob, os, sys, collections
since = sys.argv[1] if len(sys.argv) > 1 else '0000-00-00'
root = os.path.expanduser('~/.claude/projects/-home-alvin-Downloads-MAK-RAI-toolkit-platform')
skills = {'main': collections.Counter(), 'subagent': collections.Counter()}
agents = collections.Counter()
for path in glob.glob(os.path.join(root, '**', '*.jsonl'), recursive=True):
    rel = os.path.relpath(path, root)
    if '/subagents/' in rel:  lane = 'subagent'
    elif '/' not in rel:      lane = 'main'
    else:                     continue          # memory/, workflow scratch
    for line in open(path, errors='ignore'):
        try: rec = json.loads(line)
        except ValueError: continue
        body = (rec.get('message') or {}).get('content')
        if not isinstance(body, list): continue
        if (rec.get('timestamp') or '')[:10] < since: continue
        for block in body:
            if not isinstance(block, dict) or block.get('type') != 'tool_use': continue
            if block.get('name') == 'Skill':
                skills[lane][(block.get('input') or {}).get('skill', '?')] += 1
            elif block.get('name') in ('Agent', 'Task'):
                agents[(block.get('input') or {}).get('subagent_type', '(none)')] += 1
names = set(skills['main']) | set(skills['subagent'])
print(f"{'skill':52} {'main':>6} {'subagent':>9} {'total':>6}")
for n in sorted(names, key=lambda n: -(skills['main'][n] + skills['subagent'][n])):
    m, s = skills['main'][n], skills['subagent'][n]
    print(f'{n:52} {m:6d} {s:9d} {m+s:6d}')
print(f"\nTOTAL: {sum(skills['main'].values()) + sum(skills['subagent'].values())}"
      f"  (main {sum(skills['main'].values())}, subagent {sum(skills['subagent'].values())})")
print('\nAgent subagent_type:')
for n, v in agents.most_common(): print(f'{n:52} {v:6d}')
PY
```

Two caveats, both of which change how you read a zero:

- **Agents are counted separately and must be.** `pr-review-toolkit:silent-failure-hunter` is an
  Agent, not a Skill; it will never appear in the skill column no matter how often it runs. The
  command prints `subagent_type` counts for this reason.
- **A zero here means "no one called it through the `Skill` tool".** A skill whose SKILL.md content
  was read and followed by other means leaves no trace. Treat zero as *strong evidence of neglect*,
  not proof of it.

**Do not substitute the `session-report:session-report` plugin for this command.** Its
`analyze-sessions.mjs` also counts slash-command `<command-name>` blocks into the same bucket
(`analyze-sessions.mjs:452-456`), so its `skill_invocations` for this project contains entries such
as `"compact": 5` and `"model": 9`, which are not skills. It is a good cost/token report; it is not
a clean invocation count.

---

## §1 — Bound to a checkpoint (the always-on tier)

Checkpoints are defined in `AGENTS.md` §1. **Binding site** cites where the obligation actually
lives — this document does not create one.

| Skill (exact `Skill`-tool name) | Fires at | Binding site | Invocations (lifetime / v0.3 window) | Notes |
|---|---|---|---|---|
| `rigor-loop` | **C1**, and any analysis or decision the partner will act on | `AGENTS.md §1 C1` | 7 / 3 | Framing, evidence, bias, self-critique. Runs silently on light tasks. **Frequency collapsed under v0.3 — see §0.3.** |
| `superpowers:brainstorming` | **C1**, before any feature or behaviour work | `AGENTS.md §1 C1`; hook | 6 / 4 | Explore intent before building. Not needed when executing an approved plan. The one skill the controller reliably runs. |
| `superpowers:writing-plans` | **C1**, once a spec exists | **hook only** (`~/.claude/settings.json:9`) — `grep -c writing-plans AGENTS.md` → **0** | 5 / 2 | Spec → staged plan. Bound in a user-level file outside the repo, so it does not travel with a clone. |
| `superpowers:subagent-driven-development` | **C1** of a plan with independent tasks | `AGENTS.md §1 C1 and §1 C4` | 5 / 2 | Sequencing only. **Discharges nothing else** (`AGENTS.md` C1). |
| `superpowers:executing-plans` | **C1** when running an approved plan | `AGENTS.md §1 C1` | **0** / 0 | Named in a checkpoint but **absent from v0.3's table** — the reverse of a decorative entry. Added here. |
| `engineering-skills:senior-security` | **C1** of every task touching auth, tenancy or data access | `AGENTS.md §7`; hook | 38 / 28 | The *preventive* half of `AGENTS.md` §7.1. Derive obligations fresh per task; re-using an earlier task's threat table is the §2 "reusing a conclusion" trigger. Highest-firing skill on the project. |
| `database-design:postgresql` | **C1** of any schema, migration, index, RLS or role change | `AGENTS.md §1 C1` | 15 / 7 | Postgres mechanics. |
| `engineering-advanced-skills:database-designer` | **C1** alongside the above, for shape rather than mechanics | **hook only** (`settings.json:9`) | 1 / 0 | Named in the hook, was filed only under §3 in v0.3. Promoted here so the hook and the inventory agree. |
| `superpowers:test-driven-development` | **C1→C4**, before implementation code | `AGENTS.md §1 C1` names only the abbreviation **"TDD"** — the string `test-driven-development` appears **nowhere** in `AGENTS.md` | **39 / 28** | Red before green; assertions must be non-vacuous. v0.3's successor measurement called this zero-ever; it is the **most-invoked skill on the project**, entirely inside implementer subagents. The binding is still fragile: an agent that greps `AGENTS.md` for the invocable name finds nothing. |
| `code-review` *(harness skill)* | **C4**, on receiving any code chunk | `AGENTS.md §1 C4` | 6 / 6 | Correctness and quality of the diff. **An SDD reviewer's spec-compliance verdict does not discharge this** (D-063, D-083 — see `docs/DEFERRED_REGISTER.md`). Prefer the harness skill over the plugin command: `AGENTS.md`'s 2026-08-12 C4 amendment turns on these being *review-and-apply-fixes* tools, and only the harness one documents `--fix`. See §4.3 for the five things now called "code review". |
| `code-review:code-review` *(plugin command)* | same moment, alternative tool | `AGENTS.md §1 C4` | 12 / 9 | What has actually been invoked to date. Functionally acceptable; §4.3 explains why the harness skill is the better default. |
| `simplify` *(harness skill)* | **C4**, after `code-review`, on a chunk you are keeping | `AGENTS.md §1 C4` | 18 / 14 | Clarity and altitude. Quality only — it does not hunt bugs. |
| `superpowers:verification-before-completion` | **C5**, before any completion claim | `AGENTS.md §1 C1` (the always-on tier list); hook. **C5 itself, `AGENTS.md §1 C5-125`, names no skill** | 3 / 2 | Evidence before assertion; run the command **in this message**. **Two invocations across a two-week window in which completion was claimed repeatedly** — the clearest instance of §0.3's point that binding is not sufficient. |
| `run` | **C5**, when the claim involves the app behaving | `AGENTS.md §1 C5` | 2 / 2 | Drives the real app. Prefer over hand-rolled curl or browser steps. |
| `security-review` | **C6**, over the whole branch diff | `AGENTS.md §1 C6` | 11 / 4 | The *detective* half of §7.1. Found both fail-opens Plan 1a shipped (D-080, D-081 in `docs/DEFERRED_REGISTER.md`). |
| `superpowers:finishing-a-development-branch` | **C6**, when the branch is ready to merge | `AGENTS.md §1 C6` | 3 / 2 | |

**Proposed, pending an `AGENTS.md` amendment.** The revised plan
(`docs/planning/2026-08-17-revised-vision-and-plan.md` §5.1) proposes a **C7 — before committing**.
If C7 is adopted, no skill binds to it; it is a reading obligation plus a token lint. Nothing is
listed here for it until it exists.

---

## §2 — Bound to a mid-execution trigger

These fire on the observable conditions in `AGENTS.md` §2, not on a schedule. They bind subagents
exactly as they bind the controller — and per §0.3, the subagent lane is where they actually fire.

| When you notice… | Invoke | Binding site | Invocations (lifetime / window) |
|---|---|---|---|
| Something failed, behaves unexpectedly, or you are about to work around it | **`superpowers:systematic-debugging`** | `AGENTS.md §2` | 8 / 6 |
| You reach a hard-to-reverse fork — data model, tenancy, identity, scoring, hosting posture | **`what-if-oracle`**. Mandatory at these forks. *Structural limit:* this trigger explores a decision you have **named**, so it cannot reach one you never named — hence the row below. | `AGENTS.md §2` | 9 / 4 |
| **You have just produced an enumeration that will be treated as complete** — a file list, a test matrix, a task sequence, a set of proof obligations | **`what-if-oracle` aimed at the decomposition itself** — the What-If is *"what if this ships exactly as specified?"*; **Ψ Wild Card** and **∞ Second Order** are the slots that surface a question nobody asked. Plus `AGENTS.md` §3's decomposition obligation (two lenses with **different roots**, state the connections, claim-vs-gate). | `AGENTS.md §3` | (counted above) |
| **You have finished a design artifact and are about to put it in front of your human partner** | **`engineering-skills:adversarial-reviewer`**, briefed to attack the **decomposition** — *"what is missing, and what lens would reveal it?"* — not to review the content. Self-review is 0-for-7 on this class; independent review is 7-for-7 (D-092, D-103). | `AGENTS.md §2` | 4 / 2 |
| You are about to write anything that gates access — a policy, role grant, `where`, auth check, session read | `engineering-skills:senior-security` **now**, not at the end | `AGENTS.md §2` | (counted in §1) |
| You are writing error handling, a fallback, a `catch`, or a default | **`pr-review-toolkit:silent-failure-hunter`** — an **Agent**, dispatched via the `Agent` tool with `subagent_type`, never the `Skill` tool (§4.2). Its output is **pulled from a file, not awaited** (`AGENTS.md` §4). | `AGENTS.md §2` | **18 Agent calls / 14** — the best-performing entry in this table |
| A module bypasses a security control, or you are reviewing your own security work | `engineering-skills:adversarial-reviewer`, or an independent reviewer | `AGENTS.md §2` | (counted above) |
| **You are handling a credential, connection string, `.env*`, compose file, or provisioning script** | **`engineering-advanced-skills:env-secrets-manager`** | **PROPOSED** — `grep -c env-secrets-manager AGENTS.md` → **0** | 6 / 5 |
| **You are about to write or edit HTML, CSS, client-side JS, or touch Next.js routing/APIs/config** | **`modern-web-guidance:modern-web-guidance`** | **PROPOSED** — `grep -c modern-web-guidance AGENTS.md` → **0**, despite `AGENTS.md`'s opening line being *"This is NOT the Next.js you know"* | 5 / 5 |

### §2.1 The two PROPOSED rows, stated honestly

`env-secrets-manager` and `modern-web-guidance` sat in v0.3's §2 table looking bound. They were
not, and are not: neither name appears anywhere in `AGENTS.md`, and neither is in the
`UserPromptSubmit` hook, whose text names only *brainstorming, writing-plans, TDD, senior-security,
database-designer, verification-before-completion*, plus `what-if-oracle` and `security-review`
(`~/.claude/settings.json:9`).

They fired anyway — 5 times each, all inside subagents whose briefs named them. That is §0.3's
point made concretely, and it is also why they are worth binding rather than dropping: they are
carrying real weight on a route that depends on whoever writes the next brief remembering them.
Both are about to matter more, not less:

- **`env-secrets-manager`** — the deployment phase opens with compose environment plumbing,
  `AUTH_TRUST_HOST`, a Resend key, an origin certificate and a backup credential. The repo has
  `docker/docker-compose.yml`, `docker/docker-compose.prod.yml` and `docker/Dockerfile`, none of
  which this skill has ever been pointed at.
- **`modern-web-guidance`** — its own frontmatter reads *"MANDATORY: Execute FIRST for all HTML/CSS
  and clientside JS tasks."* The product-honesty phase is an account-settings surface, a privacy
  rewrite and a README.

**Suggested `AGENTS.md` §2 trigger-table rows, so an amendment and this file can be made to agree in
one commit:**

```markdown
| You are editing a compose file, an `.env*`, a provisioning script, or any secret-bearing config | `engineering-advanced-skills:env-secrets-manager` |
| You are about to write or edit HTML, CSS, or client-side JS, or touch Next.js routing, APIs or config | `modern-web-guidance:modern-web-guidance` — its own description says run it FIRST |
```

Until such a commit lands, these rows are marked PROPOSED and **must not be counted as bindings**.
Writing them here does not bind them; that is the whole point of maintenance rule 2.

### §2.2 Moved out of the bound tier: unbound, available on request

v0.3 listed `handoff` and `reflect` among mid-execution triggers. Neither is named in `AGENTS.md`,
neither is in the hook, and **both have zero invocations across all 211** on record. Their stated
triggers — *"you are about to hand off, pause, or end a session"* and *"you are unsure the direction
still holds"* — are not observable events an agent can detect; they are moods. Maintenance rule 1
rejects exactly that, and writing a trigger to satisfy the rule would be the laundered-deferral
failure `AGENTS.md` §6 names.

So they move here, honestly unbound, and their correct names are recorded:

| Skill | What it is for | Why unbound |
|---|---|---|
| `handoff:handoff` (also `handoff:cs-handoff`, `handoff:cs-handoff-setup`) | Structured session handover | No observable trigger. Invoke when the human partner asks for a handover document. |
| `reflect:reflect` (also `reflect:cs-reflect`) | Direction check against cognitive-bias canon | No observable trigger. Overlaps `rigor-loop` step 3, which **is** bound. |
| `session-report:session-report` | HTML report of session token/cache/skill usage | Useful for cost review; **not** a substitute for §0.5's command (see the warning there). |
| `engineering-advanced-skills:skill-security-auditor` | Audits a third-party skill/plugin for unsafe behaviour | Invoke on request. Relevant now: see §4.5. |
| `update-config` | Writes `settings.json` hooks and permissions | The tool for `AGENTS.md` §0.4's *"prefer converting a rule into a script, hook, or test"*. 1 invocation. |
| `schedule`, `loop` | Cron-scheduled cloud agents; recurring prompts | The plan's process item P2 asks for a monthly dependency-review trigger; these are the mechanisms that could carry it. |

---

## §3 — Workstream entries, keyed to entry conditions

These fire when you **enter** an area, which is an observable event. Zero invocations while an area
is untouched is the inventory working, not a gap.

**Headings are keyed to the revised plan's `T`-phase vocabulary**
(`docs/planning/2026-08-17-revised-vision-and-plan.md` §3), not the retired "Phase 1a/2/4" names.
That plan's process item P5 records that roughly 139 register rows still carry the old vocabulary,
and that a phase-exit check grepping for retired names would pass vacuously. This file had the
identical exposure. Phase names appear here only where the plan itself uses them.

Every name below is the exact string the `Skill` tool accepts, verified against this session's
available-skills listing and against disk (§4.1).

---

### Entering deployment, provisioning or VPS/ops work — **T1-0, T1**

The immediate phase. A bare Hetzner VPS and a Cloudflare-managed domain are purchased and not yet
configured; `docs/runbooks/deployment.md:15-16` names *Hetzner CX32* and *Ubuntu 22.04 LTS*, and the
plan corrects the OS to 24.04.

| Name | Use it for |
|---|---|
| `engineering-skills:senior-devops` | CI/CD, containerisation, deployment automation, infrastructure. **Never invoked; the most on-point absent skill for this phase.** |
| `engineering-advanced-skills:ci-cd-pipeline-builder` | `.github/workflows/ci.yml` has two jobs — `verify` (`:34`) and `test-e2e` (`:212`). Any deploy stage is new work. 2 invocations. |
| `engineering-advanced-skills:runbook-generator` | The three files in `docs/runbooks/` must be **rewritten by executing them** on the real box (plan T1 exit). Re-targeted here from v0.3's "Phase 4". |
| `engineering-advanced-skills:observability-designer` · `:slo-architect` | Log persistence and alerting. Note the plan's ordering constraint: Docker `log-opts` apply only to containers created *after* `/etc/docker/daemon.json` is written. |
| `engineering-advanced-skills:env-secrets-manager` · `:secrets-vault-manager` | Compose env plumbing, `AUTH_TRUST_HOST`, Resend key, origin cert, backup credential. See §2.1. |
| `engineering-skills:incident-commander` · `engineering-skills:incident-response` | The executed restore drill and its failure alerting; severity classification for a single-VPS topology. |
| `engineering-advanced-skills:ship-gate` | Pre-production audit that intercepts deploy commands and blocks on critical items. A go-live gate, not a CI builder. |
| `engineering-advanced-skills:release-manager` · `:changelog-generator` | Release mechanics once a deploy path exists. |
| `engineering-advanced-skills:dependency-auditor` | The `npm audit` surveillance step the plan puts in T0, and CVE triage thereafter. |
| **MCP, not a skill:** `prisma:Prisma-Local` → `migrate-status`, `migrate-dev`, `migrate-reset`, `Prisma-Studio` | Round-tripped live on 2026-08-18: `migrate-status` returned *"14 migrations found in prisma/migrations / Database schema is up to date!"* against `postgresql://…localhost:5432/makrai`. This is the prerequisite the plan describes as blocking the assessment-durability phase. |
| **Agents, not skills:** `deployment-strategies/deployment-engineer`, `deployment-strategies/terraform-specialist`, `deployment-validation/cloud-architect`, `cloud-infrastructure/network-engineer` | `deployment-strategies` and `deployment-validation` — the two installed plugins whose *names* promise deployment — contain **no skills at all**, only these agent definitions. A brief that says "invoke the deployment skill" will find nothing. Dispatch them as agents or use the rows above. |

### Entering Cloudflare / edge configuration — **T1-0 Stage A/C, T1b**

The ruled posture is **proxied, Full (strict)** with the origin firewalled to Cloudflare ranges.

| Name | Use it for |
|---|---|
| `cloudflare:cloudflare` | The general platform skill: DNS, WAF, DDoS, Tunnel, SSL modes. Note its bias toward Workers/Pages — **this platform is a Docker deploy on a VPS, not a Worker**, so most of the plugin (`cloudflare:workers-best-practices`, `:durable-objects`, `:wrangler`, `:agents-sdk`, `:sandbox-sdk`, `:build-agent`, `:build-mcp`) does **not** apply. Say so in the brief or you will get Workers advice. |
| `cloudflare:turnstile-spin` | The single most on-point new arrival for the public-exposure phase. That phase's stated problem is registration rate limiting that keys on something an attacker does not control; Turnstile is a bot control on exactly that form, and this skill wires widget + server-side `siteverify` end to end. |
| `cloudflare:cloudflare-one` | Zero Trust / Access / Tunnel / WARP — only if the VPS is fronted by Tunnel rather than a public origin. |
| `cloudflare:web-perf` | Core Web Vitals via the Chrome DevTools MCP. Pairs with the UI phase. |
| **MCP, not a skill:** `cloudflare-docs` (`search_cloudflare_documentation`), `cloudflare-api` (`docs`, `search`, `execute`), `cloudflare-observability`, `cloudflare-bindings`, `cloudflare-builds` | Round-tripped live on 2026-08-18: a docs search for *"Full (strict) SSL mode origin certificate"* returned the `ssl/origin-configuration/ssl-modes/full-strict/` page. Prefer this over recalled Cloudflare behaviour. |

**Scope warning for this area.** Cloudflare's standard onboarding moves nameservers for the whole
apex zone. If the target hostname sits under an institutional zone carrying mail or other hosts,
that is blast radius outside this project — the plan makes it the first thing decided, and it is a
`what-if-oracle` fork under `AGENTS.md` §2, not a configuration step.

### Entering public-exposure hardening — **T1b**

`engineering-skills:security-pen-testing` · `engineering-skills:red-team` ·
`engineering-skills:threat-detection` · `engineering-skills:senior-secops` ·
`engineering-advanced-skills:dependency-auditor` · `cloudflare:turnstile-spin` ·
`engineering-skills:ai-security` *(only if the platform itself calls a model)*

`engineering-skills:senior-security` (§1) and `security-review` (§1) still carry the preventive and
detective halves; these are the additions for the specific phase where open registration goes onto a
public domain.

### Entering data-model, migration or schema work — **T2, T4**

`database-design:postgresql` · `engineering-advanced-skills:database-designer` ·
`engineering-advanced-skills:database-schema-designer` ·
`engineering-advanced-skills:migration-architect` · `mattpocock-skills:domain-modeling` ·
`engineering-advanced-skills:sql-database-assistant`

**`sql-pro` is an AGENT, not a skill** — v0.3 listed it here and invoking it as a skill fails.
See §4.2.

### Entering architecture or an ADR

`engineering-skills:senior-architect` · `backend-development:architecture-patterns` ·
`mattpocock-skills:codebase-design` · `engineering-skills:tech-stack-evaluator`

ADRs go in `docs/adr/` (currently 0001 data access, 0002 identity, 0003 framework-version registry).
The Cloudflare posture and its plaintext-at-the-edge cost are named in the plan as owing an ADR.

### Entering an unfamiliar area of the codebase

`engineering-advanced-skills:codebase-onboarding` · `engineering-advanced-skills:monorepo-navigator` ·
`code-to-prd:code-to-prd` *(recovers requirements from the existing SPA)* ·
`mattpocock-skills:research`

### Entering API or route work

`engineering-skills:senior-backend` · `backend-development:api-design-principles` ·
`engineering-advanced-skills:api-design-reviewer` · `engineering-advanced-skills:api-test-suite-builder`

Postman is connected (§4.4): `postman:send-request`, `postman:run-collection`, `postman:test`,
`postman:security`, `postman:mock`, `postman:generate-spec`, `postman:postman-cli`.

### Entering frontend or UI — **T3**

The product-honesty phase builds an account-settings surface (consent withdrawal, data export,
account deletion, password change) and rewrites user-facing copy. Lead with the tool aimed at
exactly that:

| Name | Use it for |
|---|---|
| `impeccable:impeccable` | Frontmatter names *"dashboards, product UI, app shells, forms, settings, onboarding, and empty states … UX review, visual hierarchy, information architecture, cognitive load, accessibility … UX copy, error states, edge cases"*. That is the T3 surface almost verbatim. **v4.1.1, installed 2026-08-17, never invoked.** Read §4.5 before enabling it on this repo. |
| `frontend-design:frontend-design` | General frontend design pass. 0 invocations. |
| `engineering-skills:senior-frontend` | Component and state architecture. 0 invocations. |
| `modern-web-guidance:modern-web-guidance` | Run **first** on any HTML/CSS/client-JS work (§2.1). |
| `ui-design:create-component` · `ui-design:design-review` · `ui-design:design-system-setup` | Plugin **commands**, invoked through the `Skill` tool by these exact names (§4.1). |
| `ui-design:design-system-patterns` · `:responsive-design` · `:interaction-design` · `:visual-design-foundations` · `:web-component-design` | Plugin skills proper. |
| `engineering-advanced-skills:full-page-screenshot` | Evidence capture for the generated promise inventory that phase's exit requires. |

### Entering anything a user sees — accessibility is not optional on an RAI tool

`ui-design:accessibility-audit` *(command; 1 invocation)* · `ui-design:accessibility-compliance` ·
`chrome-devtools-mcp:a11y-debugging`

The command and the skill do different jobs: `ui-design:accessibility-audit` scans the code you have
written, `ui-design:accessibility-compliance` carries the WCAG standard itself, and
`chrome-devtools-mcp:a11y-debugging` inspects the rendered accessibility tree in a real browser.
Code, standard, running page — three different roots, which is what `AGENTS.md` §3 asks for. Running
one of them is not a discharge of the other two.

### Entering user-facing copy or generated prose — **T3**

`humanizer` *(bare user skill)* or `humanizer:humanizer` *(plugin, v2.8.2)* — **user-facing copy and
generated-document prose only; never code, never internal docs.** 0 invocations.

T3's exit requires a **generated** promise inventory over public pages, in-app copy, refusal
messages, PDF output and API error text. That generation step is the entry condition for this skill,
not a topical suggestion — and per `AGENTS.md` §3, *generate the list rather than writing it*.

### Verifying live behaviour — every C5

`run` *(§1)* · `chrome-devtools-mcp:chrome-devtools` *(+ `:troubleshooting`, `:debug-optimize-lcp`,
`:memory-leak-debugging`, `:chrome-devtools-cli`)* · the Playwright MCP tools ·
`engineering-advanced-skills:browser-automation`

*From experience: Playwright's Chrome failed to launch here on a Qt platform-plugin error while the
chrome-devtools MCP worked. Try the other launcher before concluding "no browser".* Chrome DevTools
MCP tools have been called directly **29** times and Playwright MCP tools twice, while the
`chrome-devtools-mcp:chrome-devtools` **skill** has been invoked **0** times. Both routes are
legitimate — see §4.6.

### Entering artifact generation — the primary-adopter payoff

`docx` · `xlsx` · `pdf` · `pptx` · `markdown-mermaid-writing` · `scientific-schematics` · `dataviz` ·
`artifact-design` · `artifact-diagramming` · `artifact-capabilities` · `latex`

All bare names: user skills and harness skills, no plugin prefix (§4.1). `artifact-design` must be
read **before** writing any published artifact page, Markdown included.

### Entering standards / framework-content work — **T5**

`research-lookup` · `literature-search-openalex` · `literature-search-arxiv` ·
`literature-search-europepmc` · `citation-management` · `deep-research-synthesizer`

For the content audit against sources, the maturity-rubric derivation, and the standards crosswalk
(ISO/IEC 42001 + AU Continental AI Strategy 2024 + UNESCO EIA — locked decisions).

### Entering benchmarking or scoring analysis

`statistical-analyst:statistical-analyst` · `data-quality-auditor:data-quality-auditor` ·
`statistical-analysis` · `dataviz`

### Entering register / debt triage

`engineering-advanced-skills:tech-debt-tracker` *(1 invocation)* · `engineering-advanced-skills:focused-fix`

### Review and quality, on any substantial diff

`engineering-skills:adversarial-reviewer` · `engineering-advanced-skills:pr-review-expert` ·
`coderabbit:code-review` · `mattpocock-skills:code-review` ·
`superpowers:requesting-code-review` · `superpowers:receiving-code-review` ·
`pr-review-toolkit:review-pr` *(a command)* · the `pr-review-toolkit` **agents** (§4.2)

The two `superpowers:*` review skills are the ones the subagent-driven loop is nominally built on
and have **0** invocations each. §4.3 disambiguates the five things now called "code review".

### Parallelisation — only when work genuinely fans out, or the partner asks

`superpowers:dispatching-parallel-agents` *(0 invocations)* · `agent-teams:*`

Remember `AGENTS.md` §4: **a helper agent's output is PULLED from a file, not awaited.** A
completion notification routes to the controller, not to the peer that launched it. Two stalls on
this project came from waiting on an agent that could never report back.

---

## §4 — Invocation mechanics

v0.3's §4 existed to stop name errors. It contained three of its own, and its availability
paragraph is now false on every count.

### §4.1 Exact names

Skills are invoked with the `Skill` tool by **exact name**. Three shapes are valid, and the
difference is not cosmetic — a bare name where a prefix is required simply fails:

| Shape | Example | Where it lives |
|---|---|---|
| `plugin:skill` | `engineering-skills:senior-security` | `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<name>/SKILL.md` |
| `plugin:command` | `ui-design:accessibility-audit`, `code-review:code-review`, `pr-review-toolkit:review-pr`, `postman:test` | `…/<plugin>/<version>/commands/<name>.md` — **no `skills/` directory at all**, but still invoked through the `Skill` tool |
| bare name | `rigor-loop`, `what-if-oracle`, `humanizer`, `code-simplifier`, `docx`, `pdf` (user skills, `~/.claude/skills/<name>/SKILL.md`); `code-review`, `simplify`, `run`, `security-review`, `dataviz`, `artifact-design`, `update-config`, `schedule`, `loop`, `claude-api` (harness skills, **no on-disk file**) | — |

**v0.3 wrote about 25 names without their prefix.** Corrected forms are used throughout §3 above;
the ones that changed include `frontend-design` → `frontend-design:frontend-design`;
`design-system-setup`/`design-review`/`responsive-design`/`interaction-design`/`visual-design-foundations`/`accessibility-compliance`
→ `ui-design:*`; `api-test-suite-builder`/`release-manager`/`changelog-generator`/`observability-designer`/`runbook-generator`/`slo-architect`/`monorepo-navigator`/`secrets-vault-manager`/`env-secrets-manager`/`ship-gate`/`tech-debt-tracker`
→ `engineering-advanced-skills:*`; `security-pen-testing`/`red-team`/`threat-detection` →
`engineering-skills:*`; `code-to-prd` → `code-to-prd:code-to-prd`; `statistical-analyst` →
`statistical-analyst:statistical-analyst`; `data-quality-auditor` →
`data-quality-auditor:data-quality-auditor`.

**The plugin *directory* name is not always the invocable prefix.** `reflect:reflect` lives under
`claude-code-skills/reflect-skill/2.9.0/skills/reflect/`; `handoff:handoff` under
`handoff-engineering/`. Deriving names from paths produces wrong answers. Check the session's
available-skills listing.

### §4.2 Agents are not skills

These are `subagent_type` values for the **`Agent`** tool. Passing one to the `Skill` tool fails.

- `pr-review-toolkit:silent-failure-hunter` — 18 dispatches, the highest-firing entry in §2
- `pr-review-toolkit:type-design-analyzer`, `:pr-test-analyzer`, `:comment-analyzer`,
  `:code-reviewer`, `:code-simplifier`
- **`sql-pro`** — `~/.claude/plugins/cache/claude-code-workflows/database-design/1.2.1/agents/sql-pro.md`.
  There is no `skills/sql-pro/SKILL.md` anywhere. v0.3 listed it among skills for data-model work,
  which is the exact error §4 was written to prevent.
- `deployment-strategies/deployment-engineer`, `deployment-strategies/terraform-specialist`,
  `deployment-validation/cloud-architect`, `cloud-infrastructure/network-engineer` — the deployment
  plugins ship agents only
- `ui-design/accessibility-expert`, `ui-design/design-system-architect`, `ui-design/ui-designer`
- `impeccable/impeccable-asset-producer`, `-documenter`, `-finish-reviewer`, `-manual-edit-applier`

**Two of v0.3's own corrections are now wrong and are withdrawn:**

- v0.3 said *"`run` and `review` do exist"*. **There is no `review` skill.** `run` does exist.
- v0.3 said `code-simplifier` is an agent and not a skill. **It is now both**: a user skill at
  `~/.claude/skills/code-simplifier/SKILL.md`, and agent definitions under
  `claude-plugins-official/code-simplifier/1.0.0/agents/` and `pr-review-toolkit/unknown/agents/`.

### §4.3 Five things are now called "code review". Pick deliberately.

| Name | Kind | What it is |
|---|---|---|
| **`code-review`** | harness skill | Takes an effort level, `--comment`, `--fix`. **The `AGENTS.md` C4 default** — the 2026-08-12 amendment turns entirely on these being review-**and-apply-fixes** tools, and this is the one that documents `--fix`. |
| `code-review:code-review` | plugin **command** | `claude-plugins-official/code-review/unknown/commands/code-review.md`; no `skills/` dir. What has been invoked in practice (12 times). Acceptable, but prefer the harness skill. |
| `coderabbit:code-review` | plugin skill | Third-party reviewer; its own description claims to be the default code-review skill. It is not, here. |
| `mattpocock-skills:code-review` | plugin skill | A different review philosophy. Fine as a *second* lens; not a substitute for C4. |
| `engineering-skills:code-reviewer` | plugin skill | Language-specific rule sets under `skills/code-reviewer/languages/`. |

Plus the agents `pr-review-toolkit:code-reviewer`, `feature-dev/code-reviewer`,
`coderabbit/code-reviewer` (§4.2). Whichever you use, `AGENTS.md` C4 requires **a separate,
explicit verdict per lens** — code-review, then simplify — and a lens that finds nothing must say
so plainly rather than manufacture a finding.

### §4.4 MCP availability — v0.3's paragraph was false on all four counts

v0.3 said `postman:*`, `cloudflare:*`, `huggingface-skills:*` and `prisma:Prisma-Remote` "need
authorising … treat as unavailable". **All four are connected.** `cat ~/.claude/mcp-needs-auth-cache.json`
returns `{}` — nothing is flagged as needing authorisation.

Two were round-tripped live on 2026-08-18 rather than merely being listed:

- **`prisma:Prisma-Local`** → `migrate-status` against this repo returned
  *"Datasource "db": PostgreSQL database "makrai", schema "public" at "localhost:5432" / 14
  migrations found in prisma/migrations / Database schema is up to date!"*. It also exposes
  `migrate-dev`, `migrate-reset` and `Prisma-Studio`. The plan makes a working `migrate dev` a
  blocking prerequisite for the assessment-durability phase — `migrate-reset` is destructive, so
  read `AGENTS.md` §4 on scope before using it.
- **`cloudflare-docs`** → `search_cloudflare_documentation("Full (strict) SSL mode origin
  certificate")` returned the canonical `ssl/origin-configuration/ssl-modes/full-strict/` page. The
  `cloudflare-api`, `cloudflare-bindings`, `cloudflare-builds` and `cloudflare-observability`
  servers are configured alongside it.

Also connected: the Postman server (~120 tools), `huggingface-skills`, `Prisma-Remote`,
`chrome-devtools`, `playwright`, `aws-core`, `aws-serverless`, `firebase`.

**Availability is per session, not permanent.** Rule 3 exists because these sets drift. Check before
you plan around one.

### §4.5 One installed plugin writes into this repo

`impeccable@impeccable` v4.1.1 (installed 2026-08-17, enabled at `~/.claude/settings.json`)
registers a **PostToolUse hook on `Edit|Write|MultiEdit`** and a **Stop hook**
(`~/.claude/plugins/cache/impeccable/impeccable/4.1.1/hooks/hooks.json` — matcher
`"Edit|Write|MultiEdit"`, timeout 5; Stop timeout 30). Its hook library writes
`.impeccable/hook.cache.json` and `.impeccable/hook.pending.json` into the project root
(`skills/impeccable/scripts/hook-lib.mjs:214,218`).

That directory was **not** covered by `.gitignore` when this was measured, so the next `Edit` or
`Write` in the repo would have left untracked residue — which `AGENTS.md` C4 classifies as a
finding, not noise, because review packages are built from `git diff` and an untracked file is
invisible to every reviewer. **`/.impeccable/` has since been added to `.gitignore:73`**, alongside
`/.superpowers/`, so the residue problem is closed; `ls -d .impeccable` still returns nothing
because no hook has run in this repo yet.

The reason to keep this section anyway: the *residue* was the smaller half. A third-party plugin
that has gained write access to the project root plus a hook on every edit is exactly the
`AGENTS.md` §2 trigger for reviewing something that gates or writes, and that review has not been
done. `engineering-advanced-skills:skill-security-auditor` is the installed tool aimed at that
question. Keep the plugin — its skill is the best-fitting tool available for the UI phase (§3) —
but audit it before leaning on it.

### §4.6 MCP tool ≠ skill

Using the chrome-devtools MCP tools directly is not the same as invoking
`chrome-devtools-mcp:chrome-devtools`. Both are legitimate; only the latter appears in §0.5's count.
This is why "0 invocations" for that skill sits next to 29 direct MCP calls in the transcripts, and
why a zero is evidence of neglect rather than proof of it.

---

## §5 — Dismissed, by category

| Category | Examples | Why |
|---|---|---|
| Scientific / bio / ML-compute | `scanpy`, `rdkit`, `biopython`, `astropy`, `pytorch-lightning`, `scikit-learn`, `pymc` | TypeScript/JS web platform, not scientific computing. The research-search skills are retained in §3 for standards work. |
| Python-stack development | `python-development:*` | Stack is TypeScript/Node. Revisit only if a Python service is introduced. |
| **Cloudflare — NO LONGER DISMISSED** | `cloudflare:cloudflare`, `:turnstile-spin`, `:cloudflare-one`, `:web-perf` | v0.3 dismissed these pending a hosting decision. **The trigger has fired**: the runbooks name Hetzner CX32 (`docs/runbooks/deployment.md:15`, `docs/runbooks/troubleshooting.md:11`), a domain is procured, and the edge posture is ruled. Moved to §3. *The Workers-oriented majority of the plugin stays dismissed — this is a Docker deploy, not a Worker.* **This does not close D-018** — the hosting/deployment parking row at `docs/DEFERRED_REGISTER.md:64`, still `PARKED` / Open, and cited by 34 other rows in that file (`grep -c 'D-018' docs/DEFERRED_REGISTER.md` → 35, including its own row). This entry records only that the skills-tier half of that gate is unblocked; the disposition of D-018 itself belongs to the deployment phase's exit. |
| Other cloud providers | `aws-core:*`, `aws-serverless:*`, `firebase:*`, `azure-*`, `gcp-*` | Dismissed on merit: hosting is a single VPS. Pick up only if that changes. |
| Kubernetes / service mesh | `cloud-infrastructure:istio-*`, `:linkerd-*`, `engineering-advanced-skills:kubernetes-operator` | One box, Docker Compose. Not applicable at this scale, and adopting them would be a hard-to-reverse fork (`AGENTS.md` §2 → `what-if-oracle`). |
| Mobile-native | `ui-design:mobile-ios-design`, `:mobile-android-design`, `:react-native-design` | Web platform. Responsive web is in scope; native is not. |
| Unrelated domain personas | `grants:*`, `notebooklm:*`, `clinical-*`, `research-ops-skills:*`, `caveman:*` | No fit to this engineering work. |
| Data-engineering / streaming | `data-engineering:*`, `astronomer-data:*`, Kafka/Kinesis | No pipeline component in scope. Note `astronomer-data:*` is *visible* this session but is not in `enabledPlugins` and is not in the plugin cache — an illustration of rule 3's installed-vs-visible distinction. |
| Superseded | `consciousness-council` | Its deliberation mechanism is absorbed by `rigor-loop` step 3. |

---

## §6 — Change log

### v0.4 — 2026-08-18

Corrected the five defects this revision was commissioned to fix, plus a sixth found while
verifying them (item 2 below, which changed every number in items 1 and 3), and re-keyed the
workstream section to the current plan.

1. **The audit method was replaced.** v0.3's maintenance rule 4 said to grep the git log for skill
   names. That measures commit-message *mentions*: 25 for "code-review" against 18 actual
   invocations, and several of the hits are commits recording that a skill was **not** invoked.
   Rule 4 now reads the session transcripts for `tool_use` blocks named `Skill`; §0.5 gives the
   exact command, with the git-log grep demoted to a labelled secondary signal.
2. **The transcript root was corrected, and it changed every number.** The first replacement method
   read only `~/.claude/projects/<project>/*.jsonl` (107 files) and reported 59 lifetime invocations
   with TDD and systematic-debugging at zero-ever. Subagent transcripts live at
   `<project>/<session-id>/subagents/*.jsonl` — 344 more files. True lifetime total: **211**.
   `superpowers:test-driven-development` is not zero, it is **39** and the most-invoked skill on the
   project. `superpowers:systematic-debugging` is 8, `modern-web-guidance` 5,
   `env-secrets-manager` 6, `simplify` 18, `code-review` (both forms) 18, and
   `silent-failure-hunter` 18 Agent dispatches. This is `AGENTS.md` §3's *"vary the search root, not
   only the predicate"* failing twice in a row on the same question.
3. **The central law was restated.** v0.3's *"8 of 8 bound skills fired; 0 of 6 unbound ones did"*
   does not survive re-measurement. Binding is **necessary but not sufficient**: two bound skills
   (`rigor-loop` 3, `superpowers:verification-before-completion` 2) nearly stopped firing under
   v0.3, while unbound ones (`env-secrets-manager` 5, `modern-web-guidance` 5) fired anyway. The
   variable that predicts invocation here is **whether a dispatch brief names the skill** — 120 of
   139 invocations in the v0.3 window happened inside subagents. §0.3 states this with the evidence.
4. **The four decorative entries were resolved, not quietly fixed.** `env-secrets-manager` and
   `modern-web-guidance` are named in no `AGENTS.md` checkpoint and no hook; both are now marked
   **PROPOSED** in §2 with the specific trigger row an `AGENTS.md` amendment should add. `handoff`
   and `reflect` have no observable trigger and zero invocations; rather than inventing one they
   move to §2.2, "unbound, available on request", with their correct names (`handoff:handoff`,
   `reflect:reflect`).
5. **Names were fixed against disk and the session listing.** `sql-pro` was listed as a skill and is
   an **agent** — the exact error §4 exists to prevent. About 25 entries lacked their plugin prefix
   and would have failed the `Skill` tool. §4.1 records the three valid name shapes, including
   plugin **commands** (`ui-design:accessibility-audit`, `code-review:code-review`) which have no
   `SKILL.md` but are still invoked through the `Skill` tool. Two of v0.3's own §4 corrections were
   withdrawn: there is no `review` skill, and `code-simplifier` is now both a skill and an agent.
6. **§4.4 availability was rewritten.** Postman, Cloudflare, huggingface-skills and both Prisma
   servers are connected; `mcp-needs-auth-cache.json` is `{}`. `prisma:Prisma-Local` `migrate-status`
   and `cloudflare-docs` search were round-tripped live rather than inferred from configuration.
7. **§3 was re-keyed and re-stocked for the phases actually coming.** Headings moved from the
   retired "Phase 1a/2/4" vocabulary to the plan's `T`-names. New entries for **deployment/VPS ops**
   (`engineering-skills:senior-devops`, `runbook-generator`, `observability-designer`, `ship-gate`,
   `incident-commander`, the `prisma:Prisma-Local` migrate tools, and the fact that both
   deployment-named plugins ship **agents only**), **Cloudflare/edge**, **public-exposure
   hardening**, and a rewritten **frontend/UI** entry led by `impeccable:impeccable`. Cloudflare was
   moved out of §5's dismissed tier because its stated pick-up trigger has fired — without
   pre-empting D-018's own disposition.
8. **New: §4.5** records that the `impeccable` plugin's PostToolUse hook writes `.impeccable/` into
   the project root. The residue half was closed while this revision was being written
   (`.gitignore:73`); the outstanding half is that a third-party plugin with write access to the
   project root and a hook on every edit has not been security-audited.
9. **§1 gained two entries that were bound but unlisted** — `superpowers:executing-plans`
   (`AGENTS.md §1 C1`) and `engineering-advanced-skills:database-designer` (in the hook) — and a
   **Binding site** column so that an entry with no real binding is visible as such rather than
   passing for one.

### v0.3 — 2026-08-03
Added the two §2 rows firing on **enumeration** and on **finishing a design artifact**, after three
design defects in one session all occurred inside enumerations and none of C1–C6 fired on "I just
wrote a table" (D-103). `adversarial-reviewer` had been bound only to "reviewing your own security
work", which is why it never fired on a spec. `what-if-oracle` gained a second binding aimed at the
decomposition rather than a named fork.

### v0.2 — 2026-08-03
Restructured by moment after the Plan 1a exit audit. Bound `code-review`, `simplify`,
`systematic-debugging`, `silent-failure-hunter`, `env-secrets-manager`, `adversarial-reviewer`,
`finishing-a-development-branch` and `modern-web-guidance` to specific moments. Added §4 after
finding that v0.1 listed agents as skills and named a non-existent `verify` skill.

### v0.1 — 2026-08-01
Initial triage into always-on and workstream tiers.
