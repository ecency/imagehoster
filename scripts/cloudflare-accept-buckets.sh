#!/bin/bash
# Cloudflare URL rewrites that give each Accept group its own cache entry (#61).
#
# Why: format=match proxy URLs (and requests with no format) and /u/ avatars and
# covers are negotiated from the Accept header (AVIF > WebP > source format). The
# origin sends `Vary: Accept`, but Cloudflare caches one body per URL, so the first
# client to warm a URL would fix its format for everyone: a large PNG for AVIF
# browsers, or AVIF for clients that cannot decode it.
#
# What: three rewrites in the http_request_transform phase. They run before the
# cache, so the rewritten query is the cache key. Each appends a tag the origin
# ignores (test/proxy-formats.ts pins that):
#   &_acc=avif   Accept names image/avif
#   &_acc=webp   Accept names image/webp but not image/avif
#   &_acc=0      everything else
# Skipped for explicit formats, for HTML-escaped `amp;` queries (the origin 301s
# those to the clean URL, which is then tagged) and for queries already tagged.
#
# The rules are written FIRST in the phase. When two rewrites set the query, the
# later rule wins, so any rewrite that must override these for some requests has to
# come after them. Other rules in the phase are kept, in their order.
#
# Requires CF_API_TOKEN (zone Transform Rules edit) and CF_ZONE_ID.
#   scripts/cloudflare-accept-buckets.sh apply      back up the phase, write the rules, verify
#   scripts/cloudflare-accept-buckets.sh verify     CDN checks only, no writes
#   scripts/cloudflare-accept-buckets.sh rollback   remove the three rules
set -euo pipefail
MODE=${1:-}
# Hostnames the rules apply to (space separated); verify uses the first
HOSTS=${IMAGE_HOSTS:-i.ecency.com images.ecency.com}
HOST=${HOSTS%% *}
TAG="imagehoster #61:"

verify() {
  # base58 of a public Hive image URL
  local p='EEEoA8oLaAxtTLvNAHVkbHyZnaYNv3ezuYaNDttUYueEDS1yWu159sLYw3QcuS3Y36r8dm8sEDqRML2XuhHhuEiMm3DWj264TfT6YuY2WUvDxUKvTZW7UFbPSVLUfHDygHN1WcDnNf7b4Ss9NV6P8'
  local w=$(( 41 + RANDOM % 200 ))
  local u="https://$HOST/p/$p?format=match&mode=fit&width=$w"
  local av="https://$HOST/u/${VERIFY_USER:-ecency}/avatar/medium"
  local AV='image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
  local WB='image/webp,image/apng,image/*,*/*;q=0.8'
  local OLD='image/jpeg,image/png,image/*;q=0.8'
  local fails=0 skips=0
  # check <label> <accept> <url> <regex over "code type cache-status cache-control">
  check() {
    local got
    got=$(curl -s -m 30 -o /dev/null -H "Accept: $2" -w '%{http_code} %{content_type} cf=%header{cf-cache-status} cc=%header{cache-control} vg=%header{x-variant-guard}' "$3")
    if [[ "$got" =~ $4 ]]; then echo "  ok    $1: $got"
    # the origin's variant-walk guard redirects one client past a few variants of one
    # image in 5 minutes; that is not a rule failure, just rerun later
    elif [[ "$got" == *vg=redirect* ]]; then echo "  skip  $1: variant guard redirect, rerun in 5 minutes"; skips=$((skips+1))
    else echo "  FAIL  $1: $got (want /$4/)"; fails=$((fails+1)); fi
  }
  echo "proxy, fresh width $w"
  check "avif first " "$AV" "$u" '^200 image/avif '
  check "old next   " "$OLD" "$u" '^200 image/(png|jpeg) '
  check "webp next  " "$WB" "$u" '^200 image/webp '
  check "avif again " "$AV" "$u" '^200 image/avif cf=HIT'
  check "explicit   " "$OLD" "https://$HOST/p/$p?format=avif&mode=fit&width=$w" '^200 image/avif '
  # a client-supplied tag for another group must never be cached (origin answers no-store).
  # On its own cold width: the checks above already warmed $u's groups at the edge.
  local u2="https://$HOST/p/$p?format=match&mode=fit&width=$((w + 1))"
  check "poison try " "$AV" "$u2&_acc=0" '^200 image/avif .*cc=no-store'
  check "old after  " "$OLD" "$u2" '^200 image/(png|jpeg) '
  # a percent-encoded format is still negotiated, so it must be tagged too
  check "encoded fmt" "$OLD" "https://$HOST/p/$p?format=%6datch&mode=fit&width=$((w + 2))" '^200 image/(png|jpeg) '
  check "encoded avif" "$AV" "https://$HOST/p/$p?format=%6datch&mode=fit&width=$((w + 2))" '^200 image/avif '
  local loc
  loc=$(curl -s -m 30 -o /dev/null -w '%{http_code} %{redirect_url}' "https://$HOST/p/$p?format=match&amp;mode=fit&amp;width=$w")
  if [[ "$loc" =~ ^301\  && "$loc" != *_acc* ]]; then echo "  ok    amp form   : $loc"; else echo "  FAIL  amp form   : $loc (want a 301 without _acc)"; fails=$((fails+1)); fi
  echo "avatar"
  check "avif       " "$AV" "$av" '^200 image/avif '
  check "old        " "$OLD" "$av" '^200 image/(png|jpeg) '
  check "webp       " "$WB" "$av" '^200 image/webp '
  [ "$fails" = 0 ] || { echo "verify: $fails check(s) FAILED"; return 1; }
  [ "$skips" = 0 ] && echo "verify: all checks passed" || { echo "verify: no failures, $skips skipped (variant guard), rerun in 5 minutes"; return 2; }
}

