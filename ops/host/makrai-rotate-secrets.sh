#!/usr/bin/env bash
# /usr/local/sbin/makrai-rotate-secrets.sh
# Rotates the production secrets an AI-run process once held (Task 24; GAP1C-06 check), stage by
# stage, in place of a pasted runbook. Root runs it, in the owner's own key-and-code session in a
# terminal outside the Claude app. The agent runs only `precheck` and the `check-*` subcommands,
# which write nothing, inside an approval window.
#
#   makrai-rotate-secrets.sh <subcommand> [argument]
#
# Subcommand                 Runbook step      What it does
# -------------------------  ----------------  ------------------------------------------------------
# gate                       t24_gate          the timing gate alone
# precheck [--post-rollback] W1 (1.3, 1.4)     read-only: every expected value, ok or FAIL
# save-prev-a                A0                root's copy of .env (env.prev-a); records PG_STARTED
# stage-a                    A1-A5, then A6    NEXTAUTH_SECRET, the owner role, the legacy
#                                              DATABASE_URL line, makrai_app, then ONE restart of
#                                              nextjs. Start, or resume after a STOP.
# verify-a                   A6                the site, the operator's load_env, migrate status
# fix-owner                  RA-owner forward  set the owner role's password to .env's
# check-a                    W2 (3.1)          read-only post-check A
# rollback-a <key|all>       4.1, 4.2 (RA-*)   NEXTAUTH_SECRET | POSTGRES_PASSWORD |
#                                              APP_DATABASE_URL | DATABASE_URL | all
# save-prev-b                B0                root's copy for Stage B (env.prev-b); LASTOLD
# escrow-check pre|new|<file> B1, B5           a password-manager value typed at the script's own
#                                              hidden prompt must open the backup: 1 or 0, never
#                                              the value
# stage-b                    B2                BACKUP_PASSPHRASE: 64 hex from openssl rand -hex 32
# backup-chain [--fresh|--release-hold]
#                            B4-B8             hand backup; escrow proof; wait 130 s; off-site
#                                              copy; restore test; fetched= is the new file
# check-b                    W3 (3.2)          read-only post-check B
# rollback-b line|local      4.3 (RB-line,     gated; refused once 00:00 has run under the new value
#                            RB-local)
# admin-password [rollback]  A7                optional: ADMIN_PASSWORD, with its own env.prev-admin
# check-next                 W4 (3.3)          read-only: the next night's chain
# shred-prev                                   after check-next passes: shred the env.prev copies
#                                              and the staged provisioning script
#
# The last line of every subcommand is `<NAME> OK`, or `<NAME> STOP: <reason>` with a non-zero exit
# status. A check that prints a FAIL line ends in STOP.
#
# What this script guarantees (ops/host/README.md, "Rotating the production secrets (Task 24)"):
#  * No value is ever printed, logged or put in argv. Values live in shell variables and in
#    root-owned temp files in root's home, and, for the length of one command, in the environment of
#    the root-owned process that needs it (awk, or the staged provisioning script): /proc/<pid>/environ
#    is root's to read. Output is markers, counts, key names, statuses, file names and sha256
#    prefixes of files.
#  * .env is read as text (as read_env does) and never sourced by root. It is written with
#    `cat tmp > .env`, as the file's owner, after the temp file is proven complete: the owner and
#    mode survive, nothing is truncated before its source is proven readable, and sed -i is never
#    used. A symlinked .env is refused.
#  * Compose runs only from /srv/makrai/app/docker with an empty environment (env -i), so no
#    variable inherited from the shell can override --env-file.
#  * The provisioning script runs from root's own staged copy, after a sha256 check against the
#    reviewed v0.5.0 blob.
#  * Every change has a rollback that reads the old value from root's env.prev copy as text, and
#    refuses, with .env untouched, when that copy is missing or unusable.
set -Eeuo pipefail
case $- in *x*) echo 'ROTATE STOP: xtrace is on, which would print values'; exit 1 ;; esac
cd /
umask 077

# MAKRAI_ROTATE_ROOT exists for the tests, which stand a directory in for /. Cron and the owner
# never set it.
readonly R=${MAKRAI_ROTATE_ROOT:-}
[ -z "$R" ] || [[ $R == /?* && $R != */ ]] || { echo 'MAKRAI_ROTATE_ROOT must be an absolute directory other than /'; exit 2; }
readonly APP=$R/srv/makrai/app
readonly ENVF=$APP/.env
readonly COMPOSE_DIR=$APP/docker
readonly BACKUPS=$R/srv/makrai/backups
readonly LOG_BACKUP=$R/srv/makrai/backup.log
readonly LOG_OFFSITE=$R/srv/makrai/offsite-copy.log
readonly LOG_RESTORE=$R/srv/makrai/restore-test.log
readonly LOG_SYNTH=$R/var/log/makrai/synthetic.log
readonly BIN=$R/usr/local/bin
readonly SBIN=$R/usr/local/sbin
readonly RHOME=$R/root
readonly STAGE_DIR=$RHOME/makrai-stage
readonly PROV_SRC=$APP/scripts/provision-app-db-role.sh
readonly PROV=$STAGE_DIR/t24-provision-app-db-role.sh
# The reviewed blob of scripts/provision-app-db-role.sh (v0.5.0). A lint test keeps this equal to
# the file in the repository, so a change to that script cannot ship without this one.
readonly PROV_SHA256=aa8aea6818dc20a7706608842928fcf2a58b4dfc9713a61d261cccd1ea87b38c
readonly PREV_A=$RHOME/env.prev-a
readonly PREV_B=$RHOME/env.prev-b
readonly PREV_ADMIN=$RHOME/env.prev-admin
readonly STATE=$RHOME/.makrai-rotate-state
readonly SITE=https://makrai.org
readonly PG=docker-postgres-1
readonly WEB=docker-nextjs-1
readonly NIGHTLY='^makrai-[0-9]{8}-[0-9]{6}\.sql\.gz\.gpg$'
readonly JOBS_RE='[m]akrai-(backup|offsite-copy|restore-test|synthetic|auditlog|email-scan|prefix-export)'
readonly UPGRADE_RE='[b]in/unattended-upgrade( |$)|[a]pt\.systemd\.daily'
readonly NODE_CHECK="const {Client}=require('pg');(async()=>{for(const n of ['APP_DATABASE_URL','IDENTITY_DATABASE_URL']){try{const c=new Client({connectionString:process.env[n],connectionTimeoutMillis:10000});await c.connect();const {rows:[r]}=await c.query('SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');console.log(n,r.current_user,r.rolsuper,r.rolbypassrls);await c.end()}catch(e){console.log(n,'ERROR',String(e&&(e.code||e.name)).replace(/[^A-Za-z0-9_]/g,''))}}})()"
readonly PG_SETTINGS_WANT='log_min_duration_sample=-1 log_min_duration_statement=-1 log_min_error_statement=error log_statement=none log_transaction_sample_rate=0 password_encryption=scram-sha-256 shared_preload_libraries='
readonly ROLES_SQL="select string_agg(rolname, ',' order by rolname) from pg_roles where rolcanlogin"
readonly SETTINGS_SQL="select name||'='||setting from pg_settings where name in ('log_statement','log_min_duration_statement','log_min_duration_sample','log_min_error_statement','log_transaction_sample_rate','password_encryption','shared_preload_libraries') order by 1"

export LC_ALL=C
# Only the provisioning script reads this, and a stray 1 would let it accept the dev password.
unset ALLOW_DEV_DB_PASSWORD PGPASSWORD PGHOST PGUSER PGDATABASE PGSERVICE PGOPTIONS

# ---------------------------------------------------------------------------------------------
# Output, and the one place the final marker is printed.
# ---------------------------------------------------------------------------------------------
NAME=ROTATE   # the subcommand, upper-case: the marker's name
DONE=         # set by a subcommand that finished, and by nothing else
STOPMSG=      # why it stopped; never a value
CUR_TMP=      # a temp file holding an intended .env that must not outlive the run, unless kept
FAILS=0       # failed checks
NEWV=         # the value about to be written; cleared as soon as it is
INHERITED=0   # .env keys that were exported into this process
OP=           # the operator: the account that owns .env
ENVR=         # where a read that feeds a write reads .env from: the pinned descriptor, see pin_env
CUR_STEP=     # Stage A's last finished step
PGU=          # POSTGRES_USER
PGD=          # POSTGRES_DB

say() { printf '%s\n' "$*"; }
stop() { STOPMSG=$*; exit 1; }

# EXIT, not ERR: it also catches `set -u` violations and a failing `.`.
finish() {
  local rc=$?
  trap - EXIT
  trap '' HUP INT TERM
  set +e
  NEWV=
  if [ -n "$CUR_TMP" ] && [ -e "$CUR_TMP" ]; then shred -u "$CUR_TMP" 2>/dev/null || rm -f "$CUR_TMP"; fi
  if [ "$rc" -eq 0 ] && [ -n "$DONE" ]; then
    printf '%s OK\n' "$NAME"
    exit 0
  fi
  [ "$rc" -ne 0 ] || rc=1
  printf '%s STOP%s\n' "$NAME" "${STOPMSG:+: $STOPMSG}"
  exit "$rc"
}
trap finish EXIT
trap 'STOPMSG=interrupted; exit 130' HUP INT TERM

# chk LABEL ACTUAL EXPECTED-REGEX: one check line. ACTUAL is a count, a status or a name: never a value.
chk() {
  if [[ $2 =~ ^($3)$ ]]; then
    printf 'ok    %s=%s\n' "$1" "$2"
  else
    printf 'FAIL  %s=%s (expected %s)\n' "$1" "$2" "$3"
    FAILS=$((FAILS + 1))
  fi
}
info() { printf 'info  %s=%s\n' "$1" "$2"; }
verdict() { # a check run ends here: any FAIL line is a STOP and a non-zero status (T24-V7)
  [ "$FAILS" -eq 0 ] || stop "$FAILS check(s) failed"
  DONE=1
}

need_root() { [ "$(id -u)" -eq 0 ] || stop 'this script runs as root'; }

# One command that changes anything at a time: a second paste of a command must not race the first.
lock_or_stop() {
  exec 9>"$RHOME/.makrai-rotate.lock" || stop 'cannot open the lock file'
  flock -n 9 || stop 'another makrai-rotate-secrets.sh command is running'
}

need_tools() {
  local t missing=
  for t in docker openssl gpg gunzip sudo curl awk sed grep sha256sum shred install mktemp pgrep journalctl rsync stat cmp date find flock; do
    command -v "$t" >/dev/null 2>&1 || missing="$missing $t"
  done
  [ -z "$missing" ] || stop "missing from PATH:$missing"
}

# Nothing from .env may be exported into this process (T24-C1). Unset every exported variable
# the file names, and count them. The script is immune either way: Compose gets an empty environment.
scrub_env() {
  local k n=0 keys
  keys=$(sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' "$ENVF" 2>/dev/null | sort -u) || keys=
  while IFS= read -r k; do
    [ -n "$k" ] || continue
    case $k in PATH|HOME|SHELL|USER|LOGNAME|TERM|PWD|LC_ALL|LANG|TZ) continue ;; esac
    if compgen -e | grep -qxF "$k"; then n=$((n + 1)); unset "$k" 2>/dev/null || true; fi
  done <<< "$keys"
  INHERITED=$n
}

