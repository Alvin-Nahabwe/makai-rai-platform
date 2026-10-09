#!/usr/bin/env bash
# /usr/local/bin/makrai-lib.sh
# Helpers shared by the host scripts. Sourced by them; never run.
#
#   . "$HERE/makrai-lib.sh"
#
# The options below apply to the sourcing script too, which has set them anyway.
# Having them here means a script that forgets still fails fast.
set -Eeuo pipefail

# How a script reaches the Storage Box: port 23, the dedicated key, no prompts,
# and a host key that must already be known. Written once so the copy and the
# restore test cannot disagree about it. rsync takes its remote shell as a single
# word, so this is a string and not a function.
#
# Read-only on purpose: .env is sourced after this, and a stray assignment there
# must not be able to redirect the connection.
readonly OFFSITE_SSH="ssh -p 23 -i $HOME/.ssh/makrai_offsite -o BatchMode=yes -o StrictHostKeyChecking=yes"

# Read the server .env into the calling shell, exporting every variable in it.
# Every value a script needs comes from here and from nowhere else: not argv, not
# a file under the repository. A script that needs a secret reads it from the
# environment this puts in place.
load_env() {
  set -a
  . /srv/makrai/app/.env
  set +a
}

# Dead-man pings. $1 is the NAME of a variable holding a check URL, not the URL:
#   ping_ok HC_RESTORE_PING_URL
# so the URL itself never appears in a script or a log. An unset or empty variable
# is reported and returns 1 rather than tripping `set -u`, which would kill the
# failure handler that called this before it could alert.
#
# The URL goes to curl as a config on STDIN, not as an argument. A ping URL is a
# credential: anyone who holds it can send a success ping and silence a real
# alarm, and an argument is readable by every local account for as long as curl
# runs (up to about 40 s with the retries). `printf` is a builtin, so the URL never
# exists as an argument to any process. Because the URL is now written into a
# config, a character that would end the quoted string or start a new line (and so
# could add a config line of its own, such as `output = ...`) is refused.
_ping() { # $1 = variable name, $2 = suffix ("" or "/fail")
  local url="${!1:-}"
  if [ -z "$url" ]; then
    echo "makrai-lib: $1 is unset or empty; nothing was pinged." >&2
    return 1
  fi
  case "$url" in
    *[\"\\[:space:]]*)
      echo "makrai-lib: $1 holds a quote, a backslash or whitespace; nothing was pinged." >&2
      return 1 ;;
  esac
  printf 'url = "%s%s"\n' "$url" "$2" | curl -fsS -m 10 --retry 3 -o /dev/null --config -
}
ping_ok()   { _ping "$1" ""; }
ping_fail() { _ping "$1" "/fail"; }

# A content-free mail to the administrator, through the platform's own Resend
# account. The subject names the job and what happened and the body is fixed
# text: no log lines, no field values, no row content ever goes in it.
#
# The API key, the addresses and the subject all go to curl on STDIN as a config
# (`header = ...` and `data = ...`), never as arguments. Anything in argv is
# readable by every local account for the life of the process. `printf` is a shell
# builtin, so none of it exists as an argument to any process. The only things in
# argv are the endpoint and the content type.
#
# Always returns 0. A broken alert path must never mask the failure it was
# raised for, and it is reported on stderr, which the calling script has pointed
# at its log.
alert() { # $1 = subject
  local subject=$1 cfg resp code
  if [ -z "${RESEND_API_KEY:-}" ] || [ -z "${ADMIN_EMAIL:-}" ] || [ -z "${EMAIL_FROM_ADDRESS:-}" ]; then
    echo "makrai-lib: mail settings are missing from .env; no alert sent for: ${subject}" >&2
    return 0
  fi
  # Builds one curl config line, `data = "<json>"`. Inside the quotes a curl config
  # reads \\ and \" as escapes, so both are escaped here; the JSON keeps non-ASCII
  # characters as they are, because a config would drop the backslash of \uXXXX.
  cfg=$(TO="$ADMIN_EMAIL" FROM="$EMAIL_FROM_ADDRESS" SUBJ="[makrai] ${subject} on $(hostname)" python3 -c '
import json, os
bs, q = chr(92), chr(34)
body = json.dumps({"from": os.environ["FROM"], "to": [os.environ["TO"]],
                   "subject": os.environ["SUBJ"],
                   "text": "A scheduled job on this host reported a failure. Read its log on the host. This message carries no data."},
                  ensure_ascii=False)
print("data = " + q + body.replace(bs, bs + bs).replace(q, bs + q) + q)') || {
    echo "makrai-lib: could not build the alert payload for: ${subject}" >&2
    return 0
  }
  # curl exits 0 on an HTTP 4xx, so the status code is read, not the exit status.
  resp=$({ printf 'header = "Authorization: Bearer %s"\n' "$RESEND_API_KEY"; printf '%s\n' "$cfg"; } \
         | curl -sS --max-time 20 -w '\n%{http_code}' --config - \
                -X POST https://api.resend.com/emails \
                -H "Content-Type: application/json" 2>&1) || true
  code=$(printf '%s' "$resp" | tail -n1)
  # The status only, never the response. A refusal names its cause, and in Resend's testing
  # mode the cause is "you can only send to your own address (<that address>)": printing the
  # body would put an email address in the job's log. When there is no three-digit status
  # the last line is curl's own message (also not printed: it can name a host or a payload).
  case "$code" in
    2[0-9][0-9])        echo "makrai-lib: alert accepted by Resend (HTTP ${code})" >&2 ;;
    [0-9][0-9][0-9])    echo "makrai-lib: alert NOT delivered (HTTP ${code})" >&2 ;;
    *)                  echo "makrai-lib: alert NOT delivered (no HTTP status: the request failed or timed out)" >&2 ;;
  esac
  return 0
}
