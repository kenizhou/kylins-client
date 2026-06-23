#!/usr/bin/env bash
# PreToolUse gate for `git commit`: require the /simplify skill to have run
# on the staged changes before the commit is allowed through.
#
# Because /simplify is a model-driven skill (a shell hook cannot invoke it
# directly), this gate enforces it with a self-resetting marker file that
# lives inside .git/ (so it is never committed):
#
#   1. Claude calls `git commit`. No marker exists -> the hook DENIES the
#      call and the reason tells Claude to run /simplify, then `touch` the
#      marker, then retry the commit.
#   2. Claude runs /simplify, touches the marker, retries `git commit`.
#   3. The hook sees the marker, DELETES it (so the *next* commit gates
#      again), and allows this one through.
#
# This gives one-shot bypass-after-simplify with no infinite loop.
set -u

git_dir="$(git rev-parse --git-dir 2>/dev/null || true)"
[ -n "$git_dir" ] || exit 0              # not a git repo -> allow
marker="$git_dir/.simplify-ok"

if [ -f "$marker" ]; then
  rm -f "$marker"                        # consume -> next commit gates again
  exit 0                                 # allow the commit
fi

# No marker yet: block until /simplify has run and the marker is touched.
# Only the marker path is interpolated; the rest of the JSON is literal.
printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Run the /simplify skill on the staged changes first, then run: touch %s -- then retry the commit. (The marker is consumed automatically on commit.)"}}\n' "$marker"
