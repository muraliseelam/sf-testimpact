#!/usr/bin/env bash
# Produce every command output quoted in the user documentation, from a real run.
# Produced docs/measurements/docs-sample-project.txt. Needs the plugin linked from <repo-root>
# with `sf plugins link`. <work-dir> is deleted and recreated.
# Usage: bash capture-docs-sample-project.sh <repo-root> <work-dir> <transcript-out>
set -u
REPO="$1"; WORK="$2"; OUT="$3"
PROJ="$WORK/sample-project"

rm -rf "$WORK"; mkdir -p "$WORK"
cp -r "$REPO/test/fixtures/sample-project" "$PROJ"
cat > "$PROJ/sfdx-project.json" <<'JSON'
{
  "packageDirectories": [{ "path": "force-app", "default": true }],
  "namespace": "",
  "sourceApiVersion": "62.0"
}
JSON
printf '.sf-testimpact/\n.sf/\n.sfdx/\n' > "$PROJ/.gitignore"
cd "$PROJ" || exit 1
git init -q -b main
git -c user.name=docs -c user.email=docs@example.com add -A
git -c user.name=docs -c user.email=docs@example.com commit -q -m "sample project"
git checkout -q -b feature/pricing
sed -i 's/Decimal total = 0;/Decimal total = 0.0;/' force-app/main/default/classes/PricingService.cls
git -c user.name=docs -c user.email=docs@example.com commit -q -am "pricing: start the total at 0.0"

# Strip the warning `sf` prints for a linked (development) plugin; it is not product output.
clean() { grep -v -e 'linked ESM module' -e 'auto-transpiled' -e 'Existing compiled source' | sed -E 's/Indexing\.\.\. [0-9]+\/[0-9]+ files//g'; }
run() {
  echo "\$ $*"
  "$@" 2>&1 | clean
  echo "[exit ${PIPESTATUS[0]}]"
  echo
}

{
  echo "# Transcript behind the command output quoted in the documentation."
  echo "# Project: test/fixtures/sample-project, copied, given an sfdx-project.json, committed to"
  echo "# main; branch feature/pricing changes one line of PricingService.cls."
  echo "# Plugin: this repository's working tree at $(git -C "$REPO" rev-parse --short HEAD), linked with"
  echo "# \`sf plugins link\`; the warning sf prints for a linked plugin, and the index spinner's"
  echo "# progress frames, are removed."
  echo "# Generated $(date -u +%Y-%m-%dT%H:%M:%SZ) by sf $(sf --version 2>/dev/null | head -1 | cut -d' ' -f1)."
  echo

  echo "## index"
  run sf testimpact index

  echo "## analyze, shipped defaults"
  run sf testimpact analyze --base main

  echo "## analyze --json, shipped defaults"
  run sf testimpact analyze --base main --json

  echo "## analyze --fail-on-fallback"
  run sf testimpact analyze --base main --fail-on-fallback

  echo "## analyze --fail-on-fallback --json (status field)"
  sf testimpact analyze --base main --fail-on-fallback --json 2>/dev/null | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(JSON.stringify({status:d.status, fellBack:d.result.fellBack, outcome:d.result.outcome}))'
  echo "[exit ${PIPESTATUS[0]}]"
  echo

  echo "## analyze with entryPointPolicy: widen"
  printf 'entryPointPolicy: widen\n' > .sf-testimpact.yml
  run sf testimpact analyze --base main

  echo "## deploy --dry-run with entryPointPolicy: widen"
  run sf testimpact deploy --base main --target-org my-sandbox --dry-run

  echo "## deploy --dry-run with passthrough after --"
  run sf testimpact deploy --base main --target-org my-sandbox --dry-run -- --manifest delta/package/package.xml --wait 60

  echo "## sf's own --dry-run after --: passed through, not taken as deploy's --dry-run"
  run sf testimpact deploy --base main --target-org my-sandbox --dry-run -- --manifest delta/package/package.xml --dry-run --wait 60

  echo "## analyze with taint.dynamicApex: full"
  printf 'entryPointPolicy: widen\ntaint:\n  dynamicApex: full\n' > .sf-testimpact.yml
  run sf testimpact analyze --base main

  echo "## an unknown config key"
  printf 'entryPointPolicy: widen\nmaxReductionPct: 50\n' > .sf-testimpact.yml
  run sf testimpact analyze --base main
  rm -f .sf-testimpact.yml

  echo "## a base ref that does not exist"
  run sf testimpact analyze --base no-such-branch

  echo "## an undeclared flag (usage error)"
  run sf testimpact analyze --base main --source-dir force-app

  echo "## a required flag missing"
  run sf testimpact analyze

  echo "## no files changed"
  git checkout -q main
  run sf testimpact analyze --base main
  git checkout -q feature/pricing

  echo "## the error envelope under --json (stack and cause elided: they hold local paths)"
  echo "\$ sf testimpact analyze --base no-such-branch --json"
  sf testimpact analyze --base no-such-branch --json 2>/dev/null | node -e '
    const t = require("fs").readFileSync(0, "utf8"); const d = JSON.parse(t.slice(t.indexOf("{")));
    if (d.stack) d.stack = "<elided>"; if (d.cause) d.cause = "<elided>";
    console.log(JSON.stringify(d, null, 2));'
  echo "[exit ${PIPESTATUS[0]}]"
  echo

  echo "## no index"
  rm -rf .sf-testimpact
  run sf testimpact analyze --base main

  echo "## index --json"
  run sf testimpact index --json
} > "$OUT"
echo "wrote $OUT"