# ---------------------------------------------------------------------------------------------
# State: names and times only, never a value. One KEY=VALUE per line in root's home.
# ---------------------------------------------------------------------------------------------
state_get() { # VAR KEY; 1 when the key is not there
  local __l
  [ -f "$STATE" ] || return 1
  while IFS= read -r __l || [ -n "$__l" ]; do
    [[ $__l == "$2="* ]] || continue
    printf -v "$1" '%s' "${__l#*=}"
    return 0
  done < "$STATE"
  return 1
}
state_set() { # KEY VALUE
  local k=$1 v=$2 t
  [[ $k =~ ^[A-Z][A-Z0-9_]*$ && $v =~ ^[A-Za-z0-9._:+,-]*$ ]] || { say "state: refused to record $k"; return 1; }
  t=$(mktemp "$RHOME/.makrai-rotate-state.XXXXXX") || return 1
  { if [ -f "$STATE" ]; then grep -v "^$k=" "$STATE" || true; fi; printf '%s=%s\n' "$k" "$v"; } > "$t" && mv -f "$t" "$STATE"
}
state_del() { # KEY...
  local k t
  [ -f "$STATE" ] || return 0
  for k in "$@"; do
    t=$(mktemp "$RHOME/.makrai-rotate-state.XXXXXX") || return 1
    { grep -v "^$k=" "$STATE" || true; } > "$t" && mv -f "$t" "$STATE"
  done
}

