# ADR-0002 — Identity model and account-linking policy

**Status:** Accepted · **Date:** 2026-08-02 · **Deciders:** engineering + product owner
**Related:** ADR-0001 (data-access architecture); register D-043, D-044, D-045, D-053

## Context

Phase 1b rewrites registration, which raised whether the platform should support federated
identity (institutional SSO, OAuth, magic links) and, if so, whether the schema must
accommodate it now. Our primary adopter is university teams, where institutional SSO is often
a procurement precondition rather than a preference.

Current state (verified 2026-08-02): credentials live directly on `User` — `passwordHash`,
`failedLoginAttempts`, `lockedUntil`, `mustChangePassword`, `isActive`. `next-auth` is at
**`5.0.0-beta.31`** with `session: { strategy: 'jwt' }` and a Credentials provider only. There
is **no production deployment (D-018), therefore zero real accounts.**

A `what-if-oracle` run on the schema question produced a result that inverted the initial
recommendation. The reasoning, preserved because it is the whole point of this ADR:

> **The irreversibility is not in the schema. It is in the accounts.** An identity table can
> be added in an afternoon with a mechanical backfill (`provider='credentials'`). What cannot
> be undone is a population of real accounts whose linking semantics were never decided —
> because then identities must be reconciled retroactively, and every retroactive
> reconciliation is a potential account takeover.

The initial recommendation ("add the identity table now, it's cheap insurance") imported the
`NOT NULL orgId` lesson by analogy. The analogy fails: `orgId` had to exist from day one
because tenant rows were being written from day one; identity rows are not. Committing our
identity model to a beta library's adapter schema is a real cost against a speculative benefit.

## Decision

**1. Credentials stay on `User` for Phase 1b.** No separate identity/account table yet.

**2. The account-linking policy is decided NOW, before any provider exists.** This is the
part that is expensive to get wrong, and the part that gets decided badly under procurement
pressure:

- **A provider identity is keyed by `(provider, providerSubjectId)` — never by email.**
  Email is mutable and re-assignable (especially institutional email, which is reclaimed when
  staff leave); a provider subject identifier is not. A mutable attribute must never be a
  primary identity key.
- **Never auto-link a new authentication identity to an existing account on an email claim
  alone.** This is the specific shortcut that turns a rushed SSO integration into account
  takeover of an account holding another institution's RAI evidence.
- **Linking requires proof of control of the existing account:** either the user is already
  signed in to it and re-authenticates, or they complete an email challenge **we** issue — not
  one an identity provider asserts on their behalf.
- **Only trust `email_verified` from providers on an explicit allowlist**, and never as a
  sufficient condition for linking on its own.
- **An IdP identity whose subject we have not seen creates a NEW user**, never a silent merge
  into an existing one.
- **Unlinking must not leave an account with zero authentication methods.**

**3. Authentication logic stays cohesive** in `lib/auth.ts` plus a dedicated identity module,
so credentials can be lifted into a separate table cleanly when the time comes. No auth logic
scattered through routes.

**4. The pick-up trigger is an event, not a phase: before the first real (non-dev) account
exists.** Register row D-053. After that point the retrofit stops being mechanical.

**5. Membership is never granted by authentication.** A verified email domain may act as a
*hint* ("your institution has an organization here — request access") but never as an
automatic grant. Joining an organization requires an invitation or creating one. This keeps
authentication and authorization independent and preserves the `Invitation` model.

## Consequences

**Positive.** No commitment to `next-auth@5.0.0-beta.31`'s adapter schema. No table that earns
nothing until someone asks for it. The Δ-branch takeover risk (18%) is mitigated by written
policy rather than by structure — which is where the risk actually lived. Decision 5 keeps
identity changes tractable, because tenant membership never depends on how someone
authenticated.

**Negative / accepted.** When SSO is eventually required, there is a migration (create the
identity table, backfill `provider='credentials'`). The oracle's Likely branch (38%) puts that
at 50–200 accounts and a weekend of work; that estimate is unverified and degrades as adoption
grows — hence the event trigger in decision 4.

**Related risk surfaced by the oracle's Wild Card branch (10%):** in the target context,
shared lab computers and intermittent connectivity may matter more than federation. That makes
D-045 (JWT sessions unrevocable, `maxAge` unset → 30-day default) materially worse than it
looks — a 30-day non-revocable session on a shared machine is a different risk than on a
personal laptop. Pin `maxAge` in Plan 1b regardless of what happens with SSO.

## Alternatives rejected

- **Separate identity table in Phase 1b.** Rejected: speculative against a beta adapter schema;
  the migration stays cheap while account count is low; and it does not by itself prevent the
  failure it was meant to prevent, which is a linking-policy failure.
- **Defer both table and policy until a pilot is named.** Rejected: leaves the Δ branch
  unmitigated. Policy decided under procurement pressure is exactly how the email-linking
  shortcut gets taken.
- **Domain-based auto-provisioning into organizations.** Rejected: makes email domain a
  tenant-assignment mechanism, requiring domain-ownership verification as a security boundary
  and exposing lookalike/subdomain spoofing. Also bypasses invitation and role assignment.

## References

- `what-if-oracle` run, 2026-08-02 (six branches; Likely 38%, Worst 18%, Contrarian 17%)
- ADR-0001 — data-access architecture
- Register: D-043 (2FA), D-044 (SSO provider), D-045 (JWT revocation), D-053 (identity table trigger)
