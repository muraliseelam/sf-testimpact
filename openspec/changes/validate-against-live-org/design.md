# Design

## Context

Three things have only ever run against fakes or mocks: the org execution driver, the
`deploy` command, and the release workflow's publish step. Each has a real environment
available now, and each is validated here in the cheapest order that still produces
evidence a reader can check.

## Decisions

### Decision: a scratch org from the measured repository's own definition, not a DE org

apex-recipes ships `config/project-scratch-def.json` with the features its code needs
(PlatformCache, Walkthroughs, EnableSetPasswordInApi). A Developer Edition org on the
machine is namespaced (`atexplorer`), which would prefix every deployed class and change the
test names the adapter records; the other DE org is the Dev Hub itself. A scratch org is
clean, source-tracked (so deletions propagate, §8.3 of the correctness plan), and disposable.

**Alternative rejected:** the existing `ate-101` scratch org — it belongs to another project
and is namespaced.

### Decision: execute only commits that change something under `force-app`

A first-parent window on apex-recipes is mostly dependency bumps. A commit that changes
nothing under the source paths deploys nothing, so its outcomes are the previous
source-changing commit's outcomes; executing it costs a full suite run for no information,
and skipping it is exact for the metric (the scorer's "previous observation" has the same
deployed source as `c^`). `bench/execute.js --only-source-changes` implements the filter;
the window identity's commit count reflects it, so a store cannot be mixed between the two
modes.

### Decision: 30 commits, ending at `87c1c9b`

The same head as every selection-quality figure in the README, so the live outcomes sit on
the same tree the offline numbers describe. The base is the first parent of the 30th
source-changing first-parent commit before it. Thirty is a budget, not a sample-size
argument: on a green repository the denominator is expected to be zero whatever the window
length, and the value of the run is the first live exercise of the driver, the adapter and
the store, plus the measured fallback and reduction on real outcomes.

### Decision: validate `deploy` on the org the harness leaves behind

When the window completes the org holds the tree at `87c1c9b`, with coverage data from the
full run. `sf testimpact deploy --verify-coverage` against it exercises the Tooling API
query, the org-only-test drift check and the deploy wrapper on real data. Doing it after
the harness rather than before means no extra deploy disturbs the measurement.

### Decision: push, do not publish by hand

A manual `npm publish` needs a one-time password the maintainer must type, and it produced
the unattested 1.2.0 tarball. The automated path needs one setting on npmjs.com. Everything
up to that setting is done here; the setting is reported as the remaining step rather than
worked around.

## Risks

| Risk | Mitigation |
| --- | --- |
| An old commit fails to deploy to a v68 org | Recorded as excluded with the reason; the window continues |
| Source tracking misbehaves across detached checkouts | Every deploy result is in the store with its reason; `--deploy-mode source-dir` is the fallback |
| The run outlasts the session | The store is resumable; the same command continues it |
| The release run fails at publish | Expected until Trusted Publishing is configured; stated plainly |
