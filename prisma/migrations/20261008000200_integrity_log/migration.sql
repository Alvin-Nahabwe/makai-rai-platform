-- The integrity log (ADR-0010): an append-only, hash-chained record of events that must
-- stay visible after the fact. At M0 the only event is a root login at the Hetzner Cloud
-- Console, written by the PAM session hook ops/host/makrai-break-glass-session.
--
-- Three properties, each enforced here:
--   1. Append-only. A statement-level trigger refuses every UPDATE, DELETE and TRUNCATE,
--      for every role, the owner included (a superuser skips grants, not triggers).
--      Statement-level, so a statement that would touch no row is refused as well, and
--      INSERT ... ON CONFLICT DO UPDATE and MERGE fire it too.
--   2. Hash-chained. integrity_append() is the one writer. It takes an advisory lock, so
--      appends are serial, and stores each entry's hash over the previous entry's hash
--      and its own fields. Editing or removing a past row breaks every later hash, and
--      each hash is also shipped off the host in the hook's journald line. The same
--      formula is in ops/host/integrity-hash.mjs (entryHash) for the daily reconcile;
--      __tests__/integration/integrity-log.test.ts holds the two copies equal.
--   3. Invisible to the application. Neither makrai_app nor makrai_identity holds any
--      grant on the table or the function, and PUBLIC cannot execute the function.
--      Only the schema owner (POSTGRES_USER, the role the hook connects as) writes it.
--
-- The limit, stated in ADR-0010: the owner is a superuser, and a superuser can disable a
-- trigger or drop the table. Until M3 anchoring, the evidence that survives that is the
-- hashes already shipped off the host, checked against the chain.

CREATE TABLE "integrity_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "seq" BIGINT NOT NULL,
    "at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "kind" TEXT NOT NULL,
    "actor_ref" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "prev_hash" CHAR(64) NOT NULL,
    "hash" CHAR(64) NOT NULL,

    CONSTRAINT "integrity_log_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "integrity_log_seq_key" ON "integrity_log"("seq");

-- The one writer. SECURITY INVOKER (the default): it runs with the caller's rights, and
-- only the owner has any. NOT strict, so a NULL argument is refused by the NOT NULL
-- columns instead of silently appending nothing.
--
-- `at` is the wall clock after the lock is taken (clock_timestamp(), not now(), which is
-- the transaction's start and could run backwards against seq when an append waits for
-- the lock), cut to milliseconds. The hash covers `at` at millisecond precision, so the
-- stored value carries no digit the hash does not.
CREATE FUNCTION integrity_append(kind text, actor_ref text, detail jsonb)
RETURNS TABLE(id uuid, seq bigint, hash text)
LANGUAGE plpgsql
AS $$
DECLARE
  v_seq       bigint;
  v_prev_hash char(64);
  v_at        timestamptz;
  v_hash      char(64);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('integrity_log'));

  SELECT l.seq + 1, l.hash INTO v_seq, v_prev_hash
  FROM integrity_log l ORDER BY l.seq DESC LIMIT 1;
  IF NOT FOUND THEN
    v_seq := 1;
    v_prev_hash := repeat('0', 64);   -- the genesis
  END IF;

  v_at := date_trunc('milliseconds', clock_timestamp());

  -- The formula, with this entry's values in place of its columns (the parameters
  -- integrity_append.kind, .actor_ref and .detail are the columns of the same names).
  v_hash := encode(sha256(convert_to(
    v_prev_hash || '|' || v_seq || '|' ||
    to_char(v_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '|' ||
    integrity_append.kind || '|' || integrity_append.actor_ref || '|' || integrity_append.detail::text,
    'UTF8')), 'hex');

  INSERT INTO integrity_log AS l ("seq", "at", "kind", "actor_ref", "detail", "prev_hash", "hash")
  VALUES (v_seq, v_at, integrity_append.kind, integrity_append.actor_ref, integrity_append.detail, v_prev_hash, v_hash)
  RETURNING l.id INTO integrity_append.id;

  integrity_append.seq  := v_seq;
  integrity_append.hash := v_hash;
  RETURN NEXT;
END
$$;

REVOKE ALL ON FUNCTION integrity_append(text, text, jsonb) FROM PUBLIC;
-- No-ops today (neither role was ever granted either object, and the schema carries no
-- default privileges for them), stated so a grant cannot be assumed absent by accident.
REVOKE ALL ON FUNCTION integrity_append(text, text, jsonb) FROM makrai_app, makrai_identity;
REVOKE ALL ON TABLE "integrity_log" FROM PUBLIC, makrai_app, makrai_identity;

CREATE FUNCTION integrity_log_refuse_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'integrity_log is append-only: % refused', TG_OP;
END
$$;

CREATE TRIGGER "integrity_log_append_only"
BEFORE UPDATE OR DELETE OR TRUNCATE ON "integrity_log"
FOR EACH STATEMENT EXECUTE FUNCTION integrity_log_refuse_change();
