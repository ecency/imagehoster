#!/bin/bash
#
# Migrate proxy store files into 6-character sharded subdirectories.
#
# Modes:
#   --from-old-shards   Migrate from old 4-char shards to 6-char shards
#   (default)           Migrate flat files from root directory (slow on large dirs)
#   --build-list        Run find once, save to /tmp/migrate-flat-files.txt
#   --from-list         Process files from saved list (skips slow find scan)
#
# Examples:
#   nice -n 19 ionice -c 3 ./scripts/migrate-to-shards.sh /path --build-list
#   nice -n 19 ionice -c 3 ./scripts/migrate-to-shards.sh /path --from-list --batch=500000
#
# Uses hard link + unlink: no data copying, safe for concurrent readers.

set -euo pipefail

SHARD_LEN=6
LIST_FILE="/tmp/migrate-flat-files.txt"
LIST_POS_FILE="/tmp/migrate-flat-files.pos"

ROOT="${1:?Usage: $0 /path/to/proxy-store [--dry-run] [--batch=N] [--from-old-shards] [--build-list] [--from-list]}"
DRY_RUN=false
FROM_OLD_SHARDS=false
BUILD_LIST=false
FROM_LIST=false
BATCH=0
MIGRATED=0
SKIPPED=0
ERRORS=0

for arg in "${@:2}"; do
    case "$arg" in
        --dry-run) DRY_RUN=true ;;
        --batch=*) BATCH="${arg#--batch=}" ;;
        --from-old-shards) FROM_OLD_SHARDS=true ;;
        --build-list) BUILD_LIST=true ;;
        --from-list) FROM_LIST=true ;;
    esac
done

[ -d "$ROOT" ] || { echo "Error: $ROOT is not a directory"; exit 1; }

migrate_file() {
    local filepath="$1"
    local filename
    filename=$(basename "$filepath")

    # File might already be migrated/deleted by now — skip silently
    [ -e "$filepath" ] || { SKIPPED=$((SKIPPED + 1)); return; }

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
if $BUILD_LIST; then
    echo "Mode: build file list"
elif $FROM_LIST; then
    echo "Mode: migrate from saved list"
elif $FROM_OLD_SHARDS; then
    echo "Mode: 4-char → 6-char shards"
else
    echo "Mode: flat → 6-char shards (slow find scan)"
fi
echo "Dry run: $DRY_RUN"
[ "$BATCH" -gt 0 ] 2>/dev/null && echo "Batch limit: $BATCH"
echo "---"

if $BUILD_LIST; then
    # One-time scan of flat directory, save filenames to list file.
    # Subsequent runs use --from-list to skip the slow find scan.
    echo "Scanning $ROOT for flat files (this may take a long time)..."
    echo "Output: $LIST_FILE"
    find "$ROOT" -maxdepth 1 -type f > "$LIST_FILE.tmp"
    mv "$LIST_FILE.tmp" "$LIST_FILE"
    echo 0 > "$LIST_POS_FILE"
    count=$(wc -l < "$LIST_FILE")
    echo "Done: $count flat files found, saved to $LIST_FILE"
elif $FROM_LIST; then
    # Process files from the pre-built list, resuming from saved position
    [ -f "$LIST_FILE" ] || { echo "Error: $LIST_FILE not found. Run --build-list first."; exit 1; }
    START_POS=$(cat "$LIST_POS_FILE" 2>/dev/null || echo 0)
    TOTAL_LINES=$(wc -l < "$LIST_FILE")
    echo "Resuming from line $START_POS of $TOTAL_LINES"

    line_num=0
    POS=$START_POS
    while IFS= read -r filepath; do
        line_num=$((line_num + 1))
        # Skip lines before resume position
        [ $line_num -le $START_POS ] && continue
        migrate_file "$filepath"
        POS=$line_num
        # Save position every 10000 entries
        if [ $((line_num % 10000)) -eq 0 ]; then
            echo "$POS" > "$LIST_POS_FILE"
        fi
        if [ "$BATCH" -gt 0 ] && [ "$MIGRATED" -ge "$BATCH" ]; then
            echo "Batch limit reached ($BATCH)"
            break
        fi
    done < "$LIST_FILE"
    echo "$POS" > "$LIST_POS_FILE"
    echo "Position saved: $POS / $TOTAL_LINES"
elif $FROM_OLD_SHARDS; then
    # Migrate from old 4-char shard directories to 6-char shards.
    BASE58="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    DONE=false
    echo "Probing for 4-char shard directories..."
    for ((c=0; c<${#BASE58}; c++)); do
        $DONE && break
        for ((d=0; d<${#BASE58}; d++)); do
            $DONE && break
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
    # Migrate flat files from root directory (slow live find scan)
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