[ "$MODE" = verify ] && { verify; exit $?; }
[ "$MODE" = apply ] || [ "$MODE" = rollback ] || { echo "usage: $0 apply|verify|rollback"; exit 2; }
: "${CF_API_TOKEN:?set CF_API_TOKEN}" "${CF_ZONE_ID:?set CF_ZONE_ID}"
EP="https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/rulesets/phases/http_request_transform/entrypoint"
H=(-H "Authorization: Bearer $CF_API_TOKEN" -H 'Content-Type: application/json')

CUR=$(curl -s "${H[@]}" "$EP")
# A zone with no transform rules yet has no entrypoint (404): start from an empty list
if [ "$(echo "$CUR" | jq -r .success)" != true ]; then
  echo "$CUR" | jq -e '.errors[]? | select(.code == 10003)' >/dev/null || { echo "GET failed: $(echo "$CUR" | jq -c .errors)"; exit 1; }
  CUR='{"result":{"rules":[]}}'
fi
BAK="${BACKUP_DIR:-.}/transform-before-accept-buckets-$(date -u +%Y%m%dT%H%M%SZ).json"
echo "$CUR" > "$BAK"
OTHERS=$(echo "$CUR" | jq --arg t "$TAG" '[.result.rules[]? | select((.description // "") | startswith($t) | not) | {action,expression,description,enabled,action_parameters}]')

if [ "$MODE" = rollback ]; then
  RULES="$OTHERS"
else
  HOSTSET=$(printf '"%s" ' $HOSTS); HOSTSET=${HOSTSET% }
  BASE="(http.host in {$HOSTSET}) and ((starts_with(http.request.uri.path, \"/p/\") and not (len(http.request.uri.args[\"format\"]) == 1 and http.request.uri.args[\"format\"][0] in {\"jpeg\" \"jpg\" \"png\" \"webp\" \"avif\"})) or starts_with(http.request.uri.path, \"/u/\")) and not http.request.uri.query contains \"amp;\" and not any(starts_with(http.request.uri.args.names[*], \"amp;\")) and not any(http.request.uri.args.names[*] == \"_acc\")"
  # an explicit q=0 refuses the type; also catches q=0.5, which then only disagrees
  # with the origin and is answered no-store, never served the wrong format
  AVIF='(lower(http.request.headers["accept"][0]) contains "image/avif" and not lower(http.request.headers["accept"][0]) contains "image/avif;q=0" and not lower(http.request.headers["accept"][0]) contains "image/avif; q=0")'
  # an explicit q=0 refuses the type; also catches q=0.5, which then only disagrees
  # with the origin and is answered no-store, never served the wrong format
  WEBP='(lower(http.request.headers["accept"][0]) contains "image/webp" and not lower(http.request.headers["accept"][0]) contains "image/webp;q=0" and not lower(http.request.headers["accept"][0]) contains "image/webp; q=0")'
  MINE=$(jq -n --arg b "$BASE" --arg a "$AVIF" --arg w "$WEBP" --arg t "$TAG" '[
    {action:"rewrite", enabled:true, description:($t+" Accept bucket avif for /p/ format=match + /u/"),
     expression:("(" + $b + ") and (" + $a + ")"),
     action_parameters:{uri:{query:{expression:"concat(http.request.uri.query, \"&_acc=avif\")"}}}},
    {action:"rewrite", enabled:true, description:($t+" Accept bucket webp for /p/ format=match + /u/"),
     expression:("(" + $b + ") and not (" + $a + ") and (" + $w + ")"),
     action_parameters:{uri:{query:{expression:"concat(http.request.uri.query, \"&_acc=webp\")"}}}},
    {action:"rewrite", enabled:true, description:($t+" Accept bucket other for /p/ format=match + /u/"),
     expression:("(" + $b + ") and not (" + $a + ") and not (" + $w + ")"),
     action_parameters:{uri:{query:{expression:"concat(http.request.uri.query, \"&_acc=0\")"}}}}
  ]')
  RULES=$(jq -n --argjson m "$MINE" --argjson o "$OTHERS" '$m + $o')
fi
R=$(curl -s -X PUT "${H[@]}" "$EP" -d "$(jq -n --argjson r "$RULES" '{rules:$r}')")
echo "$R" | jq -r '"success=\(.success) version=\(.result.version // "-") errors=\(.errors)"'
echo "$R" | jq -r '.result.rules[]?.description' | nl
echo "backup: $BAK"
[ "$(echo "$R" | jq -r .success)" = true ] || { echo "PUT FAILED, rules unchanged"; exit 1; }
if [ "$MODE" = apply ]; then
  echo "waiting 45s for propagation..."; sleep 45; verify || exit 1
fi
