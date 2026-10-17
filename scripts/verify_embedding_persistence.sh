#!/usr/bin/env bash
# Verifies that a TUI boot does not rewrite memory.embeddings.enabled.
# Usage:  scripts/verify_embedding_persistence.sh          # one boot cycle (default)
#         BOOTS=3 scripts/verify_embedding_persistence.sh  # three cycles
#         BOOT_SECS=40 ...                                 # longer settle time
#         NO_RESTORE=1 ...                                 # keep the post-boot config
# Exit 0 = flag survived every boot and rows are 173x768.
# NB: do not run while another Atomic Agent TUI is open.
set -uo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
STATE=${STATE_DIR:-$HOME/.atomic-agent}
CFG=$STATE/config.json
DB=$STATE/memory.sqlite
BACKUP=$STATE/config.json.pre-verify
BOOTS=${BOOTS:-1}
BOOT_SECS=${BOOT_SECS:-30}
fail=0

flag() { python3 -c "import json;print(str(json.load(open('$CFG'))['memory']['embeddings']['enabled']).lower())"; }
rows() { # WAL may be held by a live TUI; retry before calling it a miss
  local out i
  for i in 1 2 3 4 5; do
    out=$(sqlite3 -cmd '.timeout 3000' "$DB" "select model||'|'||dim||'|'||count(*) from memory_embeddings group by model,dim;" 2>&1) && { printf '%s\n' "$out"; return; }
    sleep 1
  done
  printf 'error: %s\n' "${out:-unknown}"
}
check() { if [ "$2" = "$3" ]; then echo "PASS  $1 ($3)"; else echo "FAIL  $1  expected=[$2] got=[$3]"; fail=1; fi; }

boot() { # $1 = log path; one TUI boot in a pty, SIGTERM'd after BOOT_SECS
  ( cd "$REPO" && script -q /dev/null npx tsx src/cli/index.ts tui </dev/null ) >"$1" 2>&1 &
  local pid=$!
  sleep "$BOOT_SECS"
  pkill -TERM -P "$pid" 2>/dev/null
  kill -TERM "$pid" 2>/dev/null
  sleep 2
  pkill -KILL -P "$pid" 2>/dev/null; kill -KILL "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
}

cp "$CFG" "$BACKUP" || { echo "cannot back up $CFG"; exit 2; }
before=$(flag); before_hash=$(shasum -a 256 "$CFG" | cut -d' ' -f1)
echo "config before: enabled=$before"
echo "shim health  : $(curl -s -m 3 127.0.0.1:19092/health || echo DOWN)"
echo "rows before  : $(rows)"

check "flag pre-boot" true "$before"

for i in $(seq 1 "$BOOTS"); do
  log=/tmp/atomic-boot-$i.log
  echo "--- boot $i ($BOOT_SECS s, log $log)"
  boot "$log"
  after=$(flag)
  check "flag after boot $i" true "$after"
  check "memory_embeddings sum" "nomic-embed-text-v1.5|768|173" "$(rows | sort | tr '\n' ' ' | sed 's/ $//')"
  grep -iE 'embedding|llama|shim' "$log" | tail -5 | sed 's/^/    log: /'
done

echo "config after : enabled=$(flag), hash=$(shasum -a 256 "$CFG" | cut -d' ' -f1) (before $before_hash)"
if [ "$(flag)" != "$before" ] && [ -z "${NO_RESTORE:-}" ]; then
  cp "$BACKUP" "$CFG" && echo "restored pre-run config from $BACKUP"
fi

[ "$fail" -eq 0 ] && echo "RESULT: PASS" || echo "RESULT: FAIL"
exit "$fail"
