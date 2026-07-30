#!/usr/bin/env sh
# Pure-shell tests for the SITE LAYER's box-side half (POL-190). Runs ANYWHERE (macOS/Linux/CI), no
# root, no boot medium: site-conf.sh is a pure text transform, and site-firstboot.sh takes its secrets
# file, hook directory and run directory from the environment so the medium hunt is skipped entirely.
#
# What this pins, in order of how badly it would hurt to get wrong:
#   1. A credential file is PARSED, never sourced. A value containing $(...) or `...` stays literal.
#   2. An invalid file fails LOUDLY and configures NOTHING, because a silently-skipped credential means
#      a box that boots, renders perfectly and is enrolled in nothing.
#   3. Values arrive byte-exact, with no invented trailing newline (a token with a stray \n fails to
#      authenticate and the vendor's error never says why).
#   4. A failing, hanging or absent hook NEVER fails the unit, because the only output device on these
#      boxes is a public wall (D65).
# Also wrapped by a bun test (packages/e2e/site-layer.test.ts) so it runs in `bun test` / CI.
set -u
HERE="$(CDPATH= cd "$(dirname "$0")" && pwd)"
LIB="$HERE/../usr/local/lib/polyptic"
ROOT="$(mktemp -d)"; trap 'rm -rf "$ROOT"' EXIT
fails=0
ok()  { printf 'ok   - %s\n' "$1"; }
bad() { printf 'FAIL - %s\n       want=[%s] got=[%s]\n' "$1" "$2" "$3"; fails=$((fails+1)); }
eq()  { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }
has() { case "$3" in *"$2"*) ok "$1" ;; *) bad "$1" "contains: $2" "$3" ;; esac; }
hasnt() { case "$3" in *"$2"*) bad "$1" "must NOT contain: $2" "$3" ;; *) ok "$1" ;; esac; }
perms() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

conf()  { printf '%s\n' "$@" > "$ROOT/site.conf"; }
parse() { sh "$LIB/site-conf.sh" "$ROOT/site.conf" 2>"$ROOT/err"; }

# ─── site-conf.sh: parsing + validation ──────────────────────────────────────────────────────────────

# 1) absent file → nothing, exit 0. A fleet with no site secrets is the common case.
out="$(sh "$LIB/site-conf.sh" "$ROOT/nonexistent")"; rc=$?
eq "absent file is silent success" "0:" "$rc:$out"

# 2) comment-only / blank-value template → nothing, exit 0.
conf '# SITE_TENANT=' '' 'SITE_TENANT=' 'SITE_TOKEN='
out="$(parse)"; rc=$?
eq "comment/blank-value template configures nothing" "0:" "$rc:$out"

# 3) ordinary parse.
conf 'SITE_TENANT=acme' 'SITE_TOKEN=abc123'
out="$(parse)"; rc=$?
eq "ordinary parse rc" 0 "$rc"
has "tenant" "SITE_TENANT=acme" "$out"
has "token"  "SITE_TOKEN=abc123" "$out"

# 4) values are verbatim to end of line: spaces, quotes, '=' and ':' all survive unescaped.
conf 'SITE_TOKEN=a b"c=d:e/f+g==' 'SITE_URL=https://collector.internal.example:6514/path'
out="$(parse)"
has "value keeps spaces/quotes/equals" 'SITE_TOKEN=a b"c=d:e/f+g==' "$out"
has "value keeps a url with a port"    'SITE_URL=https://collector.internal.example:6514/path' "$out"

# 5) THE BIG ONE: the file is parsed, never sourced. A command substitution in a value must stay
# literal, and must not run. If this ever regresses, a boot medium becomes remote code execution as root.
conf 'SITE_TOKEN=$(touch '"$ROOT"'/pwned)`touch '"$ROOT"'/pwned2`'
out="$(parse)"
has "command substitution stays literal" 'SITE_TOKEN=$(touch' "$out"
[ ! -e "$ROOT/pwned" ] && [ ! -e "$ROOT/pwned2" ] && ok "command substitution did NOT execute" \
  || bad "command substitution did NOT execute" "no files created" "a file was created"

