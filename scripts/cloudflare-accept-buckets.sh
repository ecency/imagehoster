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
  req() { curl -s -m 30 -o /dev/null -H "Accept: $1" -w "%{http_code} %{content_type} %{size_download}B cf=%header{cf-cache-status}" "$2"; }
  echo "proxy, fresh width $w: each Accept group gets its own format, repeats HIT"
  echo "  avif  first : $(req "$AV" "$u")   expect image/avif"
  echo "  old   next  : $(req "$OLD" "$u")   expect image/png or image/jpeg"
  echo "  webp  next  : $(req "$WB" "$u")   expect image/webp"
  echo "  avif  again : $(req "$AV" "$u")   expect image/avif HIT"
  echo "  explicit    : $(req "$OLD" "https://$HOST/p/$p?format=avif&mode=fit&width=$w")   expect image/avif (untouched)"
  echo "  &amp; form  : $(curl -s -m 30 -o /dev/null -w '%{http_code} -> %{redirect_url}' "https://$HOST/p/$p?format=match&amp;mode=fit&amp;width=$w")"
  echo "                expect 301 to the clean URL, without _acc"
  echo "avatar"
  echo "  avif        : $(req "$AV" "$av")   expect image/avif"
  echo "  old         : $(req "$OLD" "$av")   expect image/png or image/jpeg"
  echo "  webp        : $(req "$WB" "$av")   expect image/webp"
}

[ "$MODE" = verify ] && { verify; exit; }
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
  BASE="(http.host in {$HOSTSET}) and ((starts_with(http.request.uri.path, \"/p/\") and (not http.request.uri.query contains \"format=\" or http.request.uri.query contains \"format=match\")) or starts_with(http.request.uri.path, \"/u/\")) and not http.request.uri.query contains \"amp;\" and not http.request.uri.query contains \"_acc=\""
  AVIF='http.request.headers["accept"][0] contains "image/avif"'
  WEBP='http.request.headers["accept"][0] contains "image/webp"'
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
if [ "$MODE" = apply ] && [ "$(echo "$R" | jq -r .success)" = true ]; then
  echo "waiting 45s for propagation..."; sleep 45; verify
fi
