# Validate against a live org and get the release path working

## Why

Every number this project publishes was produced offline. The README says so, three times:
the tool "has never been run against a live Salesforce org", `deploy --verify-coverage` "has
been exercised only against mocks", and the false-negative rate "has never been measured".
The harness that would measure it is built, unit-tested, and has never met real `sf` output.

Separately, the automated release has been broken since 2026-09-09: the npm token path fails
with `EOTP`, and 1.2.0 reached npm by hand. The workflow has been cut over to Trusted
Publishing, but that has not been proven by a release either.

A Dev Hub is now authenticated on the measuring machine. That removes the one blocker that
was not code, so this change does the three things that were waiting on it.

## What changes

1. **Run the false-negative harness against a scratch org**, on a 30-commit window of
   apex-recipes commits that change something under `force-app`, and record whatever it
   produces — including "not measurable from this data", which is the expected result on a
   repository whose history is green.
2. **Exercise `sf testimpact deploy` and `--verify-coverage` against the same org**, from the
   published plugin's code path, and record the verbatim output next to the earlier
   user-testing findings.
3. **Push, and verify CI and the release workflow** on the real runners. Trusted Publishing
   itself needs a setting on npmjs.com that only the package owner can make; this change
   gets everything to the point where that one setting is all that is left.

## Non-goals

- Changing selection behaviour or defaults. A measurement is not a licence to tune.
- Quoting a rate the data does not support. The harness withholds it below 30 pairs and
  this change does not override that.
- Finding a window with real regressions. No public repository has one (task 1.3 of the
  previous change); that remains open and is stated as such.

## Impact

- New artifacts under `docs/measurements/`: the observation store, the scored report, the
  harness transcript, and the live `deploy` output.
- README: the status paragraph, the correctness section and the "never run against a live
  org" gap are rewritten to say what was actually run.
- `docs/USER-TESTING.md` gains the `deploy` findings it said were missing.
- Requires: the `fn-run` scratch org (created from the `partner-pbo` Dev Hub for this change,
  7-day expiry). No credential is written anywhere in the repository.
