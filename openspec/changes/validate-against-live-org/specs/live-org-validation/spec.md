# Live-org validation

## ADDED Requirements

### Requirement: Every org-touching path has run against an org before it is described as working

The README SHALL NOT describe `deploy`, `deploy --verify-coverage` or the execution harness
as working, or quote any figure from them, unless a retained artifact in
`docs/measurements/` or `docs/USER-TESTING.md` records a run against a real org that
produced it.

#### Scenario: A path has only been exercised against mocks

- **WHEN** a command or harness stage has run only against fakes
- **THEN** the README says so in the status section and in the relevant limitation
- **AND** no output from it is presented as observed

#### Scenario: A path has run against an org

- **WHEN** a run against an org has been performed
- **THEN** its verbatim output is retained, with instance URLs and tokens redacted
- **AND** the README cites that artifact wherever it describes the behaviour

### Requirement: A null measurement is reported as a result, not softened or omitted

When the harness produces fewer newly-failing pairs than the reporting threshold, the
README SHALL state the raw counts and "not measurable from this data", and SHALL still
report the fallback rate and reduction observed on real outcomes.

#### Scenario: Green window

- **WHEN** the window yields zero newly-failing pairs
- **THEN** the README reports zero pairs, the commits executed and excluded, and the
  per-policy fallback and reduction
- **AND** does not describe the tool as validated correct on that basis
