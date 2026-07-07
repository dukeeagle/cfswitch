#!/usr/bin/env bash
# Smoke test: exercises every non-network command against an isolated config dir.
set -euo pipefail
cd "$(dirname "$0")/.."

export CFSWITCH_CONFIG_DIR="$(mktemp -d)"
trap 'rm -rf "$CFSWITCH_CONFIG_DIR"' EXIT
CLI="node dist/index.js"

fail() { echo "FAIL: $1" >&2; exit 1; }

$CLI help | grep -q "cfswitch" || fail "help"
$CLI version | grep -qE '^[0-9]+\.' || fail "version"

# add via flag, stdin, and env var
$CLI add alpha --token tok-alpha --account-id acc-alpha --note "first" | grep -q 'added profile "alpha" (default)' || fail "add alpha"
printf 'tok-beta' | $CLI add beta --token-stdin | grep -q 'added profile "beta"' || fail "add beta stdin"
CFSWITCH_TOKEN=tok-gamma $CLI add gamma | grep -q 'added profile "gamma"' || fail "add gamma env"

# config file permissions
perms=$(stat -c '%a' "$CFSWITCH_CONFIG_DIR/profiles.json" 2>/dev/null || stat -f '%Lp' "$CFSWITCH_CONFIG_DIR/profiles.json")
[ "$perms" = "600" ] || fail "profiles.json perms ($perms)"

# list: plain and json; no token values anywhere
$CLI list | grep -q "alpha" || fail "list plain"
$CLI list --json | grep -q '"isDefault": true' || fail "list json"
$CLI list --json | grep -q "tok-alpha" && fail "list leaked token" || true

# default + current + env-var override
[ "$($CLI current)" = "alpha" ] || fail "current default"
$CLI use beta >/dev/null
[ "$($CLI current)" = "beta" ] || fail "use/current"
[ "$(CFSWITCH_PROFILE=gamma $CLI current)" = "gamma" ] || fail "CFSWITCH_PROFILE override"
CFSWITCH_PROFILE=gamma $CLI current --json | grep -q 'env:CFSWITCH_PROFILE' || fail "current json source"

# env output (explicit, default, json), including account id only when set
$CLI env alpha | grep -q "export CLOUDFLARE_API_TOKEN='tok-alpha'" || fail "env token"
$CLI env alpha | grep -q "export CLOUDFLARE_ACCOUNT_ID='acc-alpha'" || fail "env account id"
$CLI env beta | grep -q "CLOUDFLARE_ACCOUNT_ID" && fail "env unexpected account id" || true
$CLI env --json | grep -q '"CLOUDFLARE_API_TOKEN":"tok-beta"' || fail "env json default"

# exec injects env and propagates exit codes
$CLI exec -p alpha -- sh -c 'test "$CLOUDFLARE_API_TOKEN" = tok-alpha -a "$CLOUDFLARE_ACCOUNT_ID" = acc-alpha' || fail "exec env"
$CLI exec -p alpha -- sh -c 'exit 42' && fail "exec exit code" || [ $? -eq 42 ] || fail "exec exit code value"

# errors: unknown profile / command exit nonzero with stderr message
$CLI env nope 2>err.txt && fail "unknown profile should fail" || true
grep -q 'no profile named "nope"' err.txt || fail "unknown profile message"
$CLI frobnicate 2>err.txt && fail "unknown command should fail" || true
grep -q 'unknown command' err.txt || fail "unknown command message"
rm -f err.txt

# remove
$CLI remove gamma | grep -q 'removed profile "gamma"' || fail "remove"
$CLI list --json | grep -q gamma && fail "remove didn't remove" || true

echo "OK: all smoke tests passed"
