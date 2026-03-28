#!/bin/bash
#
# Migrate proxy store files into 6-character sharded subdirectories.
#
# Step 1: ./scripts/migrate-to-shards.sh /path --from-old-shards  (4-char → 6-char)
# Step 2: ./scripts/migrate-to-shards.sh /path                     (flat → 6-char)
#
# Uses hard link + unlink: no data copying, safe for concurrent readers.
#
# Run with ionice/nice to avoid impacting production:
#   nice -n 19 ionice -c 3 ./scripts/migrate-to-shards.sh /path [options]

set -euo pipefail

SHARD_LEN=6
ROOT="${1:?Usage: $0 /path/to/proxy-store [--dry-run] [--batch=N] [--from-old-shards]}"
DRY_RUN=false
FROM_OLD_SHARDS=false
BATCH=0
MIGRATED=0
SKIPPED=0
ERRORS=0

for arg in "${@:2}"; do
    case "$arg" in
        --dry-run) DRY_RUN=true ;;
        --batch=*) BATCH="${arg#--batch=}" ;;
        --from-old-shards) FROM_OLD_SHARDS=true ;;
    esac
done

[ -d "$ROOT" ] || { echo "Error: $ROOT is not a directory"; exit 1; }

migrate_file() {
    local filepath="$1"
    local filename
    filename=$(basename "$filepath")

    if [ ${#filename} -ge $SHARD_LEN ]; then
        shard="${filename:0:$SHARD_LEN}"
    else
        shard="_misc"
    fi

    shard_dir="$ROOT/$shard"
    shard_path="$shard_dir/$filename"

    if [ "$filepath" = "$shard_path" ]; then
        SKIPPED=$((SKIPPED + 1))
        return
    fi

    if [ -e "$shard_path" ]; then
        $DRY_RUN || rm -f "$filepath"
        SKIPPED=$((SKIPPED + 1))
        return
    fi

    if $DRY_RUN; then
        echo "[dry-run] $filepath -> $shard/$filename"
        MIGRATED=$((MIGRATED + 1))
    else
        mkdir -p "$shard_dir" 2>/dev/null || true
        if ln "$filepath" "$shard_path" 2>/dev/null; then
            rm -f "$filepath"
            MIGRATED=$((MIGRATED + 1))
        else
            ERRORS=$((ERRORS + 1))
        fi
    fi

    total=$((MIGRATED + SKIPPED + ERRORS))
    if [ $((total % 10000)) -eq 0 ] && [ $total -gt 0 ]; then
        echo "Progress: migrated=$MIGRATED skipped=$SKIPPED errors=$ERRORS"
    fi
}

echo "Proxy store: $ROOT"
echo "Shard length: $SHARD_LEN"
echo "Mode: $($FROM_OLD_SHARDS && echo '4-char → 6-char shards' || echo 'flat → 6-char shards')"
echo "Dry run: $DRY_RUN"
[ "$BATCH" -gt 0 ] 2>/dev/null && echo "Batch limit: $BATCH"
echo "---"

if $FROM_OLD_SHARDS; then
    # Migrate from old 4-char shard directories to 6-char shards.
    # Probe possible 4-char dir names via stat (instant) instead of
    # listing the root directory (millions of flat files = very slow).
    BASE58="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    DONE=false
    echo "Probing for 4-char shard directories..."
    for ((c=0; c<${#BASE58}; c++)); do
        $DONE && break
        for ((d=0; d<${#BASE58}; d++)); do
            $DONE && break
            # All proxy keys start with U5d (multihash sha1 prefix)
            dirname="U5${BASE58:$c:1}${BASE58:$d:1}"
            old_shard_dir="$ROOT/$dirname"
            [ -d "$old_shard_dir" ] || continue

            echo "Processing old shard: $dirname"
            while IFS= read -r -d '' filepath; do
                migrate_file "$filepath"
            done < <(find "$old_shard_dir" -maxdepth 1 -type f -print0)

            if ! $DRY_RUN; then
                rmdir "$old_shard_dir" 2>/dev/null && echo "Removed empty dir: $dirname" || true
            fi

            if [ "$BATCH" -gt 0 ] && [ "$MIGRATED" -ge "$BATCH" ]; then
                echo "Batch limit reached ($BATCH)"
                DONE=true
            fi
        done
    done
else
    # Migrate flat files from root directory
    while IFS= read -r -d '' filepath; do
        migrate_file "$filepath"
        if [ "$BATCH" -gt 0 ] && [ "$MIGRATED" -ge "$BATCH" ]; then
            echo "Batch limit reached ($BATCH)"
            break
        fi
    done < <(find "$ROOT" -maxdepth 1 -type f -print0)
fi

echo "---"
echo "Done: migrated=$MIGRATED skipped=$SKIPPED errors=$ERRORS"
