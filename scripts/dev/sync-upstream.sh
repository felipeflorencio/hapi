#!/usr/bin/env bash
set -euo pipefail

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
TARGET_BRANCH="${1:-$CURRENT_BRANCH}"

echo "🔄 Fetching upstream..."
git fetch upstream

echo "📌 Fast-forwarding local main to upstream/main..."
git checkout main
git merge --ff-only upstream/main

if [ "$TARGET_BRANCH" != "main" ]; then
    echo "🔀 Rebasing $TARGET_BRANCH onto main..."
    git checkout "$TARGET_BRANCH"
    git rebase main
    echo "✅ Successfully rebased $TARGET_BRANCH onto latest upstream/main!"
else
    echo "✅ Main is now up to date with upstream/main!"
fi