# ---------------------------------------------------------------------------------------------
# Reading .env as text (read_env's rules: the last line wins, surrounding quotes go, and from an
# unquoted value a trailing ` # comment`). Builtins only. Nothing is evaluated.
#   envget  VAR KEY [FILE]   the value, quotes removed
#   envraw  VAR KEY [FILE]   everything after KEY=, quotes kept (to put a line back exactly)
# Return 0 found, 1 the key is absent, 2 the file is missing, a symlink or unreadable. A missing or
# unreadable file is never read as "the key is absent" (T24-V1).
# ---------------------------------------------------------------------------------------------
envget() {
  local __l __v __f= __file=${3:-$ENVF}
  [ -f "$__file" ] && [ -r "$__file" ] && [ ! -L "$__file" ] || return 2
  while IFS= read -r __l || [ -n "$__l" ]; do
    __l=${__l%$'\r'}
    [[ $__l == "$2="* ]] || continue
    __v=${__l#*=}; __f=1
    case $__v in \"*\" | \'*\') __v=${__v:1:${#__v}-2} ;; *) __v=${__v%%[[:space:]]#*} ;; esac
  done < "$__file"
  [ -n "$__f" ] || return 1
  printf -v "$1" '%s' "$__v"
}
envraw() {
  local __l __v __f= __file=${3:-$ENVF}
  [ -f "$__file" ] && [ -r "$__file" ] && [ ! -L "$__file" ] || return 2
  while IFS= read -r __l || [ -n "$__l" ]; do
    __l=${__l%$'\r'}
    [[ $__l == "$2="* ]] && { __v=${__l#*=}; __f=1; }
  done < "$__file"
  [ -n "$__f" ] || return 1
  printf -v "$1" '%s' "$__v"
}
# count_existing PATH...: how many of the paths exist (a glob that matched nothing counts for none)
count_existing() {
  local n=0 f
  for f in "$@"; do if [ -e "$f" ] || [ -L "$f" ]; then n=$((n + 1)); fi; done
  echo "$n"
}
nlines() { local n; n=$(grep -c "^$1=" "${2:-$ENVF}" 2>/dev/null || true); echo "${n:-0}"; }
nquoted() { local n; n=$(grep -c "^$1=[\"']" "${2:-$ENVF}" 2>/dev/null || true); echo "${n:-0}"; }

# POSTGRES_USER and POSTGRES_DB, validated: they reach docker's argv and SQL.
read_ud() {
  envget PGU POSTGRES_USER && envget PGD POSTGRES_DB \
    && [[ $PGU =~ ^[a-z_][a-z0-9_]*$ && $PGD =~ ^[A-Za-z0-9_]+$ ]]
}

# appw VAR URL: the makrai_app password inside URL, percent-decoded as pg does.
appw() {
  local __w=${2#postgresql://makrai_app:}
  __w=${__w%%@*}
  [[ $__w == *%* ]] && printf -v __w '%b' "${__w//%/\\x}"
  printf -v "$1" '%s' "$__w"
}

# keydiff OLD NEW: key names only. CHANGED / ADDED / REMOVED, and a count of the SAME keys.
keydiff() {
  awk 'NR==FNR { if (match($0, /^[A-Za-z_][A-Za-z0-9_]*=/)) a[substr($0, 1, RLENGTH-1)] = substr($0, RLENGTH+1); next }
    { if (match($0, /^[A-Za-z_][A-Za-z0-9_]*=/)) b[substr($0, 1, RLENGTH-1)] = substr($0, RLENGTH+1) }
    END { s = 0; for (k in a) { if (!(k in b)) print "REMOVED " k; else if (a[k] != b[k]) print "CHANGED " k; else s++ }
          for (k in b) if (!(k in a)) print "ADDED " k; print "SAME-count " s }' "$1" "$2" | sort
}

# prev_ok FILE: an env.prev copy that is safe to restore from. A missing, unreadable, symlinked,
# empty or implausible copy is refused before anything is written (T24-V1).
prev_ok() {
  if [ -f "$1" ] && [ -r "$1" ] && [ ! -L "$1" ] && [ -s "$1" ] && grep -q '^POSTGRES_USER=' "$1"; then return 0; fi
  say "restore source $1 is missing, unreadable or not an .env copy; nothing written"
  return 1
}

# ---------------------------------------------------------------------------------------------
# Writing .env. The value is in NEWV (never exported, never in argv). It reaches awk through its
# environment and is written to a root-owned temp file in root's home; only a temp file proven
# complete is copied over .env, by the file's owner (T24-V15), so the inode, owner and mode stay.
# ---------------------------------------------------------------------------------------------
# pin_env: open .env once, and check what was opened rather than the path (descriptor 8, which is
# then ENVR). The checkout is the operator's to write, so the path can be swapped for a symlink at any
# moment (T22-3). A read that fed a write through the path could then copy a root-only file into the
# file the operator reads. Through the descriptor it reads the inode that was checked, whatever the
# path becomes. Writes need no such care: they are made as the file's owner.
pin_env() {
  if ! { exec 8<"$ENVF"; } 2>/dev/null; then return 1; fi
  ENVR=/proc/$$/fd/8
  [ "$(stat -L -c '%F:%U' "$ENVR" 2>/dev/null)" = "regular file:$OP" ]
}

env_target() {
  if [ -f "$ENVF" ] && [ ! -L "$ENVF" ] && [ -r "$ENVF" ]; then
    OP=$(stat -c %U "$ENVF") || OP=
    if [[ $OP =~ ^[a-z_][a-z0-9_-]*$ && $OP != root ]]; then
      pin_env && return 0
      say 'env: .env changed while it was opened; nothing written'
      return 1
    fi
  fi
  say 'env: .env is not a regular, unlinked file owned by the operator; nothing written'
  return 1
}

# discard_tmp: shred the intended-file temp file, unless a failed write is keeping it.
discard_tmp() {
  if [ -n "$CUR_TMP" ] && [ -e "$CUR_TMP" ]; then shred -u "$CUR_TMP" 2>/dev/null || rm -f "$CUR_TMP"; fi
  CUR_TMP=
}

# write_env SOURCE [disposable]: replace .env's content with SOURCE's, as .env's owner (so a symlink
# swapped in at the last moment gains nothing). SOURCE must be non-empty, and its open fails the
# command before .env is touched (T24-V2). A disposable SOURCE is a temp file this run made; a
# failure keeps it and says how to finish. A SOURCE that is an env.prev copy is never offered for shredding.
write_env() {
  local t=$1 rc=0
  [ -s "$t" ] && [ ! -L "$t" ] || { say 'env: the intended file is missing or empty; nothing written'; return 1; }
  # A signal in the middle of the copy would leave .env half-written and run the exit handler, which
  # shreds the temp file: the one complete copy. So the copy, which is over in milliseconds, is not
  # interrupted; the signal is dropped, and the next one is heard.
  trap '' HUP INT TERM
  sudo -u "$OP" sh -c 'cat > "$1"' sh "$ENVF" < "$t" || rc=$?
  trap 'STOPMSG=interrupted; exit 130' HUP INT TERM
  if [ "$rc" -eq 0 ] && cmp -s "$t" "$ENVF"; then return 0; fi
  CUR_TMP=
  say "env: WRITE FAILED. .env may be partial; the intended file is kept in $t"
  if [ -n "${2:-}" ]; then
    say "env: free space, then: test -s $t && sudo -u $OP sh -c 'cat > \"\$1\"' sh $ENVF < $t && shred -u $t"
  else
    say "env: free space, then run rollback-a all again."
  fi
  return 1
}

# put_key KEY: set KEY to $NEWV: every KEY= line becomes one line at the first one's place, or a
# line is appended. Prints nothing but errors. NEWV is cleared on every path.
put_key() {
  local k=$1 t
  [[ $k =~ ^[A-Z_][A-Z0-9_]*$ ]] || { say 'put: bad key'; NEWV=; return 1; }
  env_target || { NEWV=; return 1; }
  t=$(mktemp "$RHOME/.t24-env.XXXXXX") || { say 'put: no temp file; nothing written'; NEWV=; return 1; }
  CUR_TMP=$t
  if ! V="$NEWV" awk -v k="$k" 'index($0, k "=") == 1 { if (!d) print k "=" ENVIRON["V"]; d = 1; next } { print } END { if (!d) print k "=" ENVIRON["V"] }' "$ENVR" > "$t"; then
    say 'put: awk failed; nothing written'; NEWV=; discard_tmp; return 1
  fi
  # Proven complete: the new line once and exactly, every other line unchanged, nothing else.
  if ! V="$NEWV" awk -v k="$k" 'index($0, k "=") == 1 { n++; if ($0 != k "=" ENVIRON["V"]) bad = 1 } END { exit !(n == 1 && !bad) }' "$t" \
     || ! cmp -s <(grep -v "^$k=" "$ENVR" || true) <(grep -v "^$k=" "$t" || true); then
    say 'put: the intended file did not verify; nothing written'; NEWV=; discard_tmp; return 1
  fi
  NEWV=
  write_env "$t" disposable || return 1
  discard_tmp
}

# drop_key KEY: remove every KEY= line.
drop_key() {
  local k=$1 t
  [[ $k =~ ^[A-Z_][A-Z0-9_]*$ ]] || { say 'drop: bad key'; return 1; }
  env_target || return 1
  t=$(mktemp "$RHOME/.t24-env.XXXXXX") || { say 'drop: no temp file; nothing written'; return 1; }
  CUR_TMP=$t
  grep -v "^$k=" "$ENVR" > "$t" || [ $? -eq 1 ] || { say 'drop: grep failed; nothing written'; discard_tmp; return 1; }
  if [ "$(nlines "$k" "$t")" != 0 ] || ! cmp -s <(grep -v "^$k=" "$ENVR" || true) "$t"; then
    say 'drop: the intended file did not verify; nothing written'; discard_tmp; return 1
  fi
  write_env "$t" disposable || return 1
  discard_tmp
}

# gen_put KEY: a new 64-hex value from openssl, never shown. An empty or malformed one is refused.
gen_put() {
  local v rc=0
  v=$(openssl rand -hex 32) && [[ $v =~ ^[0-9a-f]{64}$ ]] || { v=; say "$1: no value generated; nothing written"; return 1; }
  NEWV=$v; v=
  put_key "$1" || rc=$?
  NEWV=
  return "$rc"
}

# restore_key KEY FILE: put KEY's line back exactly as FILE (an env.prev copy) has it; remove it if
# FILE has none. Refuses a missing or unusable FILE first (T24-V1).
restore_key() {
  local key=$1 f=$2 v rc=0
  prev_ok "$f" || return 1
  envraw v "$key" "$f" || rc=$?
  case $rc in
    0) NEWV=$v; v=; rc=0; put_key "$key" || rc=$?; NEWV=; return "$rc" ;;
    1) drop_key "$key" ;;
    *) say "restore: $f is unreadable; nothing written"; return 1 ;;
  esac
}

# ---------------------------------------------------------------------------------------------
# The database. Every helper sets the database to what .env (or FILE) holds, so "put the line back,
# then run the helper" always converges, whatever the database holds now.
# ---------------------------------------------------------------------------------------------

# owner_alter [FILE]: the owner role's password := POSTGRES_PASSWORD as FILE holds it. The statement
# block of scripts/provision-app-db-role.sh: statement logging off for the session, -X, terse
# errors, the value escaped for \set and quoted by psql (:'pw'), all on stdin. Prints a marker only.
owner_alter() {
  local f=${1:-$ENVF} p esc rc=0
  if ! { read_ud && envget p POSTGRES_PASSWORD "$f" && [ -n "$p" ]; }; then
    p=; say 'OWNER-ALTER STOP: a value is missing or malformed; nothing sent'; return 1
  fi
  esc=${p//\\/\\\\}; esc=${esc//\'/\\\'}; p=
  printf '%s\n' 'SET log_min_error_statement = panic;' "SET log_statement = 'none';" \
    'SET log_min_duration_statement = -1;' 'SET log_min_duration_sample = -1;' 'SET log_transaction_sample_rate = 0;' \
    'SET debug_print_parse = off;' 'SET debug_print_rewritten = off;' 'SET debug_print_plan = off;' \
    '\set VERBOSITY terse' "\\set pw '$esc'" "ALTER ROLE \"$PGU\" WITH PASSWORD :'pw';" \
    | docker exec -i "$PG" psql -X -q -v ON_ERROR_STOP=1 -U "$PGU" -d "$PGD" >/dev/null 2>&1 || rc=$?
  esc=
  if [ "$rc" -eq 0 ]; then say 'OWNER-ALTER OK'; else say "OWNER-ALTER FAILED (psql exit $rc)"; fi
  return "$rc"
}

# stage_provision: root's own copy of the provisioning script, checked against the reviewed hash.
# It runs as root, and the checkout is the operator's to write.
stage_provision() {
  install -d -m 0700 "$STAGE_DIR" || { say 'PROVISION STOP: cannot create the stage directory'; return 1; }
  if [ ! -f "$PROV_SRC" ] || [ -L "$PROV_SRC" ]; then say 'PROVISION STOP: the checkout has no regular provision script'; return 1; fi
  install -m 0700 "$PROV_SRC" "$PROV" || { say 'PROVISION STOP: cannot stage the provision script'; return 1; }
  if ! printf '%s  %s\n' "$PROV_SHA256" "$PROV" | sha256sum -c --strict >/dev/null 2>&1; then
    rm -f "$PROV"
    say 'PROVISION STOP: the checkout copy differs from the reviewed commit (sha256); not run'
    return 1
  fi
  say "provision script staged, sha256 ${PROV_SHA256:0:12}"
}

# app_provision [FILE]: makrai_app's password := the one inside APP_DATABASE_URL as FILE holds it,
# with the staged, hash-checked provisioning script. A percent-encoded old password is decoded.
app_provision() {
  local f=${1:-$ENVF} url pw rc=0
  if ! { read_ud && envget url APP_DATABASE_URL "$f" && [[ $url == postgresql://makrai_app:?*@* ]]; }; then
    url=; say 'APP-PROVISION STOP: a value is missing or malformed; nothing sent'; return 1
  fi
  pw=${url#postgresql://makrai_app:}; pw=${pw%%@*}; url=
  [[ $pw == *%* ]] && printf -v pw '%b' "${pw//%/\\x}"
  [ -n "$pw" ] || { say 'APP-PROVISION STOP: empty password; nothing sent'; return 1; }
  stage_provision >/dev/null || { pw=; say 'APP-PROVISION STOP: the provision script is not the reviewed one; nothing sent'; return 1; }
  APP_DB_PASSWORD="$pw" PSQL_CMD="docker exec -i $PG psql -U $PGU" "$PROV" "$PGD" makrai_app >/dev/null 2>&1 || rc=$?
  pw=
  if [ "$rc" -eq 0 ]; then say 'APP-PROVISION OK'; else say "APP-PROVISION FAILED (exit $rc)"; fi
  return "$rc"
}

# new_app_url: a new makrai_app password inside an APP_DATABASE_URL built from known parts, unquoted
# (the identity line's form), never from the old line (T24-C3).
new_app_url() {
  local p rc=0
  read_ud || { say 'APP-URL STOP: POSTGRES_DB'; return 1; }
  p=$(openssl rand -hex 32) && [[ $p =~ ^[0-9a-f]{64}$ ]] || { p=; say 'APP-URL STOP: no value generated'; return 1; }
  NEWV="postgresql://makrai_app:$p@postgres:5432/$PGD"; p=
  put_key APP_DATABASE_URL || rc=$?
  NEWV=
  return "$rc"
}

# tcp_any ROLE DB: is the password on stdin accepted for ROLE over TCP, past the trusted socket
# (pg_hba "host all all all scram-sha-256")? Tried by the service name, then by the container's own
# address; ACCEPTED if either is. REFUSED means both refused, so an old value shown REFUSED is
# refused on the scram line and not merely on one name.
tcp_any() {
  local pw r= host
  IFS= read -r pw || true
  for host in postgres ip; do
    r=$(printf '%s\n' "$pw" | docker exec -i "$PG" sh -c 'IFS= read -r PGPASSWORD; export PGPASSWORD; h=$3; [ "$h" = ip ] && h=$(hostname -i | cut -d" " -f1); psql -X -w -h "$h" -U "$1" -d "$2" -Atc "select 1" >/dev/null 2>&1 && echo ACCEPTED || echo REFUSED' sh "$1" "$2" "$host" 2>/dev/null) || r=
    [ "$r" != ACCEPTED ] || break
  done
  pw=
  echo "${r:-REFUSED}"
}

# ---------------------------------------------------------------------------------------------
# Compose, containers and the operator's jobs.
# ---------------------------------------------------------------------------------------------

# Compose from /srv/makrai/app/docker, with an empty environment, so no shell variable can override
# --env-file (T24-C1) and the relative paths always resolve (T24-I4).
compose() { ( cd "$COMPOSE_DIR" && env -i PATH="$PATH" HOME="$RHOME" docker compose --env-file ../.env -f docker-compose.prod.yml "$@" ); }

# redact: whatever Compose or another tool prints passes through this, so a value an error message
# quotes (a parse error can) is not shown. Values here are 64 hex or longer; names and statuses are shorter.
redact() { sed -E 's/[A-Za-z0-9+\/=]{32,}/<redacted>/g'; }

# cv CONTAINER KEY: the value in the container's configuration. Captured and compared, never printed.
cv() { docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null | sed -n "s/^$2=//p" | tail -n 1; }
cnames() { docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null | cut -d= -f1; }

# vs_container CONTAINER KEY [FILE]: SAME when the container's value equals the file's, else DIFFERENT.
vs_container() {
  local f c
  envget f "$2" "${3:-$ENVF}" || f=
  c=$(cv "$1" "$2") || c=
  if [ -n "$f" ] && [ "$f" = "$c" ]; then echo SAME; else echo DIFFERENT; fi
}

# The operator's jobs can still source .env (backup, off-site copy, restore test). Errors are not
# shown: a sourcing error can quote part of a value. Non-zero when it failed (T24-V7).
opcheck() {
  sudo -u "$OP" bash -c '. "$1"; load_env; echo OPERATOR-LOAD-ENV OK' bash "$BIN/makrai-lib.sh" 2>/dev/null \
    || { say 'OPERATOR-LOAD-ENV FAILED'; return 1; }
}

health_ok() { # the site answers {"status":"ok"}, with a few tries: a restart takes a moment
  local i h
  for i in 1 2 3 4 5 6; do
    h=$(curl -s --max-time 20 "$SITE/api/health") || h=
    [ "$h" != '{"status":"ok"}' ] || return 0
    sleep 5
  done
  return 1
}

# ---------------------------------------------------------------------------------------------
# The timing gate. A .env write must not overlap a job that reads .env, or a package upgrade that
# can replace docker; the nightly chain and the 03:30 reboot are kept clear.
# ---------------------------------------------------------------------------------------------
gate_check() {
  local h m n u
  h=$(date -u +%H); m=$(date -u +%M); h=$((10#$h)); m=$((10#$m))
  n=$(pgrep -fc "$JOBS_RE" || true); n=${n:-0}
  u=$(pgrep -fc "$UPGRADE_RE" || true); u=${u:-0}
  say "now $(date -u +%H:%M)Z, scheduled jobs running: $n, package upgrades running: $u"
  [ "$n" -eq 0 ] || { say 'GATE: a scheduled job is running; wait for it'; return 1; }
  [ "$u" -eq 0 ] || { say 'GATE: a package upgrade is running; wait for it'; return 1; }
  [ "$m" -ge 15 ] && [ "$m" -le 50 ] || { say 'GATE: start only between hh:15 and hh:50'; return 1; }
  case $h in 6|22|23|0|1|2|3) say 'GATE: not in the hours 06, 22, 23, 00, 01, 02, 03 UTC'; return 1 ;; esac
  say 'gate: open'
}

# ---------------------------------------------------------------------------------------------
# Backups: names and log lines only.
# ---------------------------------------------------------------------------------------------
newest_backup() { # the newest makrai-*.sql.gz.gpg by modification time, name only
  { find "$BACKUPS" -maxdepth 1 -name 'makrai-*.sql.gz.gpg' -printf '%T@ %f\n' 2>/dev/null || true; } | sort -n | tail -n 1 | cut -d' ' -f2
}
loglines() { local n; n=$(wc -l < "$1" 2>/dev/null) || n=0; echo "${n:-0}"; }
logsince() { tail -n +"$(($2 + 1))" "$1" 2>/dev/null || true; } # LOG OFFSET: what a run appended
count_re() { local n; n=$(grep -cE "$1" || true); echo "${n:-0}"; } # reads stdin
last_fetched() { grep -o 'fetched=[^ ]*' "$1" 2>/dev/null | tail -n 1 || true; }

# decrypts_ok PROMPT FILE: prints 1 when the passphrase typed at the hidden prompt opens FILE (a name
# in the backups directory) to a complete dump, else 0. The value is read by `read`, handed to gpg on
# file descriptor 3, and never printed.
decrypts_ok() {
  local pp n
  printf '%s (hidden): ' "$1" >&2
  IFS= read -rs pp || true
  echo >&2
  if [ -z "$pp" ]; then echo 0; return 0; fi
  n=$(gpg --batch --quiet --no-symkey-cache --decrypt --passphrase-fd 3 "$BACKUPS/$2" 3<<<"$pp" 2>/dev/null | gunzip -c 2>/dev/null | tail -20 | grep -c 'PostgreSQL database dump complete' || true)
  pp=
  echo "${n:-0}"
}

# ---------------------------------------------------------------------------------------------
# Shared checks: the facts about .env and the stack that the pre-check and the post-checks read.
# ---------------------------------------------------------------------------------------------
site_checks() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$SITE/login") || code=000
  chk login "$code" 200
  chk health "$(curl -s --max-time 20 "$SITE/api/health" || true)" '\{"status":"ok"\}'
}

env_file_checks() { # the file itself: a regular file, mode 600, the operator's
  chk env_stat "$(stat -c '%a %F' "$ENVF")" '600 regular file'
  chk env_symlink "$([ -L "$ENVF" ] && echo yes || echo no)" no
  info env_owner "$OP"
}

ud_checks() {
  chk prefixed_or_indented "$(grep -cE '^[[:space:]]*export[[:space:]]|^[[:space:]]+[A-Za-z_][A-Za-z0-9_]*=' "$ENVF" || true)" 0
  chk names_ok "$(read_ud && echo yes || echo no)" yes
}

inspect_line() { # CONTAINER: sets INSPECT_STATE ("running healthy restarts=0") and STARTED
  local l
  l=$(docker inspect -f '{{.Name}} {{.State.Status}} {{.State.Health.Status}} started={{.State.StartedAt}} restarts={{.RestartCount}}' "$1" 2>/dev/null) || l=
  STARTED=${l##*started=}; STARTED=${STARTED%% *}
  set -- $l
  INSPECT_STATE="${2:-missing} ${3:-none} ${5:-restarts=?}"
}

# The per-URL check, inside the web container: roles and booleans, or an error code. Exactly two lines.
url_checks() {
  local lines=() l
  mapfile -t lines < <(docker exec "$WEB" node -e "$NODE_CHECK" 2>&1 | redact || true)
  chk url_lines "${#lines[@]}" 2
  for l in "${lines[@]}"; do
    case $l in
      'APP_DATABASE_URL '*) chk url_app "$l" 'APP_DATABASE_URL makrai_app false false' ;;
      'IDENTITY_DATABASE_URL '*) chk url_identity "$l" 'IDENTITY_DATABASE_URL makrai_identity false false' ;;
      *) chk url_other '<unrecognised line>' none ;;
    esac
  done
}

tools_and_session() {
  chk tz "$(date +%Z)" UTC
  info inherited_env_keys_unset "$INHERITED"
}

names_join() { printf '%s\n' "$@" | sort | paste -sd, -; }

# The patterns a leak scan searches for, one per line, to a process substitution only.
pats_a() { local v; envget v NEXTAUTH_SECRET && printf '%s\n' "$v"; envget v POSTGRES_PASSWORD && printf '%s\n' "$v"; envget v APP_DATABASE_URL && { appw v "$v"; printf '%s\n' "$v"; }; }
pats_b() { local v; envget v BACKUP_PASSPHRASE && printf '%s\n' "$v"; }

home_of() { getent passwd "$1" | cut -d: -f6; }

# leak_scan PATTERNS MIN-LENGTH SINCE EXPECTED-COUNT: the new values must be in no journal entry since
# SINCE (an absolute UTC time), no job log and no shell history. A pattern shorter than MIN-LENGTH
# would match everywhere, so the scan then fails rather than reports a number.
leak_scan() {
  local pf=$1 minlen=$2 since=$3 want=$4 np short j l h ph
  np=$({ "$pf" || true; } | wc -l)
  short=$({ "$pf" || true; } | awk -v m="$minlen" 'length($0) < m' | wc -l)
  chk leak_patterns "$np" "$want"
  chk leak_short "$short" 0
  if [ "$np" -ne "$want" ] || [ "$short" -ne 0 ]; then
    printf 'FAIL  leak_scan not run: the patterns are missing or too short to search for\n'
    FAILS=$((FAILS + 1))
    return 0
  fi
  j=$(journalctl --since "$since UTC" -o cat 2>/dev/null | grep -cFf <("$pf") || true)
  l=$(cat "$R"/srv/makrai/*.log "$R"/var/log/makrai/*.log 2>/dev/null | grep -cFf <("$pf") || true)
  ph=$(home_of "$OP" || true)
  h=$(cat "$RHOME/.bash_history" ${ph:+"$ph/.bash_history"} 2>/dev/null | grep -cFf <("$pf") || true)
  chk leak_journal "${j:-0}" 0
  chk leak_logs "${l:-0}" 0
  chk leak_history "${h:-0}" 0
}

# ---------------------------------------------------------------------------------------------
# gate
# ---------------------------------------------------------------------------------------------
cmd_gate() {
  gate_check || stop 'the gate is closed'
  DONE=1
}

# ---------------------------------------------------------------------------------------------
# precheck (W1): read-only. Every line is ok or FAIL, against the runbook's expected values.
# ---------------------------------------------------------------------------------------------

# The host scripts that name DATABASE_URL on its own (not APP_ or IDENTITY_), except this one.
legacy_host_readers() {
  local f n=0
  for f in "$BIN"/makrai-*.sh "$SBIN"/makrai-*.sh; do
    [ -f "$f" ] || continue
    [ "${f##*/}" != makrai-rotate-secrets.sh ] || continue
    if grep -qE '(^|[^A-Za-z0-9_])DATABASE_URL([^A-Za-z0-9_]|$)' "$f"; then n=$((n + 1)); fi
  done
  echo "$n"
}

# The legacy DATABASE_URL line is removed only if nothing reads it and it names the owner role with
# POSTGRES_PASSWORD; otherwise STOP, because removing it would leave a working credential in force or
# break a reader (T24-V10). Sets LEGACY_OK (1 when there is no line, or the line may go).
legacy_report() {
  local n lv pw lu= lp= dec
  n=$(nlines DATABASE_URL)
  LEGACY_OK=1
  if [ "$n" -eq 0 ]; then info legacy_url absent; return 0; fi
  chk legacy_url_lines "$n" 1
  [ "$n" -eq 1 ] || { LEGACY_OK=0; return 0; }
  envget lv DATABASE_URL || lv=
  envget pw POSTGRES_PASSWORD || pw=
  if [[ $lv =~ ^postgres(ql)?://([^:@/]+):([^@]*)@ ]]; then lu=${BASH_REMATCH[2]}; lp=${BASH_REMATCH[3]}; fi
  lv=
  dec=$lp
  [[ $dec == *%* ]] && printf -v dec '%b' "${dec//%/\\x}"
  chk legacy_url_user_is_owner "$([ -n "$lu" ] && [ "$lu" = "$PGU" ] && echo SAME || echo DIFFERENT)" SAME
  chk legacy_pw_is_owner_pw "$([ -n "$pw" ] && { [ "$lp" = "$pw" ] || [ "$dec" = "$pw" ]; } && echo SAME || echo DIFFERENT)" SAME
  [ -n "$lu" ] && [ "$lu" = "$PGU" ] && [ -n "$pw" ] && { [ "$lp" = "$pw" ] || [ "$dec" = "$pw" ]; } || LEGACY_OK=0
  lp=; dec=; pw=
  n=$(cnames "$WEB" | grep -cx DATABASE_URL || true)
  chk legacy_url_in_web_container "${n:-0}" 0
  [ "${n:-0}" -eq 0 ] || LEGACY_OK=0
  n=$(grep -cE '\$\{?DATABASE_URL' "$COMPOSE_DIR/docker-compose.prod.yml" || true)
  chk legacy_url_interpolated_by_compose "${n:-0}" 0
  [ "${n:-0}" -eq 0 ] || LEGACY_OK=0
  n=$(legacy_host_readers)
  chk legacy_url_read_by_host_scripts "$n" 0
  [ "$n" -eq 0 ] || LEGACY_OK=0
}

# APP_DATABASE_URL: one line, the shape this script rebuilds from known parts. Sets APP_URL_OK.
app_url_report() {
  local a tl
  chk key_APP_DATABASE_URL_lines "$(nlines APP_DATABASE_URL)" 1
  info key_APP_DATABASE_URL_quoted "$(nquoted APP_DATABASE_URL)"
  APP_URL_OK=0
  if envget a APP_DATABASE_URL && [[ $a == postgresql://makrai_app:?*@* ]]; then
    tl=${a#*@}
    chk app_url_tail_is_postgres_5432_db "$([ "$tl" = "postgres:5432/$PGD" ] && echo SAME || echo DIFFERENT)" SAME
    info app_pw_percent "$([[ ${a%%@*} == *%* ]] && echo 1 || echo 0)"
    [ "$tl" != "postgres:5432/$PGD" ] || APP_URL_OK=1
  else
    chk app_url BAD-SHAPE ok
  fi
  a=
}

cmd_precheck() {
  local post= k n u st l1 want
  case "${1:-}" in --post-rollback) post=1 ;; '') ;; *) stop 'usage: precheck [--post-rollback]' ;; esac
  need_root; need_tools
  env_target || stop '.env is not a regular file owned by the operator'
  scrub_env
  tools_and_session
  info now "$(date -u +%FT%TZ)"
  site_checks
  chk restore_last_passed "$(tail -n 1 "$LOG_RESTORE" 2>/dev/null | count_re 'Restore test PASSED')" 1
  chk backup_tail "$(tail -n 2 "$LOG_BACKUP" 2>/dev/null | count_re '(watchdog pinged|Backup complete\.)$')" 2
  chk offsite_pinged "$(tail -n 2 "$LOG_OFFSITE" 2>/dev/null | count_re 'watchdog pinged')" 1
  n=$(newest_backup)
  chk newest_backup_is_from_today "$([ "${n:7:8}" = "$(date -u +%Y%m%d)" ] && echo yes || echo no)" yes
  info newest_backup "${n:-none}"
  l1=$(tail -n 1 "$LOG_SYNTH" 2>/dev/null | grep -oE 'result=[a-z]+ at=[0-9TZ:-]+' || true)
  chk synthetic_last_result "${l1%% *}" 'result=pass'
  info synthetic_last "${l1:-none}"
  chk jobs_running "$(pgrep -fc "$JOBS_RE" || true)" 0
  chk checkout_dirty "$(sudo -u "$OP" git -C "$APP" status --porcelain 2>/dev/null | wc -l)" 0
  info checkout_tag "$(sudo -u "$OP" git -C "$APP" describe --tags --exact-match 2>/dev/null || echo none)"
  chk provision_sha256_is_the_reviewed_one "$([ -f "$PROV_SRC" ] && [ "$(sha256sum < "$PROV_SRC" | cut -d' ' -f1)" = "$PROV_SHA256" ] && echo yes || echo no)" yes
  info lib_sha256_prefix "$(sha256sum < "$BIN/makrai-lib.sh" 2>/dev/null | cut -c1-12)"
  env_file_checks
  chk leftovers "$(count_existing "$APP/.env.new" "$RHOME"/.t24-env.*)" 0
  info env_prev_files "$(count_existing "$PREV_A" "$PREV_B" "$PREV_ADMIN" "$PROV")"
  chk free_MB_root "$(df --output=avail -BM "$RHOME" | tail -n 1 | tr -dc 0-9)" '[1-9][0-9]{2,}'
  chk free_MB_srv "$(df --output=avail -BM "$R/srv/makrai" | tail -n 1 | tr -dc 0-9)" '[1-9][0-9]{2,}'
  for k in NEXTAUTH_SECRET POSTGRES_USER POSTGRES_DB POSTGRES_PASSWORD IDENTITY_DATABASE_URL BACKUP_PASSPHRASE; do
    chk "key_${k}_lines" "$(nlines "$k")" 1
  done
  for k in DATABASE_URL ADMIN_PASSWORD; do chk "key_${k}_lines" "$(nlines "$k")" '[01]'; done
  chk key_IDENTITY_DATABASE_URL_quoted "$(nquoted IDENTITY_DATABASE_URL)" 0
  ud_checks
  if read_ud; then
    app_url_report
    legacy_report
    want=$(printf '%s\n' "$PGU" makrai_app makrai_identity | sort | paste -sd, -)
    chk login_roles "$(docker exec "$PG" psql -X -U "$PGU" -d "$PGD" -Atc "$ROLES_SQL" 2>/dev/null | tr ',' '\n' | sort | paste -sd, - || true)" "$want"
  fi
  chk identity_shape "$(grep -cE '^IDENTITY_DATABASE_URL=postgresql://makrai_identity:[0-9a-f]{64}@postgres:5432/[A-Za-z0-9_]+$' "$ENVF" || true)" 1
  chk operator_load_env "$(opcheck >/dev/null && echo ok || echo failed)" ok
  for k in NEXTAUTH_SECRET APP_DATABASE_URL IDENTITY_DATABASE_URL; do chk "nextjs_vs_env_$k" "$(vs_container "$WEB" "$k")" SAME; done
  if [ -n "$post" ]; then
    info postgres_vs_env_POSTGRES_PASSWORD "$(vs_container "$PG" POSTGRES_PASSWORD) (after a rollback that left the owner role rotated, DIFFERENT is expected)"
  else
    chk postgres_vs_env_POSTGRES_PASSWORD "$(vs_container "$PG" POSTGRES_PASSWORD)" SAME
  fi
  chk nextjs_DATABASE_URL "$(cnames "$WEB" | grep -cx DATABASE_URL || true)" 0
  for k in "$WEB" "$PG"; do
    inspect_line "$k"
    chk "inspect_${k}" "$INSPECT_STATE" 'running healthy restarts=0'
    [ "$k" != "$PG" ] || info PG_STARTED "$STARTED"
  done
  chk pg_settings "$(docker exec "$PG" psql -X -U "$PGU" -d "$PGD" -Atc "$SETTINGS_SQL" 2>/dev/null | tr '\n' ' ' | sed 's/ $//' || true)" "$PG_SETTINGS_WANT"
  chk hba_scram_all "$(docker exec "$PG" sh -c 'grep -cE "^host[[:space:]]+all[[:space:]]+all[[:space:]]+all[[:space:]]+scram-sha-256" "$PGDATA/pg_hba.conf"' 2>/dev/null || true)" 1
  if read_ud; then
    envget u POSTGRES_PASSWORD || u=
    chk tcp_owner_env "$(printf '%s\n' "$u" | tcp_any "$PGU" "$PGD")" ACCEPTED
    envget u APP_DATABASE_URL || u=
    appw u "$u"
    chk tcp_makrai_app_env "$(printf '%s\n' "$u" | tcp_any makrai_app "$PGD")" ACCEPTED
    u=
  fi
  url_checks
  verdict
}

# ---------------------------------------------------------------------------------------------
# save-prev-a (A0)
# ---------------------------------------------------------------------------------------------
# save_prev DEST: root's copy of .env, never overwritten. An existing copy equal to .env is current;
# any other is stale and may hold the only copy of the old values (T24-M3).
save_prev() {
  local dest=$1
  env_target || return 1
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    if [ -f "$dest" ] && [ ! -L "$dest" ] && cmp -s "$ENVR" "$dest"; then
      say "PREV-CURRENT: $dest already equals .env; keeping it"
      return 0
    fi
    say "PREV-STALE: $dest exists and differs from .env. It may hold the only copy of the old values: never overwritten. Stop and ask."
    return 1
  fi
  install -d -m 0700 "$RHOME" 2>/dev/null || true
  install -m 600 "$ENVR" "$dest" && cmp -s "$ENVR" "$dest" || { rm -f "$dest"; say "could not copy .env to $dest"; return 1; }
}

cmd_save_prev_a() {
  local ps
  need_root; need_tools
  lock_or_stop
  save_prev "$PREV_A" || stop 'env.prev-a not taken'
  ps=$(docker inspect -f '{{.State.StartedAt}}' "$PG" 2>/dev/null) || ps=
  [[ $ps =~ ^[0-9T:.Z-]+$ ]] || stop 'cannot read the StartedAt of docker-postgres-1'
  state_set PG_STARTED "$ps" || stop 'cannot record PG_STARTED'
  say "PG_STARTED=$ps"
  say 'A0 OK'
  DONE=1
}

# ---------------------------------------------------------------------------------------------
# stage-a (A1-A5, then A6). Start, or resume after a STOP: the last finished step is in the state
# file, and a re-run carries on from the next one (T24-V6). Every step is idempotent.
# ---------------------------------------------------------------------------------------------
stepno() { case $1 in A1) echo 1 ;; A2a) echo 2 ;; A2b) echo 3 ;; A3) echo 4 ;; A4a) echo 5 ;; A4b) echo 6 ;; A5) echo 7 ;; *) echo 0 ;; esac; }
reached() { [ "$(stepno "$CUR_STEP")" -ge "$(stepno "$1")" ]; }
mark() { CUR_STEP=$1; state_set A_STEP "$1"; }

