# Measure the false-negative rate

## Why

`sf-testimpact` decides which Apex tests to skip. Its headline safety property — that it
never omits a test that would have caught a regression — has never been measured. The README
states this plainly, and until a number exists every reduction figure the project publishes
is a claim about speed only.

Stages 1, 2 and 4 of the measurement harness already exist and are tested. Only **Stage 3,
executing the suite against a real org**, is missing. This change builds it.

## What changes

Add an org-execution stage that, for each commit in a window, deploys the tree and runs the
**full** Apex suite, recording per-test outcomes to a resumable store. Feed those outcomes to
the existing scorer to produce the first false-negative measurement.

The full suite is required, not the selection. The metric asks what *would* have failed,
including tests the tool chose to skip — running only the selection cannot observe a false
negative by construction.

## Non-goals

- Changing selection behaviour. This change measures; it does not alter `analyze`.
- Changing the shipped default (`entryPointPolicy: full`).
- Publishing a rate. Producing the harness and running it are separate acts; a number is
  reported only if the denominator supports one (see the spec's reporting requirement).
- Any claim about the result. If the window yields too few failures, "not measurable from
  this data" is the correct and acceptable output.

## Impact

- New: `src/bench/execute.ts` (org execution driver), `src/bench/observationStore.ts`
  (resumable persistence)
- Uses existing: `src/bench/falseNegatives.ts`, `src/query/analyze.ts`,
  `docs/measurements/measure.mjs`, the `sfJson` / `junitXml` / `sfHuman` adapters
- Requires: a Salesforce Dev Hub with scratch-org creation enabled. The repository owner
  supplies credentials; they are never committed.
