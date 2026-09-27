#!/usr/bin/env bash
# Reapply the "thinking ring" patch to the installed pi bundle.
#
# Why: the tool-intent-display extension keeps only the last N thinking runs +
# tool calls visible. Tool rows are hidden through normal extension renderers,
# but a collapsed thinking run is a plain Text rendered inside pi's
# AssistantMessageComponent, which no extension hook can hide. This patch makes
# that component consult `globalThis.__piThinkingRing`, set by the extension.
#
# The patch is lost on every `pi update`; run this script again afterwards.
# Idempotent. Restart pi for changes to take effect.
#
# Usage:
#   reapply-ring-patch.sh            # patch (or report already patched)
#   reapply-ring-patch.sh --restore  # restore the pre-patch backup, if any

set -euo pipefail

find_chunk() {
  local root f
  local -a candidates=()

  root="$(npm root -g 2>/dev/null || true)"
  if [ -n "$root" ] && [ -d "$root/@earendil-works/pi-coding-agent/dist/bundle/chunks" ]; then
    candidates+=("$root/@earendil-works/pi-coding-agent/dist/bundle/chunks/"chunk-*.js)
  fi

  if [ "${#candidates[@]}" -eq 0 ] && command -v pi >/dev/null 2>&1; then
    local pkg
    pkg="$(python3 - "$(command -v pi)" <<'PY'
import os, sys
print(os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(sys.argv[1])))))
PY
)"
    candidates+=("$pkg/dist/bundle/chunks/"chunk-*.js)
  fi

  for f in "${candidates[@]}"; do
    [ -f "$f" ] || continue
    if grep -q "thinkingVisibilityOverrides" "$f" 2>/dev/null; then
      printf '%s\n' "$f"
      return 0
    fi
  done
  return 1
}

CHUNK="$(find_chunk || true)"
if [ -z "$CHUNK" ]; then
  echo "ERROR: pi bundle chunk with the thinking renderer was not found." >&2
  echo "Make sure pi is installed, then re-run this script." >&2
  exit 1
fi

BACKUP="$CHUNK.ring-orig"

if [ "${1:-}" = "--restore" ]; then
  if [ ! -f "$BACKUP" ]; then
    echo "No backup at $BACKUP" >&2
    exit 1
  fi
  cp "$BACKUP" "$CHUNK"
  echo "restored: $CHUNK"
  echo "Restart pi for the change to take effect."
  exit 0
fi

if [ ! -f "$BACKUP" ]; then
  cp "$CHUNK" "$BACKUP"
  echo "backup: $BACKUP"
fi

python3 - "$CHUNK" <<'PY'
import sys

REPLACEMENTS = [
    (
        'message.content.some(c2=>c2.type==="text"&&c2.text.trim()||c2.type==="thinking"&&c2.thinking.trim())',
        '(message.content.some(c2=>c2.type==="text"&&c2.text.trim())||(globalThis.__piThinkingRing?.hasVisibleThinking?.(message)??message.content.some(c2=>c2.type==="thinking"&&c2.thinking.trim())))',
    ),
    (
        'if(i--,thinkingBlocks.length===0)continue;let hasVisibleContentAfter=',
        'if(i--,thinkingBlocks.length===0)continue;if(globalThis.__piThinkingRing?.isHidden?.(message,thinkingRunIndex)){thinkingRunIndex++;continue}let hasVisibleContentAfter=',
    ),
    (
        'render(width){let lines=super.render(width);return this.hasToolCalls',
        'render(width){let __r=globalThis.__piThinkingRing;__r&&__r.rev!==this.__ringRev&&(this.__ringRev=__r.rev,this.lastMessage&&this.updateContent(this.lastMessage));let lines=super.render(width);return this.hasToolCalls',
    ),
]

path = sys.argv[1]
src = open(path, encoding="utf-8").read()

if "__piThinkingRing" in src:
    print("already patched:", path)
    raise SystemExit(0)

for old, new in REPLACEMENTS:
    count = src.count(old)
    if count != 1:
        print(f"ERROR: anchor found {count} times: {old[:60]!r}", file=sys.stderr)
        raise SystemExit(1)
    src = src.replace(old, new, 1)

open(path, "w", encoding="utf-8").write(src)
print("patched:", path)
PY

echo "OK. Restart pi for the change to take effect."
