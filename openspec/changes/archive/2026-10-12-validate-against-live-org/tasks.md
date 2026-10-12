# Tasks

## 1. Org and window

- [x] 1.1 Create a scratch org from apex-recipes' `config/project-scratch-def.json` on the
      authenticated Dev Hub (`fn-run`, 7-day expiry).
- [x] 1.2 Add `--only-source-changes` to `bench/execute.js` and record why it is exact.
- [x] 1.3 Choose the window: 30 source-changing first-parent commits ending at `87c1c9b`,
      base `9802930d`. Confirm with `--dry-run`.

## 2. Execute the harness

- [x] 2.1 Run `bench/execute.js` against `fn-run`; store at
      `docs/measurements/fn-observations.ndjson`. Done, finished on `fn-run-2` after the
      first org's daily test limit was exhausted.
- [x] 2.2 Score with `bench/fn-report.js`; write
      `docs/measurements/false-negative-rate.json`. Done.
- [x] 2.3 Retain the run transcript, with every instance URL and token redacted, at
      `docs/measurements/fn-harness-run.txt`. Done.
- [x] 2.4 Record anything the live run revealed about the driver or the adapter, fix it,
      and say so. Four findings, each fixed and written up in `docs/CORRECTNESS-PLAN.md`
      §8.3–8.4: DataWeave must deploy before the Apex that uses it (`--pre-deploy-dir`); a
      case-only rename stops tracked deploys (`--deploy-mode source-dir` for the range, with
      the exactness check); `sf apex run test` can fail before enqueuing (`testRunAttempts`);
      `DailyAsyncApexTests` bounds a window at about 20 full suites per org
      (`--retry-excluded` to continue in a fresh org).

## 3. Validate `deploy` against the org

- [x] 3.1 `sf testimpact index` and `deploy --dry-run` on the tree the harness leaves behind.
      Done (D0).
- [x] 3.2 `deploy --verify-coverage --target-org fn-run`; record the verbatim output. Done on
      `fn-run-2`: it had never worked (D1), and its marker matched a comment (D2). Both fixed.
- [x] 3.3 A real `deploy` of a one-class change with `RunSpecifiedTests`. Done (D6): 29 test
      classes, 162 methods, blocked by one genuinely failing test. On the way: flag
      passthrough was broken twice over (D3) and Windows split a path with a space (D4).
- [x] 3.4 Add the findings to `docs/USER-TESTING.md`. Done, "Live org (2026-10-12)".

## 4. Documentation

- [x] 4.1 README: status, "Correctness: still unmeasured" (renamed if a measurement
      exists), the "never run against a live org" gap. Done; the section is now
      "Correctness: measured once, not yet measurable".
- [x] 4.2 `docs/CORRECTNESS-PLAN.md` §8: what the live run showed. Done, §8.3–8.5.
- [x] 4.3 Close the `measure-false-negative-rate` change: tasks 5.1–5.4 and archive. Done;
      its spec is promoted to `openspec/specs/correctness-measurement/`.

## 5. Ship

- [x] 5.1 `npm run check`, `npm pack --dry-run`. Done: 793 tests, 78 files in the tarball.
- [x] 5.2 Push; confirm the CI workflow passes on the runners. Done: run 38324482527,
      Node 22.13 and 24, success.
- [x] 5.3 Confirm the Release workflow's outcome and state what remains for the owner. Done:
      run 38324482491 behaved as RELEASING.md describes — the OIDC exchange returned
      "404 package not found" because no Trusted Publisher is configured on npmjs.com, the
      token fallback computed the next version as 1.3.0 and failed at `npm publish` with
      EOTP. What remains is the one npmjs.com setting, then a re-run of the Release workflow.
