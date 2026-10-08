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
# so the URL itself never appears in a script, in a log or in argv. An unset or
# empty variable is reported and returns 1 rather than tripping `set -u`, which
# would kill the failure handler that called this before it could alert.
_ping() { # $1 = variable name, $2 = suffix ("" or "/fail")
  local url="${!1:-}"
  if [ -z "$url" ]; then
    echo "makrai-lib: $1 is unset or empty; nothing was pinged." >&2
    return 1
  fi
  curl -fsS -m 10 --retry 3 -o /dev/null "${url}$2"
}
ping_ok()   { _ping "$1" ""; }
ping_fail() { _ping "$1" "/fail"; }

# A content-free mail to the administrator, through the platform's own Resend
# account. The subject names the job and what happened and the body is fixed
# text: no log lines, no field values, no row content ever goes in it.
#
# The API key goes to curl on STDIN as a config, never as an argument. Anything
# in argv is readable by every local account for the life of the process. `printf`
# is a shell builtin, so the key never exists as an argument to any process.
# The payload stays in argv deliberately: it is the alert text and an address.
#
# Always returns 0. A broken alert path must never mask the failure it was
# raised for, and it is reported on stderr, which the calling script has pointed
# at its log.
alert() { # $1 = subject
  local subject=$1 payload resp code
  if [ -z "${RESEND_API_KEY:-}" ] || [ -z "${ADMIN_EMAIL:-}" ] || [ -z "${EMAIL_FROM_ADDRESS:-}" ]; then
    echo "makrai-lib: mail settings are missing from .env; no alert sent for: ${subject}" >&2
    return 0
  fi
  payload=$(TO="$ADMIN_EMAIL" FROM="$EMAIL_FROM_ADDRESS" SUBJ="[makrai] ${subject} on $(hostname)" python3 -c '
import json, os
print(json.dumps({"from": os.environ["FROM"], "to": [os.environ["TO"]],
                  "subject": os.environ["SUBJ"],
                  "text": "A scheduled job on this host reported a failure. Read its log on the host. This message carries no data."}))') || {
    echo "makrai-lib: could not build the alert payload for: ${subject}" >&2
    return 0
  }
  # curl exits 0 on an HTTP 4xx, so the status code is read, not the exit status.
  resp=$(printf 'header = "Authorization: Bearer %s"\n' "$RESEND_API_KEY" \
         | curl -sS --max-time 20 -w '\n%{http_code}' --config - \
                -X POST https://api.resend.com/emails \
                -H "Content-Type: application/json" -d "$payload" 2>&1) || true
  code=$(printf '%s' "$resp" | tail -n1)
  case "$code" in
    2*) echo "makrai-lib: alert accepted by Resend (HTTP ${code})" >&2 ;;
    *)  echo "makrai-lib: alert NOT delivered (HTTP ${code:-none}): $(printf '%s' "$resp" | head -c 300)" >&2 ;;
  esac
  return 0
}