legacy_drop() {
  if [ "$(nlines DATABASE_URL)" -eq 0 ]; then say 'DATABASE_URL: no line, nothing to do'; return 0; fi
  drop_key DATABASE_URL
}

# Resuming: what the recorded steps promise must still be true of .env.
verify_progress() {
  local a b
  if reached A1; then
    envget a NEXTAUTH_SECRET || a=; envget b NEXTAUTH_SECRET "$PREV_A" || b=
    [[ $a =~ ^[0-9a-f]{64}$ && $a != "$b" ]] || return 1
  fi
  if reached A2a; then
    envget a POSTGRES_PASSWORD || a=; envget b POSTGRES_PASSWORD "$PREV_A" || b=
    [[ $a =~ ^[0-9a-f]{64}$ && $a != "$b" ]] || return 1
  fi
  if reached A3; then [ "$(nlines DATABASE_URL)" -eq 0 ] || return 1; fi
  if reached A4a; then
    read_ud || return 1
    envget a APP_DATABASE_URL || a=; envget b APP_DATABASE_URL "$PREV_A" || b=
    [[ $a =~ ^postgresql://makrai_app:[0-9a-f]{64}@postgres:5432/$PGD$ && $a != "$b" ]] || return 1
  fi
  return 0
}

stage_a_guidance() { # STEP: where things stand after STEP failed, and the two ways out
  say "STAGE A STOPPED at $1. Nothing after the last OK marker ran."
  case $1 in
    A1)  say 'State: .env is unchanged. Fix the cause and run stage-a again.' ;;
    A2a) say 'State: .env has the new NEXTAUTH_SECRET and nothing else new. Run stage-a again (it carries on at A2).' ;;
    A2b) say 'State: .env has the new owner password; the database owner role has the old one, or an unknown one. The service is up (the container is untouched).'
         say 'Forward: run stage-a again (it applies the ALTER again). Back: rollback-a POSTGRES_PASSWORD, then rollback-a NEXTAUTH_SECRET (or rollback-a all).' ;;
    A3)  say 'State: the owner role is rotated. Run stage-a again, or rollback-a DATABASE_URL.' ;;
    A4a) say 'State: .env has no new makrai_app URL yet. Run stage-a again (it carries on at A4).' ;;
    A4b) say 'State: .env has the new makrai_app URL; the database has the old password, or an unknown one. The running container still has the old URL.'
         say 'Forward: run stage-a again. Back: rollback-a APP_DATABASE_URL (no restart is needed).' ;;
    A5)  say 'OUTAGE: makrai_app has the new password and the running container cannot connect.'
         say 'Now: run stage-a again to retry the restart, or rollback-a NEXTAUTH_SECRET and rollback-a APP_DATABASE_URL (RA-app).' ;;
  esac
}

