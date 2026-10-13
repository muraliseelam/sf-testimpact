# CI integration

In a pull-request pipeline the tool does three things: index the branch, work out which
tests the change can affect, and validate or deploy with only those. This page shows each
step, then complete pipelines for GitHub Actions and GitLab CI.

## Check out the full history

The analysis diffs your branch against the point where it forked from the target branch,
so the clone needs both the target branch and that merge base. Most CI systems clone
shallowly by default, and the analysis then stops with `GIT_FAILED`. It fails loudly rather
than select a wrong subset, but it does fail.

- **GitHub Actions:** `actions/checkout` with `fetch-depth: 0`.
- **GitLab CI:** `GIT_DEPTH: "0"`, then fetch the target branch, as shown below.
- **Anything else:** complete a shallow clone with `git fetch --unshallow`, then make sure the
  target branch exists locally, for example with
  `git fetch origin +refs/heads/main:refs/remotes/origin/main`. A shallow target ref gives
  `no merge base` and the same error. (`--depth=0` is not a way to unshallow: git rejects it
  with "depth 0 is not a positive number".)

## Install the CLI and the plugin

The plugin is not signed by Salesforce, and with no terminal to answer the prompt the
install exits with code 13 and installs nothing. Add it to the allowlist first, and **pin
the version**, so an upgrade happens when you choose it:

```bash
npm install --global @salesforce/cli
mkdir -p ~/.config/sf
echo '["sf-testimpact"]' > ~/.config/sf/unsignedPluginAllowList.json
sf plugins install sf-testimpact@1.3.1
```

On a Windows runner the allowlist goes in `%LOCALAPPDATA%\sf\` instead; using the wrong path
fails silently.

## Cache the index

`.sf-testimpact/` is git-ignored and worth caching. Restore the most recent index built by
the same plugin version and let `index` bring it up to date. It re-parses only the files that
differ from the restored copy, and the result is identical to a fresh build.

- Key the cache on the plugin version and a hash of the source.
- Fall back to any key with the same plugin version. Without that fallback, every source
  change misses the cache and indexes from scratch.

If a restored index was written by a different build, `index` notices and re-parses every
file. Since 1.3.1 a stale cache costs time, never correctness. A cold first index takes
seconds on a few hundred classes, and about 20 seconds to over a minute on a project the size
of NPSP, about a thousand classes ([benchmarks](benchmarks.md#index-and-query-cost)).

## Analyse, and decide what to do with the answer

```bash
sf testimpact index
sf testimpact analyze --base origin/main --json > impact.json
```

`impact.json` follows the [analyze contract](commands.md#analyze---json). Branch on
`result.fellBack`, never on the length of `result.tests`: a fallback has an empty test list
and means "run everything".

To make a fallback **fail** the job instead of running the full suite, add
`--fail-on-fallback`. It exits 1 after printing the reasons. Without it, every outcome
exits 0.

## Deploy with the selected tests

`sf testimpact deploy` runs the analysis and passes the right test level and test list to
`sf project deploy start`. Validate in a pull request by passing `sf`'s own `--dry-run`
after `--`:

```bash
sf testimpact deploy --base origin/main --target-org ci-org -- --manifest delta/package/package.xml --dry-run --wait 60
```

**Deploy only what changed.** Under `RunSpecifiedTests`, Salesforce requires every Apex class
*in the deployment* to reach 75% coverage from the tests that run. The selection guarantees
that for the classes you changed, not for unchanged classes carried along in a
whole-directory deploy. So either deploy to a source-tracked org without source flags, or
build a delta manifest. [sfdx-git-delta](https://github.com/scolladon/sfdx-git-delta) does
that:

```bash
mkdir -p delta
sf sgd source delta --from origin/main --to HEAD --output-dir delta
```

It writes `delta/package/package.xml` for added and changed metadata. It is also an unsigned
plugin, so add `"sfdx-git-delta"` to the same allowlist.

Before deploying to production, add `--verify-coverage`. It refuses to deploy a changed class
the org last recorded below 75%, and warns about test classes in the org that the repository
does not have ([details](commands.md#deploy)).

## GitHub Actions

A pull-request workflow that validates against an org with only the selected tests. It
expects a repository secret `SFDX_AUTH_URL` holding the SFDX auth URL of the validation org,
which `sf org display --target-org <alias> --verbose` prints for an org you are logged in to.
Treat it like a password.

```yaml
name: Validate

on:
  pull_request:
    branches: [main]

