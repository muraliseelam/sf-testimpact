# Tasks

## 1. Fix what the documentation would otherwise have to describe as broken

- [x] 1.1 `taint.dynamicApex` / `taint.dynamicSoql: full` fall back when the governed domain
      activates and holds a dynamic construct; parse-failure taint excluded. Tests.
- [x] 1.2 `taint.unmodelledFileType: widen` emits `unmodelled-file-type-ignored`. Test.
- [x] 1.3 `analyze --json` carries `decisions[].subjects`. Test.
- [x] 1.4 `runIndex` re-extracts everything when the stored index is stale; `index` says so.
      Test.
- [x] 1.5 A coverage blocker raises `COVERAGE_BLOCKED`, not `GRAPH_STALE`.
- [x] 1.6 `deploy`'s passthrough example deploys a delta manifest, not the whole directory.

Found while writing the pages and capturing their output, and fixed the same way:

- [x] 1.7 Unindexed changed files are classified by the extractors, not a hand-kept
      extension list that had drifted: every LWC change was told to re-run the index, and
      new profiles, validation rules, static resources, permission-set groups and object
      translations were reported as unmodelled types.
- [x] 1.8 The stale-index fallbacks point at plain `index`, which now re-parses on its own,
      not at `--force`.
- [x] 1.9 A test class with a `SeeAllData=true` test *method* always runs, as one with the
      class annotation does. The Apex extractor identity moves to `apex@2`.
- [x] 1.10 A project in a subdirectory of its git repository reads changed paths relative
      to the project (`git diff --relative`). Before, every change was ignored and only
      always-run tests were selected: a silent false negative at the default.
- [x] 1.11 `deploy` passes everything after `--` through in the order written; a repeated
      flag had lost its pairing with its values. A positional argument before `--` is
      reported as `CONFIG_INVALID` instead of being forwarded.

## 2. Documentation set

- [x] 2.1 `docs/README.md` — the map.
- [x] 2.2 `docs/getting-started.md`.
- [x] 2.3 `docs/how-it-works.md`.
- [x] 2.4 `docs/configuration.md` — every key, verified against `src/config/`.
- [x] 2.5 `docs/commands.md` — generated reference, plus exit codes, JSON contract,
      passthrough. `npm run docs:commands`; CI fails when it is stale.
- [x] 2.6 `docs/rules.md` — every decision rule and error code the code can emit.
- [x] 2.7 `docs/ci.md` — GitHub Actions and GitLab CI, with caching that survives upgrades.
- [x] 2.8 `docs/troubleshooting.md` — problems actually observed, and an FAQ.
- [x] 2.9 `docs/limitations.md`, `docs/benchmarks.md` — moved from the README verbatim, with
      dated notes where a later fix changes how a figure reads.
- [x] 2.10 `docs/api.md` — the programmatic API, with an example that has been run.

## 3. README and cross-references

- [x] 3.1 README becomes a landing page.
- [x] 3.2 Every relative link and anchor in the documentation resolves, checked by
      `test/unit/docs.links.test.ts` on every CI run.
- [x] 3.3 `AUDIT.md` notes the move; the release checklist checks the new location.

## 4. Verify and ship

- [x] 4.1 Every command output quoted in the new pages is from a real run, retained in
      `docs/measurements/`: `docs-sample-project.txt`, `quickstart-apex-recipes-1.3.1.txt`
      and `fixes-1.3.1-before-after.txt`, with the scripts that produced them.
- [x] 4.2 `npm run check`; CI green. 827 tests; CI run 38344202638 passed on Node 22.13 and
      24, including the new command-reference check.
- [x] 4.3 Release (the fixes are `fix:` commits) and confirm npm shows the new README.
      Release run 38344202651 published 1.3.1 through Trusted Publishing, with provenance;
      npmjs.com shows the landing-page README, its relative links resolved to GitHub.
