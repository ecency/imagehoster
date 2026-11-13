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
  # The origin's variant guard allows one client only a few rendered variants of one
  # source image per 5 minutes, so each group of checks in each run uses its own
  # source: a public image on an EXTERNAL host with a different `?v=` (base58 of the
  # full URL). It must be external: for our own uploads the proxy keys the source by
  # the upload hash and ignores the query, so every `?v=` would count as one image.
  # Override with VERIFY_SOURCE (any external image URL that ignores its query).
  local src=${VERIFY_SOURCE:-'https://files.peakd.com/file/peakd-hive/papilloncharity/23yTh8AaTZfPwahyLfaTXJYd2pPRaVhkqEP1NW6EVUy2JCrbwjiCZD6jmCQngKrNwABMZ.jpg'}
  tok() { python3 -I -c "
import sys
A='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
b=sys.argv[1].encode(); n=int.from_bytes(b,'big'); s=''
while n: n,r=divmod(n,58); s=A[r]+s
print(s)" "$src?v=$1"; }
  local run=$RANDOM
  local p; p=$(tok "$run-a")
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
    elif [[ "$got" == *vg=redirect* || "$got" == *vg=reject* ]]; then echo "  skip  $1: variant guard ($got), rerun in 5 minutes"; skips=$((skips+1))
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
  local u2="https://$HOST/p/$(tok "$run-b")?format=match&mode=fit&width=$w"
  check "poison try " "$AV" "$u2&_acc=0" '^200 image/avif .*cc=no-store'
  check "old after  " "$OLD" "$u2" '^200 image/(png|jpeg) '
  # a percent-encoded format is still negotiated, so it must be tagged too
  local pc; pc=$(tok "$run-c")
  check "encoded fmt" "$OLD" "https://$HOST/p/$pc?format=%6datch&mode=fit&width=$w" '^200 image/(png|jpeg) '
  check "encoded avif" "$AV" "https://$HOST/p/$pc?format=%6datch&mode=fit&width=$w" '^200 image/avif '
  # a client naming AVIF only with parameters must never get the catch-all JPEG/PNG
  check "param avif" "image/avif;q=0.5" "https://$HOST/p/$pc?format=match&mode=fit&width=$w" '^200 image/avif .*cc=no-store'
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
# purge <url>...: clear every Accept group's CDN key for each URL, on every host.
# The edge keys a negotiated request on its query plus `&_acc=<group>` (`?&_acc=`
# for an empty query), so a plain URL purge would miss them. Use this for a URL
# whose cached copy is wrong; a /p/ prefix purge would empty the whole image cache.
purge() {
  : "${CF_API_TOKEN:?set CF_API_TOKEN}" "${CF_ZONE_ID:?set CF_ZONE_ID}"
  local files=() u path query h pair kept g
  for u in "$@"; do
    u=${u#https://}; u=${u#http://}; u=${u#*/}
    path="/${u%%\?*}"; query=""; [[ "$u" == *\?* ]] && query=${u#*\?}
    kept=""
    IFS='&' read -ra pairs <<< "$query"
    for pair in "${pairs[@]}"; do [ -z "$pair" ] || [ "${pair%%=*}" = _acc ] || kept="${kept:+$kept&}$pair"; done
    for h in $HOSTS; do
      files+=("https://$h$path${kept:+?$kept}")
      for g in avif webp 0; do
        if [ -n "$kept" ]; then files+=("https://$h$path?$kept&_acc=$g"); else files+=("https://$h$path?&_acc=$g"); fi
      done
    done
  done
  local i rc=0
  for ((i = 0; i < ${#files[@]}; i += 30)); do
    local R
    R=$(jq -n '{files: $ARGS.positional}' --args "${files[@]:i:30}" | curl -s -X POST -H "Authorization: Bearer $CF_API_TOKEN" -H 'Content-Type: application/json' "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/purge_cache" -d @-)
    echo "purge $(( ${#files[@]} - i < 30 ? ${#files[@]} - i : 30 )) URLs: $(echo "$R" | jq -c '{success, errors}')"
    [ "$(echo "$R" | jq -r .success)" = true ] || rc=1
  done
  printf '  %s\n' "${files[@]}"
  return $rc
}
[ "$MODE" = purge ] && { shift; [ $# -gt 0 ] || { echo "usage: $0 purge <url>..."; exit 2; }; purge "$@"; exit $?; }
[ "$MODE" = apply ] || [ "$MODE" = rollback ] || { echo "usage: $0 apply|verify|rollback|purge <url>..."; exit 2; }
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
  # A type joins its group only as a whole, bare list item: at the start or after a
  # comma, and at the end or before a comma (so never `ximage/avif`).
  # Any parameter (q=0 in whatever spelling, q=0.5, extensions) or odd spacing
  # drops the client to a lower group, where at worst the origin disagrees and
  # answers no-store. A cache HIT never reaches the origin, so the edge must never
  # file a client that refused a type into the group that type is cached for.
  AVIF='(lower(http.request.headers["accept"][0]) == "image/avif" or starts_with(lower(http.request.headers["accept"][0]), "image/avif,") or lower(http.request.headers["accept"][0]) contains ",image/avif," or ends_with(lower(http.request.headers["accept"][0]), ",image/avif"))'
  WEBP='(lower(http.request.headers["accept"][0]) == "image/webp" or starts_with(lower(http.request.headers["accept"][0]), "image/webp,") or lower(http.request.headers["accept"][0]) contains ",image/webp," or ends_with(lower(http.request.headers["accept"][0]), ",image/webp"))'
  # Mentions AVIF or WebP but neither as a bare item (parameters, spacing): the origin
  # may still choose one, so such a client must not share the catch-all key, which
  # caches source formats. `_acc=x` is never cacheable: the origin answers no-store to
  # any tag that is not the request's own group, and it never computes `x`.
  MENTIONS='(lower(http.request.headers["accept"][0]) contains "image/avif" or lower(http.request.headers["accept"][0]) contains "image/webp")'
  MINE=$(jq -n --arg b "$BASE" --arg a "$AVIF" --arg w "$WEBP" --arg m "$MENTIONS" --arg t "$TAG" '[
    {action:"rewrite", enabled:true, description:($t+" Accept bucket avif for /p/ format=match + /u/"),
     expression:("(" + $b + ") and (" + $a + ")"),
     action_parameters:{uri:{query:{expression:"concat(http.request.uri.query, \"&_acc=avif\")"}}}},
    {action:"rewrite", enabled:true, description:($t+" Accept bucket webp for /p/ format=match + /u/"),
     expression:("(" + $b + ") and not (" + $a + ") and (" + $w + ")"),
     action_parameters:{uri:{query:{expression:"concat(http.request.uri.query, \"&_acc=webp\")"}}}},
    {action:"rewrite", enabled:true, description:($t+" Accept bucket other for /p/ format=match + /u/"),
     expression:("(" + $b + ") and not (" + $a + ") and not (" + $w + ") and not (" + $m + ")"),
     action_parameters:{uri:{query:{expression:"concat(http.request.uri.query, \"&_acc=0\")"}}}},
    {action:"rewrite", enabled:true, description:($t+" Accept bucket unclassified (never cached) for /p/ format=match + /u/"),
     expression:("(" + $b + ") and not (" + $a + ") and not (" + $w + ") and (" + $m + ")"),
     action_parameters:{uri:{query:{expression:"concat(http.request.uri.query, \"&_acc=x\")"}}}}
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