jobs:
  validate:
    runs-on: ubuntu-latest
    env:
      SF_TESTIMPACT_VERSION: 1.3.1
      BASE: origin/${{ github.base_ref }}
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0 # the analysis needs the target branch and the merge base

      - uses: actions/setup-node@v7
        with:
          node-version: '24'

      - name: Install the Salesforce CLI and plugins
        run: |
          npm install --global @salesforce/cli
          mkdir -p ~/.config/sf
          echo '["sf-testimpact", "sfdx-git-delta"]' > ~/.config/sf/unsignedPluginAllowList.json
          sf plugins install "sf-testimpact@${SF_TESTIMPACT_VERSION}"
          sf plugins install sfdx-git-delta

      - name: Restore the index
        uses: actions/cache@v6
        with:
          path: .sf-testimpact
          key: sf-testimpact-${{ env.SF_TESTIMPACT_VERSION }}-${{ hashFiles('force-app/**') }}
          restore-keys: sf-testimpact-${{ env.SF_TESTIMPACT_VERSION }}-

      - name: Analyse the change
        run: |
          sf testimpact index
          sf testimpact analyze --base "$BASE" --json > impact.json
          jq -r '"fell back: \(.result.fellBack); selected \(.result.selectedCount) of \(.result.totalTests) test classes"' impact.json

      - name: Authenticate to the validation org
        env:
          SFDX_AUTH_URL: ${{ secrets.SFDX_AUTH_URL }}
        run: |
          printf '%s' "$SFDX_AUTH_URL" > auth.txt
          sf org login sfdx-url --sfdx-url-file auth.txt --alias ci-org
          rm auth.txt

      - name: Validate with the selected tests
        run: |
          mkdir -p delta
          sf sgd source delta --from "$BASE" --to HEAD --output-dir delta
          sf testimpact deploy --base "$BASE" --target-org ci-org -- --manifest delta/package/package.xml --dry-run --wait 60

      - uses: actions/upload-artifact@v7
        if: always()
        with:
          name: impact
          path: impact.json
```

`sf testimpact deploy` repeats the analysis it needs. The separate analyse step is there so
the decision is visible in the log and kept as an artifact.

## GitLab CI

A merge-request job that analyses the change and keeps the result. The official `node` image
has no `jq`, so the summary uses Node.

```yaml
analyse:
  image: node:24
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  variables:
    GIT_DEPTH: "0"
    SF_TESTIMPACT_VERSION: "1.3.1"
  cache:
    key: "sf-testimpact-${SF_TESTIMPACT_VERSION}"
    paths:
      - .sf-testimpact/
  script:
    - npm install --global @salesforce/cli
    - mkdir -p ~/.config/sf
    - echo '["sf-testimpact"]' > ~/.config/sf/unsignedPluginAllowList.json
    - sf plugins install "sf-testimpact@${SF_TESTIMPACT_VERSION}"
    - git fetch origin "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"
    - sf testimpact index
    - sf testimpact analyze --base "origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME" --json > impact.json
    - >-
      node -e 'const r = require("./impact.json").result;
      console.log(`fell back: ${r.fellBack}; selected ${r.selectedCount} of ${r.totalTests} test classes`)'
  artifacts:
    when: always
    paths:
      - impact.json
```

GitLab's cache is keyed by name rather than content, so one key per plugin version is
enough: `index` updates whatever it restores.

## Driving the deploy yourself

If your pipeline deploys some other way, such as `sf project deploy validate` or a
quick-deploy step, build the test arguments from `impact.json`:

```bash
if [ "$(jq -r '.result.fellBack' impact.json)" = "true" ]; then
  TEST_ARGS=(--test-level "$(jq -r '.result.testLevel' impact.json)")
elif [ "$(jq -r '.result.selectedCount' impact.json)" = "0" ]; then
  # Nothing selected. A validation must run tests, so use the conservative level.
  TEST_ARGS=(--test-level RunLocalTests)
else
  TEST_ARGS=(--test-level RunSpecifiedTests)
  while IFS= read -r test; do TEST_ARGS+=(--tests "$test"); done < <(jq -r '.result.tests[].name' impact.json)
fi
sf project deploy validate --manifest delta/package/package.xml --target-org ci-org "${TEST_ARGS[@]}"
```

Pass one `--tests` per class. `sf` rejects a comma-separated list. `sf project deploy
validate` does not accept `NoTestRun`, which is why an empty selection runs `RunLocalTests`
here. `sf testimpact deploy` uses `NoTestRun` in that case, and Salesforce allows that only
for non-production orgs.