# 6) Notepad CRLF survives (an operator edits this on whatever is to hand).
printf 'SITE_TOKEN=abc123\r\nSITE_TENANT=acme\r\n' > "$ROOT/site.conf"
out="$(parse)"
has "CRLF token has no trailing CR" "SITE_TOKEN=abc123" "$out"
hasnt "CRLF token really has no CR" "$(printf 'abc123\r')" "$out"

# 7) a key without the SITE_ prefix is a HARD error and produces NO output.
conf 'SITE_TENANT=acme' 'FALCON_CID=nope'
out="$(parse)"; rc=$?
eq "unprefixed key rc" 1 "$rc"
eq "unprefixed key produces no output" "" "$out"
has "unprefixed key explains itself" "missing the SITE_ prefix" "$(cat "$ROOT/err")"

# 8) a key with characters we cannot export is a hard error, not a silent drop.
conf 'SITE_MY-TOKEN=abc'
out="$(parse)"; rc=$?
eq "hyphenated key rc" 1 "$rc"
has "hyphenated key explains itself" "outside A-Z 0-9 _" "$(cat "$ROOT/err")"

# 9) the bare prefix has no name behind it.
conf 'SITE_=abc'
out="$(parse)"; rc=$?
eq "bare SITE_ rc" 1 "$rc"

# 10) a line with no '=' at all.
conf 'SITE_TENANT acme'
out="$(parse)"; rc=$?
eq "malformed line rc" 1 "$rc"
has "malformed line explains itself" "expected SITE_KEY=value" "$(cat "$ROOT/err")"

# 11) first occurrence wins (an edit in progress, not an error).
conf 'SITE_TOKEN=first' 'SITE_TOKEN=second'
out="$(parse)"
has "first occurrence wins" "SITE_TOKEN=first" "$out"
hasnt "second occurrence ignored" "second" "$out"

# 12) spaces around the KEY are an editor artefact and are tolerated.
conf '  SITE_TENANT =acme'
out="$(parse)"; rc=$?
eq "padded key rc" 0 "$rc"
has "padded key normalises" "SITE_TENANT=acme" "$out"

# ─── site-firstboot.sh: hook execution + secret delivery ─────────────────────────────────────────────

HOOKS="$ROOT/hooks"; RUN="$ROOT/run"
fb() {
  rm -f "$RUN/site-firstboot.done"
  POLYPTIC_LIB_DIR="$LIB" \
  POLYPTIC_SITE_HOOK_DIR="$HOOKS" \
  POLYPTIC_SITE_RUN_DIR="$RUN" \
  POLYPTIC_SITE_CONF="${FB_CONF:-}" \
    sh "$LIB/site-firstboot.sh" 2>"$ROOT/fb.err"
}

# 13) no hook directory at all → silent no-op. Every build that has no site layer is in this state, so
# it must not even print.
rm -rf "$HOOKS" "$RUN"; mkdir -p "$RUN"
out="$(fb)"; rc=$?
eq "absent hook dir is a silent no-op" "0:" "$rc:$out"

# 14) hook directory present but empty → same.
mkdir -p "$HOOKS"
out="$(fb)"; rc=$?
eq "empty hook dir is a silent no-op" "0:" "$rc:$out"

