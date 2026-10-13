#!/usr/bin/env bash
# Before/after transcript for two defects found while documenting 1.3.0, fixed in 1.3.1.
# Produced docs/measurements/fixes-1.3.1-before-after.txt.
# Usage: bash capture-fixes-1.3.1.sh <repo-root> <work-dir> <transcript-out>
# Needs <repo-root>/.wt-before: a git worktree at v1.3.0, built, with run.mjs calling oclif's
# execute() on it. Inside the repository, so that it resolves the repository's node_modules:
#   git worktree add --detach .wt-before v1.3.0
#   npx tsc --build .wt-before
#   printf "import { execute } from '@oclif/core';\nawait execute({ dir: import.meta.url, args: process.argv.slice(2) });\n" > .wt-before/run.mjs
# Remove it afterwards with `git worktree remove --force .wt-before`.
# The "after" side is the working tree, linked into sf with `sf plugins link`.
set -u
REPO="$1"; WORK="$2"; OUT="$3"
BEFORE="$REPO/.wt-before/run.mjs"
G() { git -c user.name=docs -c user.email=docs@example.com "$@"; }

# make_project <git-root> <project-dir-inside-it>: the sample project committed to main, and a
# branch feature/pricing that changes one line of PricingService.cls.
make_project() {
  local root="$1" proj="$2"
  mkdir -p "$proj"
  cp -r "$REPO/test/fixtures/sample-project/." "$proj"
  cat > "$proj/sfdx-project.json" <<'JSON'
{
  "packageDirectories": [{ "path": "force-app", "default": true }],
  "namespace": "",
  "sourceApiVersion": "62.0"
}
JSON
  printf '.sf-testimpact/\n.sf/\n.sfdx/\n' > "$proj/.gitignore"
  G -C "$root" init -q -b main
  G -C "$root" add -A
  G -C "$root" commit -q -m "sample project"
  G -C "$root" checkout -q -b feature/pricing
  sed -i 's/Decimal total = 0;/Decimal total = 0.0;/' "$proj/force-app/main/default/classes/PricingService.cls"
  G -C "$root" commit -q -am "pricing: start the total at 0.0"
}

rm -rf "$WORK"; mkdir -p "$WORK/mono" "$WORK/flat"
make_project "$WORK/mono" "$WORK/mono/sf"   # the project in a subdirectory of its repository
make_project "$WORK/flat" "$WORK/flat"      # the same project at the root of its repository

clean() { grep -v -e 'linked ESM module' -e 'auto-transpiled' -e 'Existing compiled source' | sed -E 's/Indexing\.\.\. [0-9]+\/[0-9]+ files//g'; }
before() {
  echo "\$ node .wt-before/run.mjs testimpact $*"
  node "$BEFORE" testimpact "$@" 2>&1 | clean
  echo "[exit ${PIPESTATUS[0]}]"
  echo
}
after() {
  echo "\$ sf testimpact $*"
  sf testimpact "$@" 2>&1 | clean
  echo "[exit ${PIPESTATUS[0]}]"
  echo
}

{
  echo "# Before/after transcript: two defects found while documenting 1.3.0, fixed in 1.3.1."
  echo "# Project: test/fixtures/sample-project, given an sfdx-project.json and committed to main;"
  echo "# branch feature/pricing changes one line of PricingService.cls. Sections 1 and 2 put the"
  echo "# project in the sf/ subdirectory of its repository; section 3 puts it at the root."
  echo "# Before: sf-testimpact at tag v1.3.0 ($(git -C "$REPO/.wt-before" rev-parse --short HEAD)), built and run through oclif's execute(),"
  echo "# the entry point sf uses. After: this repository's working tree, based on $(git -C "$REPO" rev-parse --short HEAD), linked"
  echo "# with \`sf plugins link\`. The warning sf prints for a linked plugin, and the index spinner's"
  echo "# progress frames, are removed."
  echo "# Generated $(date -u +%Y-%m-%dT%H:%M:%SZ) by sf $(sf --version 2>/dev/null | head -1 | cut -d' ' -f1)."
  echo

  cd "$WORK/mono/sf" || exit 1
  echo "## What git reports from the project directory, sf/"
  echo "\$ git diff --name-status main...HEAD"
  git diff --name-status main...HEAD
  echo "\$ git diff --name-status --relative main...HEAD"
  git diff --name-status --relative main...HEAD
  echo

  echo "## 1. A project in a subdirectory of its repository, shipped defaults"
  echo "### before (1.3.0)"
  rm -rf .sf-testimpact
  before index
  before analyze --base main
  echo "### after"
  rm -rf .sf-testimpact
  after index
  after analyze --base main

  echo "## 2. The same project with entryPointPolicy: widen"
  printf 'entryPointPolicy: widen\n' > .sf-testimpact.yml
  echo "### before (1.3.0)"
  rm -rf .sf-testimpact
  before index > /dev/null
  before analyze --base main
  echo "### after"
  rm -rf .sf-testimpact
  after index > /dev/null
  after analyze --base main
  rm -f .sf-testimpact.yml

  cd "$WORK/flat" || exit 1
  echo "## 3. A flag repeated after --, project at the repository root, entryPointPolicy: widen"
  printf 'entryPointPolicy: widen\n' > .sf-testimpact.yml
  echo "### before (1.3.0)"
  rm -rf .sf-testimpact
  before index > /dev/null
  before deploy --base main --target-org my-sandbox --dry-run -- --source-dir force-app/main/default/classes/PricingService.cls --source-dir force-app/main/default/classes/PricingServiceTest.cls
  echo "### after"
  rm -rf .sf-testimpact
  after index > /dev/null
  after deploy --base main --target-org my-sandbox --dry-run -- --source-dir force-app/main/default/classes/PricingService.cls --source-dir force-app/main/default/classes/PricingServiceTest.cls
  rm -f .sf-testimpact.yml
} > "$OUT"
echo "wrote $OUT"
