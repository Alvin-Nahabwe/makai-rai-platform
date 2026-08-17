<!-- A PR body explains one branch to a person deciding whether to trust it or revert it.
     Commits explain one diff; docs/DEFERRED_REGISTER.md explains one decision not taken.
     See docs/COMMIT_CONVENTION.md §7. Write for someone who was not present: no session
     narrative, no first person, no "round N", no paths under gitignored directories. -->

## What this does

<!-- The system before, the system after, and what breaks without this. System and product
     terms, not file names and line counts — the diff already lists those. Cite a file:line
     or a command and its output for any load-bearing claim (AGENTS.md §5). -->

## Evidence

| Gate | Command | Result |
|---|---|---|
| Lint | `npm run lint` | |
| Typecheck | `npm run typecheck` | |
| Unit + integration | `npm test` | |
| End-to-end | `npm run test:e2e` | |
| Live browser | `npm run dev`, then driven in a browser | |
| **Not verified** | — | |

<!-- Results, not adjectives: "1572/1572 across 51 files", not "tests pass". Every row must
     come from a run against this branch's current head — an earlier run is not evidence
     about the current state (AGENTS.md §1 C5).

     The "Not verified" row is required and is never left blank. Name each gate not run and
     why, each path not exercised live, and each assumption inherited rather than checked.
     "Everything was verified" is itself a claim that needs grounds. -->

## Risk and reversal

<!-- Reach first (AGENTS.md §3): what does this make possible that was not possible before,
     and what now happens on the paths this branch did not touch?
     Then reversal: name the concrete undo — a commit or range to revert, a migration to roll
     back, a GitHub or infrastructure setting to restore. If some part cannot be reverted
     cleanly (data migrations, published artifacts, external config), say so here. -->

## Register

<!-- Rows in docs/DEFERRED_REGISTER.md this branch opened or closed, one line each: ID, kind,
     and — for a closure — the commit and what was verified live. This section reports rows;
     it does not substitute for them. A new deferral belongs in the same commit that created
     it (AGENTS.md §6). If the branch opened and closed none, write "None". -->

## Decisions for the reviewer

<!-- What this branch cannot settle for itself: forks taken provisionally, rulings needed,
     anything built on an assumption a reviewer should confirm or reject. State each option
     and its consequence in plain language, so the answer is a decision and not a rubber
     stamp. "None" is a valid answer; silence is not. -->

---

- [ ] Every gate above run against this branch's current head, with its real output recorded
- [ ] Live browser verification done, or its absence stated in the **Not verified** row
- [ ] Register rows entered in the same commit as the deferral that created them
- [ ] Commit messages follow `docs/COMMIT_CONVENTION.md` — subject ≤72 chars, no session narrative, `Refs:` trailer for register rows
