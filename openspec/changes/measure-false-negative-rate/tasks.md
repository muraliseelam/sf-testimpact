# Tasks

Tasks 2–4 are offline and testable with no org. Task 5 requires credentials and is the only
one that cannot proceed without them.

## 1. Select the measurement window

- [x] 1.1 Identify a public Salesforce repository whose git history contains **real Apex test
      failures**. Verify the failures exist before selecting it; `apex-recipes` is measured at
      a 100% pass rate and cannot supply a numerator.
- [x] 1.2 Record the repository, base SHA, head SHA and commit count in
      `docs/measurements/fn-window.json`.
- [x] 1.3 If no suitable public repository is found, record that finding and stop. Do not
      substitute a synthetic window without labelling it as synthetic.

## 2. Observation store

- [x] 2.1 Add `src/bench/observationStore.ts` persisting per-commit, per-test outcomes to
      newline-delimited JSON, appended after each commit.
- [x] 2.2 Record window identity (repo, base SHA, head SHA, commit count) in the store header.
- [x] 2.3 Refuse to run when the requested window does not match the stored one; report the
      mismatch.
- [x] 2.4 Support resume: on startup, report which commits are already recorded.
- [x] 2.5 Unit tests: append, resume, window mismatch, and a truncated final line (interrupted
      mid-write) treated as absent rather than corrupting the store.

## 3. Org execution driver

- [x] 3.1 Add `src/bench/execute.ts` exposing a driver that takes a commit window, a deploy
      function and a test-run function, all injected.
- [x] 3.2 For each commit: reconstruct the tree via the existing `measure.mjs` replay, deploy,
      run the **full** suite, parse via `sfJsonAdapter`, persist.
- [x] 3.3 On deploy or run failure, record the commit as excluded with its reason and continue.
- [x] 3.4 Re-run failed tests at the same commit; mark flaky any test that then passes.
- [x] 3.5 Never write credentials to any artifact or log.
- [x] 3.6 Unit tests with injected fakes — no org required — covering: a clean commit, a
      commit with failures, a deploy failure, a flaky test, and resume after interruption.

## 4. Wire to the scorer and report

- [ ] 4.1 Feed stored observations to the existing `falseNegatives.ts`. Do not modify it.
- [ ] 4.2 Emit a report carrying false-negative count, denominator, fallback rate, reduction,
      flaky count, excluded commits with reasons, and a per-policy breakdown.
- [ ] 4.3 Suppress the rate and emit raw counts plus "not measurable from this data" when the
      denominator is below 30.
- [ ] 4.4 Unit tests for both the sufficient and insufficient denominator paths.

## 5. Execute (requires org credentials)

- [ ] 5.1 Authenticate a Dev Hub and confirm scratch-org creation.
- [ ] 5.2 Run the harness across the window, in batches if org limits require.
- [ ] 5.3 Write the result to `docs/measurements/false-negative-rate.json`.
- [ ] 5.4 Update the README's "Correctness: still unmeasured" section with the measured
      result — or, if the denominator is insufficient, with the null finding stated plainly.

## 6. Validation

- [ ] 6.1 `npm run check` passes with all new tests.
- [ ] 6.2 No credential appears in any file under `docs/measurements/`.
- [ ] 6.3 Every number added to the README traces to `docs/measurements/false-negative-rate.json`,
      per the evidence rule recorded in `docs/AUDIT.md`.