# 15) hooks run, in filename order.
cat > "$HOOKS/20-second.sh" <<EOF
#!/bin/sh
echo second >> "$ROOT/order"
EOF
cat > "$HOOKS/10-first.sh" <<EOF
#!/bin/sh
echo first >> "$ROOT/order"
EOF
chmod 0755 "$HOOKS"/*.sh
rm -f "$ROOT/order"
out="$(fb)"; rc=$?
eq "hooks exit 0" 0 "$rc"
eq "hooks run in filename order" "first
second" "$(cat "$ROOT/order")"

# 16) a non-executable file in the hook dir is ignored (an operator's stray notes.txt).
printf 'not a hook\n' > "$HOOKS/notes.txt"
rm -f "$ROOT/order"; out="$(fb)"
eq "non-executable file ignored" "first
second" "$(cat "$ROOT/order")"
rm -f "$HOOKS/notes.txt"

# 17) secrets reach a hook as environment AND as files, byte-exact with NO trailing newline.
conf 'SITE_TENANT=acme' 'SITE_TOKEN=tok en=with spaces'
FB_CONF="$ROOT/site.conf"
cat > "$HOOKS/30-capture.sh" <<EOF
#!/bin/sh
printf 'env_tenant=[%s]\n' "\$SITE_TENANT"       >> "$ROOT/captured"
printf 'env_token=[%s]\n'  "\$SITE_TOKEN"        >> "$ROOT/captured"
printf 'file_token=[%s]\n' "\$(cat "\$POLYPTIC_SITE_SECRETS_DIR/SITE_TOKEN")" >> "$ROOT/captured"
wc -c < "\$POLYPTIC_SITE_SECRETS_DIR/SITE_TOKEN" | tr -d ' ' >> "$ROOT/captured"
EOF
chmod 0755 "$HOOKS/30-capture.sh"
rm -f "$ROOT/captured"; out="$(fb)"; rc=$?
eq "hooks with secrets exit 0" 0 "$rc"
cap="$(cat "$ROOT/captured" 2>/dev/null)"
has "secret in hook environment"        'env_tenant=[acme]' "$cap"
has "secret with spaces/equals in env"  'env_token=[tok en=with spaces]' "$cap"
has "secret also staged as a file"      'file_token=[tok en=with spaces]' "$cap"
# The staged file must be EXACTLY the value with no invented trailing newline: a token with a stray \n
# fails to authenticate and the error the vendor returns never mentions whitespace.
want_bytes="$(printf '%s' 'tok en=with spaces' | wc -c | tr -d ' ')"
got_bytes="$(printf '%s\n' "$cap" | tail -n1)"
eq "secret file is exactly the value, no trailing newline" "$want_bytes" "$got_bytes"

# 18) the secrets directory is not world-readable.
eq "secrets dir is 0700" "700" "$(perms "$RUN/site-secrets")"

# 19) an INVALID site.conf still runs the hooks (with no secrets) and still exits 0, but says so loudly.
conf 'NOT_PREFIXED=x'
rm -f "$ROOT/captured"; out="$(fb)"; rc=$?
eq "invalid site.conf still exits 0" 0 "$rc"
has "invalid site.conf is loud" "invalid" "$(cat "$ROOT/fb.err")"
has "hooks ran with no secrets" 'env_token=[]' "$(cat "$ROOT/captured")"

# 20) a FAILING hook must not fail the unit, and must not stop later hooks.
FB_CONF=""
cat > "$HOOKS/05-broken.sh" <<'EOF'
#!/bin/sh
exit 3
EOF
chmod 0755 "$HOOKS/05-broken.sh"
rm -f "$ROOT/order"; out="$(fb)"; rc=$?
eq "a failing hook does not fail the unit" 0 "$rc"
has "the failure is reported" "FAILED (exit 3)" "$(cat "$ROOT/fb.err")"
eq "later hooks still ran" "first
second" "$(cat "$ROOT/order")"
rm -f "$HOOKS/05-broken.sh"

# 21) the per-boot marker stops a second run inside one boot.
rm -f "$ROOT/order"
POLYPTIC_LIB_DIR="$LIB" POLYPTIC_SITE_HOOK_DIR="$HOOKS" POLYPTIC_SITE_RUN_DIR="$RUN" \
  sh "$LIB/site-firstboot.sh" >/dev/null 2>&1
out="$(POLYPTIC_LIB_DIR="$LIB" POLYPTIC_SITE_HOOK_DIR="$HOOKS" POLYPTIC_SITE_RUN_DIR="$RUN" \
  sh "$LIB/site-firstboot.sh" 2>/dev/null)"
has "second run in one boot is skipped" "already ran this boot" "$out"

printf '\n'
if [ "$fails" -eq 0 ]; then printf 'site layer: all checks passed\n'; else printf 'site layer: %d FAILURE(S)\n' "$fails"; fi
[ "$fails" -eq 0 ]
