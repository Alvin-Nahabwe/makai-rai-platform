// The integrity log's entry hash, in Node (ADR-0010).
//
// The database computes the same value in integrity_append()
// (prisma/migrations/20261008000200_integrity_log/migration.sql):
//
//   encode(sha256(convert_to(prev_hash||'|'||seq||'|'||
//     to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')||'|'||
//     kind||'|'||actor_ref||'|'||detail::text,'UTF8')),'hex')
//
// The formula is written twice on purpose: the daily reconcile runs in Node and the
// append runs in PostgreSQL, and neither can call the other's code. What ties the two
// copies together is __tests__/integration/integrity-log.test.ts, "chains entries and
// matches entryHash", which recomputes every stored hash with this function.
//
// Read the row with the same renderings the database hashed: `at` through the to_char
// above (atUtc) and `detail` as detail::text (detailText). Any other rendering of
// either gives a different hash for an untouched row.
//
// Built-ins only: the reconcile imports this file inside the web image with ops/host
// mounted read-only, where nothing else is installed for it.
import { createHash } from 'node:crypto';

/**
 * @param {{ prevHash: string; seq: number; atUtc: string; kind: string; actorRef: string; detailText: string }} e
 * @returns {string} the entry's hash, 64 lowercase hex characters
 */
export function entryHash(e) {
  const text = [e.prevHash, String(e.seq), e.atUtc, e.kind, e.actorRef, e.detailText].join('|');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
