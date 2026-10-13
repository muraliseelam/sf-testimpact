#!/usr/bin/env bash
# Re-capture the apex-recipes quickstart with the current build, for docs/getting-started.md.
# Produced docs/measurements/quickstart-apex-recipes-1.3.1.txt. Needs the plugin linked with
# `sf plugins link`, and PLUGIN_COMMIT set to the commit it was built from.
# Usage: PLUGIN_COMMIT=<sha> bash capture-quickstart-apex-recipes.sh <apex-recipes clone at 2e2c1c3a> <transcript-out>
set -u
AR="$1"; OUT="$2"
cd "$AR" || exit 1
BASE=$(git rev-parse HEAD^1)
rm -rf .sf-testimpact .sf-testimpact.yml

clean() { grep -v -e 'linked ESM module' -e 'auto-transpiled' -e 'Existing compiled source' | sed -E 's/Indexing\.\.\. [0-9]+\/[0-9]+ files//g'; }
run() {
  echo "\$ $*"
  "$@" 2>&1 | clean
  echo "[exit ${PIPESTATUS[0]}]"
  echo
}

{
  echo "Verbatim capture. Repository: https://github.com/trailheadapps/apex-recipes (CC0-1.0)"
  echo "Commit under test: $(git rev-parse HEAD)  ($(git log -1 --format=%s))"
  echo "Base (parent):     $BASE"
  echo "Changed files:     $(git diff --name-only HEAD^1 HEAD | tr '\n' ' ')"
  echo "Plugin:            sf-testimpact working tree at $PLUGIN_COMMIT (the fixes released as 1.3.1), linked with \`sf plugins link\`"
  echo "Captured:          $(date -u +%Y-%m-%dT%H:%M:%SZ) with $(sf --version 2>/dev/null | head -1 | cut -d' ' -f1)"
  echo "Removed:           the warning sf prints for a linked plugin, and the index spinner's progress frames"
  echo

  echo "--- first index ---"
  run sf testimpact index
  echo "--- second index, nothing changed ---"
  run sf testimpact index

  echo "--- shipped defaults (no .sf-testimpact.yml; entryPointPolicy: full) ---"
  run sf testimpact analyze --base "$BASE"

  echo "--- .sf-testimpact.yml -> entryPointPolicy: widen ---"
  printf 'entryPointPolicy: widen\n' > .sf-testimpact.yml
  run sf testimpact analyze --base "$BASE"

  echo "--- deploy, printed rather than run ---"
  run sf testimpact deploy --base "$BASE" --target-org my-sandbox --dry-run
  rm -f .sf-testimpact.yml
} > "$OUT"
echo "wrote $OUT"
