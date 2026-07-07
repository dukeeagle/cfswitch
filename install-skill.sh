#!/usr/bin/env bash
# Install the cfswitch agent skill for Claude Code, Codex, and Cursor.
#
# Layout after install (hub-and-spoke, so every agent sees one source of truth):
#   ~/.agents/skills/cfswitch  -> <this repo>/skills/cfswitch   (hub; Cursor reads this)
#   ~/.claude/skills/cfswitch  -> ../../.agents/skills/cfswitch (Claude Code)
#   ~/.codex/skills/cfswitch   -> ../../.agents/skills/cfswitch (Codex)
#
# Usage:
#   ./install-skill.sh          # symlink (skill updates when you git pull)
#   ./install-skill.sh --copy   # copy files instead (survives deleting the repo)
#   ./install-skill.sh --uninstall
set -euo pipefail

SKILL_NAME="cfswitch"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/skills/$SKILL_NAME"
HUB="$HOME/.agents/skills"
SPOKES=("$HOME/.claude/skills" "$HOME/.codex/skills")

[ -f "$SRC/SKILL.md" ] || { echo "error: $SRC/SKILL.md not found" >&2; exit 1; }

link() { # link <target> <linkpath> — replace symlinks, never clobber real dirs
  local target=$1 linkpath=$2
  if [ -e "$linkpath" ] && [ ! -L "$linkpath" ]; then
    echo "skip: $linkpath exists and is not a symlink (remove it manually to adopt this install)" >&2
    return 0
  fi
  ln -sfn "$target" "$linkpath"
  echo "linked: $linkpath -> $target"
}

if [ "${1:-}" = "--uninstall" ]; then
  for p in "$HUB/$SKILL_NAME" "${SPOKES[@]/%//$SKILL_NAME}"; do
    if [ -L "$p" ]; then rm "$p" && echo "removed: $p"
    elif [ -d "$p" ]; then echo "skip: $p is a real directory, not removing" >&2
    fi
  done
  exit 0
fi

mkdir -p "$HUB" "${SPOKES[@]}"

if [ "${1:-}" = "--copy" ]; then
  if [ -e "$HUB/$SKILL_NAME" ] && [ ! -L "$HUB/$SKILL_NAME" ]; then
    echo "skip: $HUB/$SKILL_NAME already exists" >&2
  else
    rm -f "$HUB/$SKILL_NAME"
    cp -R "$SRC" "$HUB/$SKILL_NAME"
    echo "copied: $HUB/$SKILL_NAME"
  fi
else
  link "$SRC" "$HUB/$SKILL_NAME"
fi

# Spokes chain through the hub with relative links, so the whole ~/. tree is relocatable.
for spoke in "${SPOKES[@]}"; do
  link "../../.agents/skills/$SKILL_NAME" "$spoke/$SKILL_NAME"
done

fail=0
for p in "$HUB/$SKILL_NAME" "${SPOKES[@]/%//$SKILL_NAME}"; do
  if [ -f "$p/SKILL.md" ]; then echo "ok: $p/SKILL.md"; else echo "BROKEN: $p/SKILL.md unreadable" >&2; fail=1; fi
done
exit $fail
