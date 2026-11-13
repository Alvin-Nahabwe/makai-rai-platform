#!/bin/sh
# Starts the production nginx configuration in front of the local app for e2e/sign-in-nginx.spec.ts and the J-15 cases of
# e2e/account.spec.ts (SRS NFR-SEC-06 "Verified by"; 12.2 step 2). Usage, from the repository root:
#
#   E2E_PORT=<the app's port> scripts/nginx-test/up.sh <K>
#
# K is the builder slot's number (0 in CI). It makes a self-signed certificate for makrai.org in a fresh `mktemp -d`
# directory outside the repository (never committed), renders docker/nginx/default.conf there with
# scripts/nginx-test/render.mjs against host.docker.internal:$E2E_PORT, runs the pinned nginx image as v060-nginx-b<K> on
# 127.0.0.1:$((8440 + K)), prints E2E_NGINX_URL, and then stays in the foreground until the container stops by itself
# (exit non-zero) or this script gets TERM or INT (scripts/nginx-test/down.sh removes the container and the directory,
# exit 0). Playwright starts it as a webServer entry (playwright.nginx.config.ts) and ends it with SIGTERM.
set -eu

K="${1:-}"
case "$K" in
  '' | *[!0-9]*) echo "up.sh: usage: E2E_PORT=<port> up.sh <K>, K the slot number" >&2; exit 2 ;;
esac
case "${E2E_PORT:-}" in
  '' | *[!0-9]*) echo "up.sh: E2E_PORT must be the app's port, 2 to 5 digits" >&2; exit 2 ;;
esac
if [ "${#E2E_PORT}" -lt 2 ] || [ "${#E2E_PORT}" -gt 5 ]; then
  echo "up.sh: E2E_PORT must be the app's port, 2 to 5 digits" >&2
  exit 2
fi

IMAGE='nginx:1.31-alpine@sha256:713fc2ebfd92e8217db451477182ee91944b123d2b1ee9fd5a8c6e91ca6c3a11'
PORT=$((8440 + K))
DIR=$(mktemp -d)
# down.sh finds the directory here; it holds the test certificate's key, so it never sits in the repository.
printf '%s\n' "$DIR" > "${TMPDIR:-/tmp}/makrai-nginx-b$K.dir"
trap 'scripts/nginx-test/down.sh "$K"; exit 0' TERM INT

mkdir "$DIR/certs"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=makrai.org \
  -keyout "$DIR/certs/key.pem" -out "$DIR/certs/cert.pem" 2>/dev/null
chmod 644 "$DIR/certs/key.pem" "$DIR/certs/cert.pem"
node scripts/nginx-test/render.mjs "$DIR" "host.docker.internal:$E2E_PORT"

docker run -d --name "v060-nginx-b$K" --pull=never --add-host=host.docker.internal:host-gateway \
  -p "127.0.0.1:$PORT:443" -v "$DIR:/etc/nginx/conf.d:ro" -v "$DIR/certs:/etc/ssl/makrai:ro" "$IMAGE" >/dev/null
echo "E2E_NGINX_URL=https://127.0.0.1:$PORT"

# In the background so the shell can run the trap when Playwright's SIGTERM arrives while it waits.
docker wait v060-nginx-b"$K" &
wait $!
echo "up.sh: the nginx container v060-nginx-b$K stopped by itself" >&2
exit 1
