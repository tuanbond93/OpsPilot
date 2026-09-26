#!/usr/bin/env bash
# Vercel's Ignored Build Step: 0 skips a build, 1 runs it.
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf 'GIT_METADATA_AVAILABLE=false\nCHANGE_DETECTION_MODE=vercel-fallback\n'
  exit 1
fi

printf 'GIT_METADATA_AVAILABLE=true\n'
if ! git rev-parse --verify 'HEAD^' >/dev/null 2>&1; then
  printf 'CHANGE_DETECTION_MODE=history-fallback\n'
  exit 1
fi

printf 'CHANGE_DETECTION_MODE=git-diff\n'
git diff HEAD^ HEAD --quiet -- . ':(exclude).github/**'
exit $?