stage_a_steps() {
  if ! reached A1; then { gen_put NEXTAUTH_SECRET && say 'A1 OK' && mark A1; } || { stage_a_guidance A1; return 1; }; fi
  if ! reached A2a; then { gen_put POSTGRES_PASSWORD && mark A2a; } || { stage_a_guidance A2a; return 1; }; fi
  if ! reached A2b; then { owner_alter && say 'A2 OK' && mark A2b; } || { stage_a_guidance A2b; return 1; }; fi
  if ! reached A3; then { legacy_drop && say 'A3 OK' && mark A3; } || { stage_a_guidance A3; return 1; }; fi
  if ! reached A4a; then { new_app_url && mark A4a; } || { stage_a_guidance A4a; return 1; }; fi
  if ! reached A4b; then { app_provision && say 'A4 OK' && mark A4b; } || { stage_a_guidance A4b; return 1; }; fi
  if ! reached A5; then { compose up -d --no-deps --wait --wait-timeout 120 nextjs 2>&1 | redact && say 'A5 OK' && mark A5; } || { stage_a_guidance A5; return 1; }; fi
}

cmd_stage_a() {
  local t0 rb dn k
  need_root; need_tools
  lock_or_stop
  env_target || stop '.env is not a regular file owned by the operator'
  scrub_env
  prev_ok "$PREV_A" || stop 'no usable env.prev-a: run save-prev-a first'
  if state_get dn A_DONE && [ "$dn" = 1 ]; then stop 'Stage A is already complete; run check-a'; fi
  if state_get rb A_ROLLBACK && [ -n "$rb" ]; then stop "a partial rollback was done ($rb); finish with rollback-a all before another attempt"; fi
  state_get CUR_STEP A_STEP || CUR_STEP=
  if [ -z "$CUR_STEP" ]; then
    cmp -s "$ENVF" "$PREV_A" || stop '.env differs from env.prev-a and no Stage A step is recorded: someone wrote .env since A0. Stop and ask.'
    read_ud || stop 'POSTGRES_USER or POSTGRES_DB is missing or malformed'
    for k in NEXTAUTH_SECRET POSTGRES_PASSWORD APP_DATABASE_URL; do
      [ "$(nlines "$k")" -eq 1 ] || stop "$k does not have exactly one line in .env"
    done
    app_url_report
    [ "$APP_URL_OK" -eq 1 ] || stop 'APP_DATABASE_URL is not postgresql://makrai_app:<password>@postgres:5432/<POSTGRES_DB>: a rebuilt line would drop something. Stop and ask.'
    legacy_report
    [ "$LEGACY_OK" -eq 1 ] || stop 'the legacy DATABASE_URL line may not be removed (it must name the owner role with POSTGRES_PASSWORD, and nothing may read it); nothing was changed'
  else
    verify_progress || stop 'the state file and .env disagree about what is done; nothing was changed. Use rollback-a all.'
  fi
  stage_provision || stop 'the provision script is not the reviewed one; nothing was changed'
  # Resuming at the restart is an outage to end, not a change to schedule: the gate does not apply.
  if [ "$CUR_STEP" != A4b ]; then gate_check || stop 'the gate is closed; nothing after the last OK marker ran'; fi
  if ! state_get t0 T0; then t0=$(date -u +%FT%TZ); state_set T0 "$t0" || stop 'cannot record T0'; fi
  say "T0=$t0"
  stage_a_steps || stop "Stage A stopped; see the guidance above (last finished step: ${CUR_STEP:-none})"
  state_set A_DONE 1 || stop 'cannot record A_DONE'
  say 'STAGE-A steps finished'
  verify_a_body
  say 'Report to the agent: T0 and the markers above. Then sign in at https://makrai.org: the old session is gone.'
  DONE=1
}

# A6: the site, the operator's jobs, and the migrator's own path with the new owner password.
verify_a_body() {
  local rc=0 h=bad
  if health_ok; then h=ok; fi
  say "A6 health=$h"
  opcheck || { say 'A6: the operator jobs cannot source .env. Back: rollback-a all (RA-full).'; stop 'OPERATOR-LOAD-ENV FAILED'; }
  [ "$h" = ok ] || { say 'A6: the site is not healthy. Now: rollback-a NEXTAUTH_SECRET and rollback-a APP_DATABASE_URL (RA-app), or rollback-a all.'; stop 'health is not ok'; }
  compose --profile tools run --rm --no-deps migrator npx prisma migrate status >/dev/null 2>&1 || rc=$?
  say "A6 migrate-status rc=$rc"
  [ "$rc" -eq 0 ] || { say 'A6: users are unaffected. Run fix-owner, then verify-a. Still not 0: stop and report; check-a diagnoses it.'; stop "migrate status rc=$rc"; }
}

cmd_verify_a() {
  need_root; need_tools
  env_target || stop '.env is not a regular file owned by the operator'
  read_ud || stop 'POSTGRES_USER or POSTGRES_DB is missing or malformed'
  verify_a_body
  DONE=1
}

cmd_fix_owner() {
  need_root; need_tools
  lock_or_stop
  env_target || stop '.env is not a regular file owned by the operator'
  scrub_env
  owner_alter || stop 'the owner role was not changed'
  DONE=1
}

