# Correctness measurement

## ADDED Requirements

### Requirement: Full-suite execution against an org

The harness SHALL execute the complete Apex test suite at each commit in the window, not the
selected subset, and SHALL record a per-test outcome for every test the org reports.

Recording only the selected subset makes a false negative unobservable by construction: the
metric is defined over tests the selector chose to skip.

#### Scenario: Recording outcomes at a commit

- **WHEN** the harness processes commit `c`
- **THEN** it deploys the tree at `c` to the org
- **AND** runs the full suite
- **AND** records for each test its name, outcome (`pass` / `fail` / `skip`), and duration
- **AND** persists the record before advancing to the next commit

#### Scenario: Deploy fails at a commit

- **WHEN** deployment or the test run fails at commit `c` for an infrastructural reason
- **THEN** the harness records `c` as excluded with the reason
- **AND** continues to the next commit
- **AND** the excluded commit is reported in the output, never silently dropped

### Requirement: Resumable execution

The harness SHALL persist outcomes incrementally so that an interrupted run resumes from the
last completed commit rather than restarting.

A window of ~200 commits, each requiring a deploy and full suite run, is measured in hours.
A run that loses all progress on interruption cannot be completed in practice.

#### Scenario: Resuming after interruption

- **WHEN** a run is interrupted after completing 40 of 200 commits
- **AND** the harness is restarted with the same window and store
- **THEN** it skips the 40 commits already recorded
- **AND** resumes at commit 41

#### Scenario: Store disagrees with the requested window

- **WHEN** the store contains outcomes recorded for a different commit window
- **THEN** the harness refuses to run and reports the mismatch
- **AND** does not merge outcomes from different windows into one result

### Requirement: Flaky-test identification

The harness SHALL identify tests whose outcome is not reproducible at the same commit, and
SHALL exclude them from both the numerator and denominator of the false-negative rate while
reporting their count separately.

A test that fails intermittently would otherwise be counted as a regression the selector
missed, inflating the false-negative rate with noise.

#### Scenario: A test flips outcome at one commit

- **WHEN** a test both passes and fails across repeated runs at the same commit
- **THEN** it is marked flaky at that commit
- **AND** excluded from the numerator and denominator
- **AND** counted in the reported flaky bucket

### Requirement: Honest reporting of the result

The harness SHALL report the false-negative count, the denominator, the fallback rate, the
reduction, the flaky count, the excluded commits, and a per-policy breakdown together as one
result. It SHALL NOT report a rate when the denominator is below the threshold at which the
rate is meaningful.

A rate quoted over three newly-failing pairs is not a measurement, and a selector that always
falls back scores a perfect zero while delivering nothing. The figures are only interpretable
together.

#### Scenario: Denominator too small to support a rate

- **WHEN** the window yields fewer than 30 newly-failing `(test, commit)` pairs
- **THEN** the harness reports the raw counts
- **AND** states that the rate is not measurable from this data
- **AND** does not emit a percentage

#### Scenario: Sufficient denominator

- **WHEN** the window yields at least 30 newly-failing pairs
- **THEN** the harness reports the rate alongside the denominator, fallback rate, reduction,
  flaky count and excluded commits
- **AND** reports each `entryPointPolicy` separately

### Requirement: Credentials are never committed

The harness SHALL read org credentials from the environment or the `sf` CLI's own
authenticated state, and SHALL NOT write them to any file in the repository, including
measurement artifacts and logs.

#### Scenario: Writing a measurement artifact

- **WHEN** the harness writes results to `docs/measurements/`
- **THEN** the artifact contains commit SHAs, test names and outcomes
- **AND** contains no org username, instance URL, access token or refresh token
