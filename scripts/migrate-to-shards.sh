#!/bin/bash
#
# Migrate flat proxy store files into sharded subdirectories.
# Uses hard link + unlink (same as the runtime migration) so:
#   - No data copying (instant, same inode)
#   - Safe for concurrent readers (open fds unaffected by unlink)
#   - Never overwrites existing sharded files (ln fails with EEXIST)
#
# Usage:
#   ./scripts/migrate-to-shards.sh /mnt/eproxy-bucket
#   ./scripts/migrate-to-shards.sh /mnt/eproxy-bucket --dry-run
#   ./scripts/migrate-to-shards.sh /mnt/eproxy-bucket --batch=50000
#
# Run with ionice/nice to avoid impacting production:
#   nice -n 19 ionice -c 3 ./scripts/migrate-to-shards.sh /mnt/eproxy-bucket

set -euo pipefail

ROOT="${1:?Usage: $0 /path/to/proxy-store [--dry-run] [--batch=N]}"
DRY_RUN=false
BATCH=0
MIGRATED=0
SKIPPED=0
ERRORS=0

for arg in "${@:2}"; do
    case "$arg" in
        --dry-run) DRY_RUN=true ;;
        --batch=*) BATCH="${arg#--batch=}" ;;
    esac
done

if [ ! -d "$ROOT" ]; then
    echo "Error: $ROOT is not a directory"
    exit 1
fi

echo "Proxy store: $ROOT"
echo "Dry run: $DRY_RUN"
[ "$BATCH" -gt 0 ] 2>/dev/null && echo "Batch limit: $BATCH"
echo "---"

# Process only regular files in the root directory (not in subdirectories)
find "$ROOT" -maxdepth 1 -type f -print0 | while IFS= read -r -d '' filepath; do
    filename=$(basename "$filepath")

    # Shard directory = first 4 chars of filename
    if [ ${#filename} -ge 4 ]; then
        shard="${filename:0:4}"
    else
        shard="_misc"
    fi

    shard_dir="$ROOT/$shard"
    shard_path="$shard_dir/$filename"

    # Skip if already exists in shard (don't overwrite)
    if [ -e "$shard_path" ]; then
        SKIPPED=$((SKIPPED + 1))
        continue
    fi

    if $DRY_RUN; then
        echo "[dry-run] $filename -> $shard/$filename"
        MIGRATED=$((MIGRATED + 1))
    else
        # Create shard directory if needed
        mkdir -p "$shard_dir" 2>/dev/null || true

        # Hard link then unlink (atomic, no data copy)
        if ln "$filepath" "$shard_path" 2>/dev/null; then
            rm -f "$filepath"
            MIGRATED=$((MIGRATED + 1))
        else
            # ln can fail with EEXIST if another process migrated it concurrently
            ERRORS=$((ERRORS + 1))
        fi
    fi

    # Progress every 10,000 files
    total=$((MIGRATED + SKIPPED + ERRORS))
    if [ $((total % 10000)) -eq 0 ] && [ $total -gt 0 ]; then
        echo "Progress: migrated=$MIGRATED skipped=$SKIPPED errors=$ERRORS"
    fi

    # Stop at batch limit
    if [ "$BATCH" -gt 0 ] && [ "$MIGRATED" -ge "$BATCH" ]; then
        echo "Batch limit reached ($BATCH)"
        break
    fi
done

echo "---"
echo "Done: migrated=$MIGRATED skipped=$SKIPPED errors=$ERRORS"