# ---------------------------------------------------------------------------------------------
# check-a (W2): read-only
# ---------------------------------------------------------------------------------------------
cmd_check_a() {
  local t0 pgs ns ps k f o c v adm gotk want wantadm s0 sn j jwt other reqs=()
  need_root; need_tools
  env_target || stop '.env is not a regular file owned by the operator'
  scrub_env
  state_get t0 T0 || stop 'no T0 recorded: stage-a has not run'
  state_get pgs PG_STARTED || stop 'no PG_STARTED recorded: run save-prev-a before stage-a'
  prev_ok "$PREV_A" || stop 'no usable env.prev-a'
  read_ud || stop 'POSTGRES_USER or POSTGRES_DB is missing or malformed'
  tools_and_session
  info now "$(date -u +%FT%TZ)"
  info T0 "$t0"
  site_checks
  inspect_line "$WEB"; chk nextjs_state "$INSPECT_STATE" 'running healthy restarts=0'; ns=$STARTED
  inspect_line "$PG"; chk postgres_state "$INSPECT_STATE" 'running healthy restarts=0'; ps=$STARTED
  chk nextjs_started_after_T0 "$([ "$(date -u -d "$ns" +%s)" -gt "$(date -u -d "$t0" +%s)" ] && echo yes || echo no)" yes
  chk postgres_start_unchanged "$([ "$ps" = "$pgs" ] && echo SAME || echo DIFFERENT)" SAME
  env_file_checks
  chk prev_a_mode "$(stat -c %a "$PREV_A")" 600
  chk prev_a_owner_is_roots_home_owner "$([ "$(stat -c %U "$PREV_A")" = "$(stat -c %U "$RHOME")" ] && echo yes || echo no)" yes
  chk leftovers "$(count_existing "$APP/.env.new" "$RHOME"/.t24-env.*)" 0
  chk shape_NEXTAUTH_SECRET "$(grep -cE '^NEXTAUTH_SECRET=[0-9a-f]{64}$' "$ENVF" || true)" 1
  chk shape_POSTGRES_PASSWORD "$(grep -cE '^POSTGRES_PASSWORD=[0-9a-f]{64}$' "$ENVF" || true)" 1
  chk shape_APP_DATABASE_URL "$(grep -cE "^APP_DATABASE_URL=postgresql://makrai_app:[0-9a-f]{64}@postgres:5432/$PGD\$" "$ENVF" || true)" 1
  chk shape_IDENTITY_DATABASE_URL "$(grep -cE '^IDENTITY_DATABASE_URL=postgresql://makrai_identity:[0-9a-f]{64}@postgres:5432/[A-Za-z0-9_]+$' "$ENVF" || true)" 1
  chk DATABASE_URL_lines "$(nlines DATABASE_URL)" 0
  # Names only: which keys differ from root's copy. The three rotated ones, REMOVED DATABASE_URL if
  # the old file had one, and ADMIN_PASSWORD only if admin-password ran.
  keydiff "$PREV_A" "$ENVF" | sed 's/^/keydiff /'
  gotk=$(keydiff "$PREV_A" "$ENVF" | grep -v '^SAME-count' | awk '{print $2}' | sort | paste -sd, - || true)
  reqs=(NEXTAUTH_SECRET POSTGRES_PASSWORD APP_DATABASE_URL)
  if [ "$(nlines DATABASE_URL "$PREV_A")" -gt 0 ]; then reqs+=(DATABASE_URL); fi
  want=$(names_join "${reqs[@]}"); wantadm=$(names_join "${reqs[@]}" ADMIN_PASSWORD)
  state_get adm ADMIN_ROTATED || adm=
  if [ "$adm" = 1 ]; then chk keydiff_names "$gotk" "$want|$wantadm"; else chk keydiff_names "$gotk" "$want"; fi
  for k in NEXTAUTH_SECRET APP_DATABASE_URL IDENTITY_DATABASE_URL; do
    envget o "$k" "$PREV_A" || o=
    c=$(cv "$WEB" "$k") || c=
    chk "nextjs_${k}_vs_env" "$(vs_container "$WEB" "$k")" SAME
    if [ "$k" = IDENTITY_DATABASE_URL ]; then want=SAME; else want=DIFFERENT; fi
    chk "nextjs_${k}_vs_prev" "$([ "$o" = "$c" ] && echo SAME || echo DIFFERENT)" "$want"
    o=; c=
  done
  info postgres_container_POSTGRES_PASSWORD_vs_env "$(vs_container "$PG" POSTGRES_PASSWORD) (DIFFERENT is expected: the container is not recreated, F-26)"
  chk nextjs_DATABASE_URL "$(cnames "$WEB" | grep -cx DATABASE_URL || true)" 0
  url_checks
  for f in "$ENVF" "$PREV_A"; do
    if [ "$f" = "$ENVF" ]; then want=ACCEPTED; k=env; else want=REFUSED; k=prev_a; fi
    envget v POSTGRES_PASSWORD "$f" || v=
    chk "tcp_owner_$k" "$(printf '%s\n' "$v" | tcp_any "$PGU" "$PGD")" "$want"
    envget v APP_DATABASE_URL "$f" || v=
    appw v "$v"
    chk "tcp_makrai_app_$k" "$(printf '%s\n' "$v" | tcp_any makrai_app "$PGD")" "$want"
    v=
  done
  chk operator_load_env "$(opcheck >/dev/null && echo ok || echo failed)" ok
  s0=$(date -u -d "$t0" '+%Y-%m-%d %H:%M:%S'); sn=$(date -u -d "$ns" '+%Y-%m-%d %H:%M:%S')
  j=$(journalctl CONTAINER_TAG=makrai/docker-nextjs-1 --since "$sn UTC" -p err -o cat 2>/dev/null || true)
  jwt=$(printf '%s\n' "$j" | grep -c 'JWTSessionError' || true)
  other=$(printf '%s\n' "$j" | { grep -vE 'JWTSessionError|\[auth\]\[(cause|details)\]|^[[:space:]]+at |^[[:space:]]*$' || true; } | wc -l)
  info journal_nextjs_jwt_session_errors "${jwt:-0} (above 0 is expected after re-sign-ins: old cookies are refused)"
  chk journal_nextjs_other_err "$other" 0
  chk journal_postgres_alter_text_since_T0 "$(journalctl CONTAINER_TAG=makrai/docker-postgres-1 --since "$s0 UTC" -o cat 2>/dev/null | grep -ci 'alter role' || true)" 0
  info journal_postgres_auth_failed_since_T0 "$(journalctl CONTAINER_TAG=makrai/docker-postgres-1 --since "$s0 UTC" -o cat 2>/dev/null | grep -c 'password authentication failed' || true)"
  leak_scan pats_a 40 "$s0" 3
  chk psql_history_hits "$(docker exec "$PG" sh -c 'cat /root/.psql_history /var/lib/postgresql/.psql_history 2>/dev/null' | grep -cFf <(pats_a) || true)" 0
  verdict
}

# ---------------------------------------------------------------------------------------------
# rollback-a <key|all>
# ---------------------------------------------------------------------------------------------
note_partial() { # KEY: a per-key rollback leaves a partial state that stage-a must not resume
  local rb=
  state_get rb A_ROLLBACK || rb=
  case ",$rb," in *",$1,"*) return 0 ;; esac
  state_set A_ROLLBACK "${rb:+$rb,}$1"
}

cmd_rollback_a() {
  local what=${1:-}
  need_root; need_tools
  lock_or_stop
  env_target || stop '.env is not a regular file owned by the operator'
  scrub_env
  prev_ok "$PREV_A" || stop "no usable $PREV_A. After the env.prev copies are shredded no rollback exists: roll forward only."
  case $what in
    all)
      [ ! -e "$PREV_B" ] || stop 'Stage B has started (env.prev-b exists): a whole-file restore would undo it. Roll back key by key.'
      write_env "$PREV_A" || stop '.env was not restored'
      say 'RA env restored'
      read_ud || stop 'the restored .env has no usable POSTGRES_USER or POSTGRES_DB'
      owner_alter || stop 'the owner role was not set back'
      app_provision || stop 'makrai_app was not set back'
      compose up -d --no-deps --wait --wait-timeout 120 nextjs 2>&1 | redact || stop 'nextjs did not come back healthy'
      state_del T0 A_STEP A_DONE A_ROLLBACK ADMIN_ROTATED
      say 'RA-full OK'
      say 'The restored values are the exposed ones: schedule a new attempt, and run precheck first.'
      ;;
    NEXTAUTH_SECRET)
      restore_key NEXTAUTH_SECRET "$PREV_A" || stop 'the line was not restored'
      compose up -d --no-deps --wait --wait-timeout 120 nextjs 2>&1 | redact || stop 'nextjs did not come back healthy'
      note_partial NEXTAUTH_SECRET
      say 'RA-nextauth OK'
      ;;
    POSTGRES_PASSWORD)
      read_ud || stop 'POSTGRES_USER or POSTGRES_DB is missing or malformed'
      restore_key POSTGRES_PASSWORD "$PREV_A" || stop 'the line was not restored'
      owner_alter || stop 'the owner role was not set back'
      note_partial POSTGRES_PASSWORD
      say 'RA-owner OK'
      ;;
    APP_DATABASE_URL)
      read_ud || stop 'POSTGRES_USER or POSTGRES_DB is missing or malformed'
      restore_key APP_DATABASE_URL "$PREV_A" || stop 'the line was not restored'
      app_provision || stop 'makrai_app was not set back'
      compose up -d --no-deps --wait --wait-timeout 120 nextjs 2>&1 | redact || stop 'nextjs did not come back healthy'
      note_partial APP_DATABASE_URL
      say 'RA-app OK'
      ;;
    DATABASE_URL)
      restore_key DATABASE_URL "$PREV_A" || stop 'the line was not restored'
      note_partial DATABASE_URL
      say 'RA-dburl OK'
      ;;
    *) stop 'usage: rollback-a NEXTAUTH_SECRET|POSTGRES_PASSWORD|APP_DATABASE_URL|DATABASE_URL|all' ;;
  esac
  DONE=1
}

# ---------------------------------------------------------------------------------------------
# Stage B
# ---------------------------------------------------------------------------------------------
cmd_save_prev_b() {
  local old pre n
  need_root; need_tools
  lock_or_stop
  state_get n A_DONE && [ "$n" = 1 ] || stop 'Stage A is not complete (stage-a, then check-a)'
  save_prev "$PREV_B" || stop 'env.prev-b not taken'
  old=$(newest_backup)
  [[ $old =~ $NIGHTLY ]] || stop 'the newest backup does not have the nightly name form; the cut-over cannot be named'
  state_get pre LASTOLD || pre=
  state_set LASTOLD "$old" || stop 'cannot record LASTOLD'
  [ "$pre" = "$old" ] || state_del ESCROW_PRE
  say "LASTOLD=$old"
  say 'B0 OK'
  DONE=1
}

# escrow-check pre|new|<backup file name>
cmd_escrow_check() {
  local which=${1:-} file lo nb got
  need_root; need_tools
  lock_or_stop
  case $which in
    pre)
      state_get lo LASTOLD || stop 'no LASTOLD recorded: run save-prev-b first'
      [ "$(newest_backup)" = "$lo" ] || stop 'the newest backup is no longer LASTOLD: run save-prev-b again'
      file=$lo
      ;;
    new)
      state_get nb NEWBACKUP || stop 'no NEWBACKUP recorded: the hand backup has not run'
      file=$nb
      ;;
    makrai-*.sql.gz.gpg)
      [[ $which =~ $NIGHTLY && -f "$BACKUPS/$which" ]] || stop 'not a backup file in the backups directory'
      file=$which
      ;;
    *) stop 'usage: escrow-check pre|new|<backup file name>' ;;
  esac
  got=$(decrypts_ok "passphrase from the password manager, for $file" "$file")
  say "escrow_decrypt=$got"
  say 'Clear the clipboard now.'
  [ "$got" = 1 ] || stop "the typed value does not open $file"
  case $which in
    pre) state_set ESCROW_PRE "$file" || stop 'cannot record ESCROW_PRE' ;;
    new) state_set ESCROW_NEW "$file" || stop 'cannot record ESCROW_NEW' ;;
  esac
  DONE=1
}

