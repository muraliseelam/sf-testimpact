# Documentation

## Requirements

### Requirement: Every configuration key does what the reference says

The configuration reference SHALL describe each key's effect as implemented, and no key that
the configuration loader accepts SHALL be without effect.

#### Scenario: A safety setting is set to its conservative value

- **WHEN** a user sets `taint.dynamicApex`, `taint.dynamicSoql`, `taint.onParseError` or
  `taint.unmodelledFileType` to `full`
- **THEN** the condition it governs produces a `FALLBACK` decision naming the rule

#### Scenario: A setting reduces safety

- **WHEN** a setting causes a change to be ignored rather than analysed
- **THEN** a decision is printed naming the setting and the file, so the reduction is never
  silent

### Requirement: The command reference is generated from the commands

The command reference SHALL be generated from the command definitions, and CI SHALL fail when
the committed reference differs from what the current code generates.

#### Scenario: A flag is added without regenerating the reference

- **WHEN** a command's flags, description or examples change
- **AND** `docs/commands.md` is not regenerated
- **THEN** CI fails on the documentation check

### Requirement: Every rule and error code in the output is documented

Every decision rule identifier and every error code the code can emit SHALL have an entry in
`docs/rules.md` stating what triggers it, what it means and what to do.

#### Scenario: A user reads a FALLBACK line

- **WHEN** `analyze` prints a decision with rule `R`
- **THEN** `docs/rules.md` has an entry for `R`

### Requirement: Quoted output is real

Command output quoted in the documentation SHALL come from a real run of the documented
version, not be written from what the code is expected to print.

#### Scenario: A page quotes what a command prints

- **WHEN** the README or a page in `docs/` quotes command output
- **THEN** a transcript in `docs/measurements/` holds that output from a real run, with the
  script that produced it, and the page links to it

### Requirement: Every relative link in the documentation resolves

No Markdown file in the repository SHALL link to a relative path that does not exist, or to
an anchor that no heading in the target produces, and the test suite SHALL fail when one is
introduced.

#### Scenario: A linked heading is renamed

- **WHEN** a heading that another page links to is renamed
- **THEN** the test suite fails, naming the file, the line and the missing anchor
