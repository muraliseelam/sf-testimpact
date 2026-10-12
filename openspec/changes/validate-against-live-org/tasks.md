# Tasks

## 1. Org and window

- [x] 1.1 Create a scratch org from apex-recipes' `config/project-scratch-def.json` on the
      authenticated Dev Hub (`fn-run`, 7-day expiry).
- [x] 1.2 Add `--only-source-changes` to `bench/execute.js` and record why it is exact.
- [x] 1.3 Choose the window: 30 source-changing first-parent commits ending at `87c1c9b`,
      base `9802930d`. Confirm with `--dry-run`.

## 2. Execute the harness

- [ ] 2.1 Run `bench/execute.js` against `fn-run`; store at
      `docs/measurements/fn-observations.ndjson`.
- [ ] 2.2 Score with `bench/fn-report.js`; write
      `docs/measurements/false-negative-rate.json`.
- [ ] 2.3 Retain the run transcript, with every instance URL and token redacted, at
      `docs/measurements/fn-harness-run.txt`.
- [ ] 2.4 Record anything the live run revealed about the driver or the adapter, fix it,
      and say so.

## 3. Validate `deploy` against the org

- [ ] 3.1 `sf testimpact index` and `deploy --dry-run` on the tree the harness leaves behind.
- [ ] 3.2 `deploy --verify-coverage --target-org fn-run`; record the verbatim output.
- [ ] 3.3 A real `deploy` of a one-class change with `RunSpecifiedTests`.
- [ ] 3.4 Add the findings to `docs/USER-TESTING.md`.

## 4. Documentation

- [ ] 4.1 README: status, "Correctness: still unmeasured" (renamed if a measurement
      exists), the "never run against a live org" gap.
- [ ] 4.2 `docs/CORRECTNESS-PLAN.md` §8: what the live run showed.
- [ ] 4.3 Close the `measure-false-negative-rate` change: tasks 5.1–5.4 and archive.

## 5. Ship

- [ ] 5.1 `npm run check`, `npm pack --dry-run`.
- [ ] 5.2 Push; confirm the CI workflow passes on the runners.
- [ ] 5.3 Confirm the Release workflow's outcome and state what remains for the owner.