cmd_stage_b() {
  local lo pre tb dn
  need_root; need_tools
  lock_or_stop
  env_target || stop '.env is not a regular file owned by the operator'
  scrub_env
  state_get dn A_DONE && [ "$dn" = 1 ] || stop 'Stage A is not complete'
  state_get lo LASTOLD || stop 'no LASTOLD recorded: run save-prev-b first'
  state_get pre ESCROW_PRE || pre=
  [ "$pre" = "$lo" ] || stop "the pre-rotation escrow is not proven against $lo: run escrow-check pre, and do not rotate until it prints 1"
  if state_get dn B_STEP && [ "$dn" = B2 ]; then stop 'Stage B is already written; run backup-chain'; fi
  prev_ok "$PREV_B" || stop 'no usable env.prev-b: run save-prev-b first'
  cmp -s "$ENVF" "$PREV_B" || stop '.env differs from env.prev-b: someone wrote .env since B0. Stop and ask.'
  [ "$(newest_backup)" = "$lo" ] || stop 'a backup appeared since save-prev-b: run save-prev-b again, then escrow-check pre'
  [ "$(nlines BACKUP_PASSPHRASE)" -eq 1 ] || stop 'BACKUP_PASSPHRASE does not have exactly one line in .env'
  gate_check || stop 'the gate is closed; nothing was changed'
  tb=$(date -u +%FT%TZ); state_set TB "$tb" || stop 'cannot record TB'
  say "TB=$tb"
  gen_put BACKUP_PASSPHRASE || stop 'BACKUP_PASSPHRASE was not written'
  say "B2 shape=$(grep -cE '^BACKUP_PASSPHRASE=[0-9a-f]{64}$' "$ENVF" || true)"
  opcheck || stop 'the operator jobs cannot source .env: rollback-b line'
  state_set B_STEP B2 || stop 'cannot record B_STEP'
  say 'B2 OK'
  say 'Now escrow the new value (README, B3), then relabel the old entry, then run backup-chain.'
  DONE=1
}

# backup-chain: B4 (the hand backup, as its own command) -> B5 (the new escrow, proven before anything
# leaves the server) -> B6 (wait 130 s) -> B7 (the off-site copy) -> B8 (the restore test). Resumable.
chain_advice() {
  if [ "$2" != new ]; then
    # The box's newest file is not NEWBACKUP: the copy has not landed, or the box lags. A restore that
    # failed on some other file says nothing about the passphrase.
    say 'The box does not hold NEWBACKUP as its newest file yet: wait 2 minutes, then run backup-chain again (B7, then B8).'
  else
    case $1 in
      restore|cluster|roles)
        state_set CHAIN_HOLD "$1" || true
        say "NEWBACKUP was fetched and did not restore ($1). No retry: the agent reads the tail of restore-test.log in a window first."
        say 'A decrypt failure there points to an .env/escrow mismatch: see the escrow rows of the rollback table. Release with backup-chain --release-hold.' ;;
      policies|migrations|users|organizations)
        say "Live changed after the backup ($1), unrelated to the passphrase: run backup-chain --fresh (B4 to B8 again) and report." ;;
      *)
        state_set CHAIN_HOLD "$1" || true
        say "The restore test failed ($1). No retry until the agent has read the tail of restore-test.log. Release with backup-chain --release-hold." ;;
    esac
  fi
  say 'A FAILED last line in restore-test.log blocks migration deploys until a later PASSED: never leave it.'
}

cmd_backup_chain() {
  local flag=${1:-} lo tb nb esc got hold dn off rc=0 part fetch field out left pen bh
  need_root; need_tools
  lock_or_stop
  env_target || stop '.env is not a regular file owned by the operator'
  scrub_env
  state_get dn B_STEP && [ "$dn" = B2 ] || stop 'Stage B is not written (stage-b)'
  state_get lo LASTOLD || stop 'no LASTOLD recorded'
  state_get tb TB || stop 'no TB recorded'
  case $flag in
    --release-hold) state_del CHAIN_HOLD; say 'hold released'; DONE=1; return 0 ;;
    --fresh) state_del NEWBACKUP ESCROW_NEW CHAIN_HOLD ;;
    '') ;;
    *) stop 'usage: backup-chain [--fresh|--release-hold]' ;;
  esac
  if state_get hold CHAIN_HOLD && [ -n "$hold" ]; then stop "held after a restore failure ($hold): the agent reads restore-test.log first, then backup-chain --release-hold"; fi
  gate_check || stop 'the gate is closed; nothing was changed'
  prev_ok "$PREV_B" || stop 'no usable env.prev-b'
  [ "$(nlines BACKUP_PASSPHRASE)" -eq 1 ] || stop 'BACKUP_PASSPHRASE does not have exactly one line in .env'
  # B4: the hand backup, its own command, never chained with the copy.
  state_get nb NEWBACKUP || nb=
  if [ -z "$nb" ] || [ ! -f "$BACKUPS/$nb" ]; then
    off=$(loglines "$LOG_BACKUP")
    sudo -u "$OP" "$BIN/makrai-backup.sh" || rc=$?
    part=$(logsince "$LOG_BACKUP" "$off")
    if [ "$rc" -ne 0 ]; then
      say "B4: the backup failed (exit $rc). No new file is kept; .env has the new value."
      say 'Next: the agent reads the cause in the next window; run backup-chain again, or rollback-b line.'
      stop 'B4 failed'
    fi
    nb=$(newest_backup)
    { [[ $nb =~ $NIGHTLY ]] && [[ $nb > $lo ]]; } || stop "B4: the newest file ($nb) is not named after $lo"
    printf '%s\n' "$part" | grep -qF "Backup verified and encrypted: $BACKUPS/$nb " || stop 'B4: the backup log has no verified line for the new file'
    printf '%s\n' "$part" | tail -n 1 | grep -qE 'Backup complete\.$' || stop 'B4: the backup log does not end with Backup complete.'
    pen=$(printf '%s\n' "$part" | tail -n 2 | sed -n 1p)
    case $pen in
      *'watchdog pinged') say 'B4 OK' ;;
      *'WARNING: watchdog ping failed'*) say 'B4 OK (the backup is fine, only its watchdog ping failed: tell the agent)' ;;
      *) stop 'B4: the backup log is not in the expected form' ;;
    esac
    state_set NEWBACKUP "$nb" || stop 'cannot record NEWBACKUP'
    state_del ESCROW_NEW
    say "NEWBACKUP=$nb"
  else
    say "NEWBACKUP=$nb (resuming; the hand backup is not repeated)"
  fi
  # B5: nothing leaves the server before the new escrow opens the new file.
  state_get esc ESCROW_NEW || esc=
  if [ "$esc" != "$nb" ]; then
    got=$(decrypts_ok "NEW passphrase from the password manager, for $nb" "$nb")
    say "B5 escrow_decrypt=$got"
    say 'Clear the clipboard now.'
    if [ "$got" != 1 ]; then
      say 'B5: nothing has left the server. Repeat the escrow pipe (README B3) into the same new entry, then run backup-chain again: it resumes at this prompt.'
      say 'Still 0 after one retry: rollback-b local, before 23:00 UTC today.'
      stop 'B5 escrow not proven'
    fi
    state_set ESCROW_NEW "$nb" || stop 'cannot record ESCROW_NEW'
  fi
  # B6: let the file age past the off-site copy's 2-minute rule.
  sleep 130
  left=$(find "$BACKUPS" -maxdepth 1 -name 'makrai-*.sql.gz.gpg' -mmin -2 | wc -l)
  [ "$left" -eq 0 ] || stop "B6: $left backup file(s) are still under 2 minutes old"
  say 'B6 OK'
  # B7: the off-site copy.
  off=$(loglines "$LOG_OFFSITE"); rc=0
  sudo -u "$OP" "$BIN/makrai-offsite-copy.sh" || rc=$?
  part=$(logsince "$LOG_OFFSITE" "$off")
  say "B7 rc=$rc"
  # The copy's own log is one witness; the box's listing is the other: NEWBACKUP must be there.
  bh=0; box_has "$nb" || bh=$?
  say "B7 box_has_new=$([ "$bh" -eq 0 ] && echo yes || { [ "$bh" -eq 1 ] && echo no || echo unknown; })"
  if [ "$rc" -ne 0 ] || [ "$(printf '%s\n' "$part" | tail -n 2 | count_re 'Off-site copy complete|watchdog pinged')" -ne 2 ] \
     || [ "$(printf '%s\n' "$part" | count_re "Skipped $nb")" -ne 0 ] || [ "$bh" -ne 0 ]; then
    say 'B7: a line differs from the expected one. B8 is not run.'
    say 'Next: wait 2 minutes and run backup-chain once more. If the box stays unreachable and cannot be fixed before 22:00 UTC, the agent lists the box; if NEWBACKUP is not there, rollback-b local; if it is, roll forward and fix the copy.'
    stop 'B7 failed'
  fi
  say 'B7 OK'
  # B8: the restore test, from the box.
  off=$(loglines "$LOG_RESTORE"); rc=0
  out=$(sudo -u "$OP" "$BIN/makrai-restore-test.sh") || rc=$?
  part=$(logsince "$LOG_RESTORE" "$off")
  fetch=$(printf '%s\n' "$part" | grep -o 'fetched=[^ ]*' | tail -n 1 || true)
  field=
  case $out in 'RESTORE MISMATCH '*) field=${out#RESTORE MISMATCH } ;; esac
  say "B8 result=${out:-none} rc=$rc"
  if [ "$fetch" = "fetched=$nb" ]; then say 'B8 FETCHED-NEW'; else say 'B8 FETCHED-OTHER'; fi
  if [ "$rc" -eq 0 ] && [ "$out" = 'RESTORE MATCH' ] && [ "$fetch" = "fetched=$nb" ] \
     && [ "$(printf '%s\n' "$part" | tail -n 1 | count_re 'Restore test PASSED')" -eq 1 ] \
     && [ "$(docker ps -aq --filter name=makrai-restore-test | wc -l)" -eq 0 ]; then
    state_set B_DONE 1 || stop 'cannot record B_DONE'
    say 'B8 OK'
    say "Report to the agent: TB=$tb LASTOLD=$lo NEWBACKUP=$nb, B1=1 and B5=1 (both proven), and the B7 and B8 lines."
    DONE=1
    return 0
  fi
  chain_advice "${field:-unknown}" "$([ "$fetch" = "fetched=$nb" ] && echo new || echo other)"
  stop "B8 failed (${field:-no field})"
}

# ---------------------------------------------------------------------------------------------
# check-b (W3): read-only
# ---------------------------------------------------------------------------------------------
cmd_check_b() {
  local tb nb adm gotk n s0 want sa t0
  need_root; need_tools
  env_target || stop '.env is not a regular file owned by the operator'
  scrub_env
  state_get tb TB || stop 'no TB recorded: stage-b has not run'
  state_get nb NEWBACKUP || stop 'no NEWBACKUP recorded: backup-chain has not run'
  prev_ok "$PREV_B" || stop 'no usable env.prev-b'
  tools_and_session
  info now "$(date -u +%FT%TZ)"
  env_file_checks
  chk prev_b_mode "$(stat -c %a "$PREV_B")" 600
  chk prev_b_owner_is_roots_home_owner "$([ "$(stat -c %U "$PREV_B")" = "$(stat -c %U "$RHOME")" ] && echo yes || echo no)" yes
  chk leftovers "$(count_existing "$APP/.env.new" "$RHOME"/.t24-env.*)" 0
  chk shape_BACKUP_PASSPHRASE_hex64 "$(grep -cE '^BACKUP_PASSPHRASE=[0-9a-f]{64}$' "$ENVF" || true)" 1
  chk BACKUP_PASSPHRASE_lines "$(nlines BACKUP_PASSPHRASE)" 1
  keydiff "$PREV_B" "$ENVF" | sed 's/^/keydiff /'
  gotk=$(keydiff "$PREV_B" "$ENVF" | grep -v '^SAME-count' | awk '{print $2}' | sort | paste -sd, - || true)
  state_get adm ADMIN_ROTATED || adm=
  want=BACKUP_PASSPHRASE
  if [ "$adm" = 1 ]; then want="BACKUP_PASSPHRASE|$(names_join BACKUP_PASSPHRASE ADMIN_PASSWORD)"; fi
  chk keydiff_names "$gotk" "$want"
  chk operator_load_env "$(opcheck >/dev/null && echo ok || echo failed)" ok
  n=$(newest_backup)
  info newest_local "$n"
  chk newest_local_is_N "$([ "$n" = "$nb" ] && echo SAME || { [[ $n > $nb ]] && echo NEWER || echo DIFFERENT; })" 'SAME|NEWER'
  chk backup_verified_line_for_N "$(grep -c "Backup verified and encrypted: $BACKUPS/$nb " "$LOG_BACKUP" || true)" 1
  chk backup_tail "$(tail -n 2 "$LOG_BACKUP" | count_re '(watchdog pinged|Backup complete\.)$')" 2
  s0=$(date -u -d "$tb" '+%Y-%m-%d %H:%M:%S')
  chk offsite_skipped_N "$(grep -c "Skipped $nb" "$LOG_OFFSITE" || true)" 0
  chk offsite_last_complete "$(tail -n 2 "$LOG_OFFSITE" | count_re 'Off-site copy complete')" 1
  chk offsite_last_pinged "$(tail -n 2 "$LOG_OFFSITE" | count_re 'watchdog pinged')" 1
  info offsite_failed_since_TB "$(awk -v t="[$(date -u -d "$tb" +%FT%T)" '$1 >= t' "$LOG_OFFSITE" | grep -c 'FAILED' || true) (reported only: a legitimate retry leaves a line)"
  chk restore_last_passed "$(tail -n 1 "$LOG_RESTORE" | count_re 'Restore test PASSED')" 1
  chk restore_last_fetched_is_N "$([ "$(last_fetched "$LOG_RESTORE")" = "fetched=$nb" ] && echo SAME || echo DIFFERENT)" SAME
  info restore_failed_since_TB "$(awk -v t="[$(date -u -d "$tb" +%FT%T)" '$1 >= t' "$LOG_RESTORE" | grep -c 'Restore test FAILED' || true) (reported only: a legitimate retry leaves a line)"
  chk restore_leftover_containers "$(docker ps -aq --filter name=makrai-restore-test | wc -l)" 0
  chk synthetic_last "$(tail -n 1 "$LOG_SYNTH" 2>/dev/null | grep -oE 'result=[a-z]+' || true)" 'result=pass'
  # The next scheduled :07 run after Stage A must have passed: the journey signs in fresh every run.
  sa=$(tail -n 1 "$LOG_SYNTH" 2>/dev/null | grep -oE 'at=[0-9TZ:-]+' || true); sa=${sa#at=}
  state_get t0 T0 || t0=
  chk synthetic_last_is_after_T0 "$([ -n "$sa" ] && [ -n "$t0" ] && [ "$(date -u -d "$sa" +%s 2>/dev/null || echo 0)" -gt "$(date -u -d "$t0" +%s)" ] && echo yes || echo no)" yes
  leak_scan pats_b 32 "$s0" 1
  verdict
}

# ---------------------------------------------------------------------------------------------
# rollback-b line|local
# ---------------------------------------------------------------------------------------------
box_has() { # NAME: does the Storage Box hold this file? 0 yes, 1 no, 2 cannot tell
  local listing
  listing=$(sudo -u "$OP" bash -c '. "$1"; load_env; T=$OFFSITE_TARGET; [[ $T == *: || $T == */ ]] || T+=/; timeout 300 rsync --list-only --include="makrai-*.sql.gz.gpg" --exclude="*" -e "$OFFSITE_SSH" "$T"' bash "$BIN/makrai-lib.sh" 2>/dev/null) || return 2
  printf '%s\n' "$listing" | awk '{print $NF}' | grep -qxF "$1"
}

cmd_rollback_b() {
  local mode=${1:-} nb lo newer top bh=0
  need_root; need_tools
  lock_or_stop
  case $mode in line|local) ;; *) stop 'usage: rollback-b line|local' ;; esac
  env_target || stop '.env is not a regular file owned by the operator'
  scrub_env
  prev_ok "$PREV_B" || stop "no usable $PREV_B. After the env.prev copies are shredded no rollback exists: roll forward only."
  state_get lo LASTOLD || stop 'no LASTOLD recorded'
  state_get nb NEWBACKUP || nb=$lo
  gate_check || stop 'the gate is closed; nothing was changed'
  newer=$(find "$BACKUPS" -maxdepth 1 -name 'makrai-*.sql.gz.gpg' -printf '%f\n' | sort | awk -v n="$nb" '$0 > n' | wc -l)
  if [ "$newer" -ne 0 ]; then
    say "A backup named after $nb exists: 00:00 has run with the new value in .env."
    say 'Do not roll back. Prove or fix the new escrow against that file (the escrow pipe, then escrow-check <that file name>) and roll forward.'
    stop 'rolled forward only'
  fi
  if [ "$mode" = local ]; then
    [ "$nb" != "$lo" ] || stop 'there is no NEWBACKUP to remove'
    [[ $nb =~ $NIGHTLY ]] || stop 'NEWBACKUP in the state file is not a backup name'
    box_has "$nb" || bh=$?
    [ "$bh" -ne 0 ] || stop "$nb is on the box: roll forward only. If a rollback is forced anyway, use rollback-b line and keep the new escrow entry."
    [ "$bh" -ne 2 ] || stop "cannot list the box, so cannot show $nb is not on it"
  fi
  restore_key BACKUP_PASSPHRASE "$PREV_B" || stop 'the line was not restored'
  opcheck || stop 'the operator jobs cannot source .env after the restore'
  if [ "$mode" = local ]; then
    rm -f "$BACKUPS/$nb"
    top=$(newest_backup)
    say "newest_backup=$top"
    [ "$top" = "$lo" ] || stop "the newest backup is not $lo after the removal"
    state_del NEWBACKUP ESCROW_NEW B_STEP B_DONE CHAIN_HOLD
    say 'Then, in the password manager: delete the new entry and give the old one back its label "makrai backup passphrase (current, server)".'
    say 'RB-local OK'
  else
    state_del B_STEP B_DONE CHAIN_HOLD
    say 'RB-line OK'
  fi
  DONE=1
}

# ---------------------------------------------------------------------------------------------
# admin-password [rollback]: optional. ADMIN_PASSWORD in the server .env, read only by a seed run.
# It has its own root copy, env.prev-admin, so its rollback does not depend on either stage.
# ---------------------------------------------------------------------------------------------
cmd_admin_password() {
  local mode=${1:-rotate}
  need_root; need_tools
  lock_or_stop
  env_target || stop '.env is not a regular file owned by the operator'
  scrub_env
  case $mode in
    rotate)
      [ "$(nlines ADMIN_PASSWORD)" -le 1 ] || stop 'ADMIN_PASSWORD has more than one line in .env'
      gate_check || stop 'the gate is closed; nothing was changed'
      save_prev "$PREV_ADMIN" || stop 'env.prev-admin not taken'
      gen_put ADMIN_PASSWORD || stop 'ADMIN_PASSWORD was not written'
      opcheck || stop 'the operator jobs cannot source .env: run admin-password rollback'
      [ "$(grep -cE '^ADMIN_PASSWORD=[0-9a-f]{64}$' "$ENVF" || true)" = 1 ] || stop 'ADMIN_PASSWORD has an unexpected shape: run admin-password rollback'
      state_set ADMIN_ROTATED 1 || stop 'cannot record ADMIN_ROTATED'
      say 'A7 OK'
      ;;
    rollback)
      restore_key ADMIN_PASSWORD "$PREV_ADMIN" || stop 'the line was not restored'
      opcheck || stop 'the operator jobs cannot source .env after the restore'
      state_del ADMIN_ROTATED
      say 'RA-admin OK'
      ;;
    *) stop 'usage: admin-password [rotate|rollback]' ;;
  esac
  DONE=1
}

# ---------------------------------------------------------------------------------------------
# check-next (W4) and shred-prev
# ---------------------------------------------------------------------------------------------
next_checks() {
  local nb f fa=
  state_get nb NEWBACKUP || stop 'no NEWBACKUP recorded: backup-chain has not run'
  state_get fa B_DONE || fa=
  chk chain_done "$fa" 1
  info now "$(date -u +%FT%TZ)"
  f=$(newest_backup)
  chk newest_local_is_after_N "$([[ $f > $nb ]] && echo yes || echo no)" yes
  info newest_local "$f"
  chk backup_tail "$(tail -n 2 "$LOG_BACKUP" | count_re '(watchdog pinged|Backup complete\.)$')" 2
  chk offsite_last_complete "$(tail -n 2 "$LOG_OFFSITE" | count_re 'Off-site copy complete')" 1
  chk offsite_last_pinged "$(tail -n 2 "$LOG_OFFSITE" | count_re 'watchdog pinged')" 1
  f=$(last_fetched "$LOG_RESTORE"); f=${f#fetched=}
  chk restore_last_passed "$(tail -n 1 "$LOG_RESTORE" | count_re 'Restore test PASSED')" 1
  chk restore_fetched_after_N "$([[ $f > $nb ]] && echo yes || echo no)" yes
  info restore_fetched "${f:-none}"
  chk synthetic_last "$(tail -n 1 "$LOG_SYNTH" 2>/dev/null | grep -oE 'result=[a-z]+' || true)" 'result=pass'
  chk leftovers "$(count_existing "$APP/.env.new" "$RHOME"/.t24-env.*)" 0
  info env_prev_files "$(count_existing "$PREV_A" "$PREV_B" "$PREV_ADMIN")"
}

cmd_check_next() {
  need_root; need_tools
  next_checks
  verdict
}

cmd_shred_prev() {
  local f left
  need_root; need_tools
  lock_or_stop
  next_checks
  [ "$FAILS" -eq 0 ] || stop "the next night's chain is not proven ($FAILS check(s) failed); nothing was shredded"
  for f in "$PREV_A" "$PREV_B" "$PREV_ADMIN" "$PROV"; do
    if [ -e "$f" ] || [ -L "$f" ]; then shred -u "$f" 2>/dev/null || rm -f "$f"; fi
  done
  left=$(count_existing "$PREV_A" "$PREV_B" "$PREV_ADMIN" "$PROV" "$RHOME"/.t24-env.*)
  say "env_prev_files=$left"
  [ "$left" -eq 0 ] || stop 'a file is still there'
  DONE=1
}

# ---------------------------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------------------------
SUB=${1:-}
[ $# -eq 0 ] || shift
case $SUB in
  gate)           NAME=GATE;           cmd_gate "$@" ;;
  precheck)       NAME=PRECHECK;       cmd_precheck "$@" ;;
  save-prev-a)    NAME=SAVE-PREV-A;    cmd_save_prev_a "$@" ;;
  stage-a)        NAME=STAGE-A;        cmd_stage_a "$@" ;;
  verify-a)       NAME=VERIFY-A;       cmd_verify_a "$@" ;;
  fix-owner)      NAME=FIX-OWNER;      cmd_fix_owner "$@" ;;
  check-a)        NAME=CHECK-A;        cmd_check_a "$@" ;;
  rollback-a)     NAME=ROLLBACK-A;     cmd_rollback_a "$@" ;;
  save-prev-b)    NAME=SAVE-PREV-B;    cmd_save_prev_b "$@" ;;
  escrow-check)   NAME=ESCROW-CHECK;   cmd_escrow_check "$@" ;;
  stage-b)        NAME=STAGE-B;        cmd_stage_b "$@" ;;
  backup-chain)   NAME=BACKUP-CHAIN;   cmd_backup_chain "$@" ;;
  check-b)        NAME=CHECK-B;        cmd_check_b "$@" ;;
  rollback-b)     NAME=ROLLBACK-B;     cmd_rollback_b "$@" ;;
  admin-password) NAME=ADMIN-PASSWORD; cmd_admin_password "$@" ;;
  check-next)     NAME=CHECK-NEXT;     cmd_check_next "$@" ;;
  shred-prev)     NAME=SHRED-PREV;     cmd_shred_prev "$@" ;;
  *)
    say 'usage: makrai-rotate-secrets.sh gate | precheck | save-prev-a | stage-a | verify-a | fix-owner | check-a | rollback-a <key|all>'
    say '       | save-prev-b | escrow-check pre|new|<file> | stage-b | backup-chain | check-b | rollback-b line|local'
    say '       | admin-password [rollback] | check-next | shred-prev'
    stop 'usage'
    ;;
esac
